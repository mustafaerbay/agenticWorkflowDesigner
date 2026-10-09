import os
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.llm_client import LLMClient, LLMError
from app.agents.presets import preset_list
from app.api.deps import audit, current_user, require_admin, require_writer
from app.api.routes_workflows import count_workflows
from app.core.db import get_session
from app.core.security import create_access_token, verify_password
from app.models import Agent, AgentVersion, Approval, ModelProvider, User, Workflow, WorkflowRun, utcnow
from app.schemas import (
    AgentIn,
    AgentOut,
    LoginIn,
    ProviderIn,
    ProviderOut,
    ProviderTestOut,
    StatsOut,
    TokenOut,
    UserOut,
)
from app.services.serializers import run_summary
from app.tools.registry import tool_catalog

router = APIRouter()


def user_out(user: User) -> dict[str, Any]:
    return {"id": str(user.id), "email": user.email, "name": user.name, "role": user.role}


@router.get("/api/health", tags=["health"])
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/api/ready", tags=["health"])
async def ready(request: Request, session: AsyncSession = Depends(get_session)) -> JSONResponse:
    checks = {"database": False, "redis": False, "rabbitmq": False}
    try:
        await session.execute(text("SELECT 1"))
        checks["database"] = True
    except Exception:
        pass
    bus = request.app.state.bus
    try:
        checks["redis"] = bool(await bus.redis.ping())
    except Exception:
        pass
    try:
        await bus.connect()
        checks["rabbitmq"] = bus.connection is not None and not bus.connection.is_closed
    except Exception:
        pass
    ok = all(checks.values())
    return JSONResponse({"status": "ready" if ok else "not_ready", "checks": checks}, status_code=200 if ok else 503)


@router.post("/api/auth/login", response_model=TokenOut, tags=["auth"])
async def login(body: LoginIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    user = (await session.execute(select(User).where(func.lower(User.email) == body.email.lower()))).scalar_one_or_none()
    if user is None or not user.is_active or not verify_password(body.password, user.password_hash):
        audit(session, None, "auth.login_failed", "user", None, {"email": body.email[:320]})
        await session.commit()
        raise HTTPException(status_code=401, detail="Invalid email or password")
    audit(session, user, "auth.login", "user", user.id)
    await session.commit()
    return {"access_token": create_access_token(str(user.id), user.role), "token_type": "bearer", "user": user_out(user)}


@router.get("/api/auth/me", response_model=UserOut, tags=["auth"])
async def me(user: User = Depends(current_user)) -> dict[str, Any]:
    return user_out(user)


# -- agents -----------------------------------------------------------------------

async def agent_out(session: AsyncSession, agent: Agent) -> dict[str, Any]:
    version = (await session.execute(
        select(AgentVersion).where(AgentVersion.agent_id == agent.id, AgentVersion.version == agent.current_version)
    )).scalar_one()
    return {"id": str(agent.id), "name": agent.name, "description": agent.description, "kind": agent.kind,
            "preset": agent.preset, "config": version.config, "version": agent.current_version,
            "created_at": agent.created_at, "updated_at": agent.updated_at}


def _check_agent_config(body: AgentIn) -> None:
    tools = body.config.get("tools") or []
    catalog = tool_catalog()
    unknown = [t for t in tools if t not in catalog]
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown tools: {unknown}")
    if "api_key" in body.config:
        raise HTTPException(status_code=422, detail="Secrets cannot be stored in agent config; use a provider api_key_ref")


@router.get("/api/agents/presets", tags=["agents"])
async def presets(user: User = Depends(current_user)) -> list[dict[str, Any]]:
    return preset_list()


@router.get("/api/agents", response_model=list[AgentOut], tags=["agents"])
async def list_agents(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    agents = (await session.execute(select(Agent).where(Agent.deleted_at.is_(None)).order_by(Agent.name))).scalars().all()
    return [await agent_out(session, a) for a in agents]


@router.post("/api/agents", response_model=AgentOut, status_code=201, tags=["agents"])
async def create_agent(body: AgentIn, user: User = Depends(require_writer), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    _check_agent_config(body)
    agent = Agent(id=uuid.uuid4(), name=body.name, description=body.description, kind=body.kind,
                  preset=body.preset, current_version=1, owner_id=user.id)
    session.add(agent)
    await session.flush()
    session.add(AgentVersion(agent_id=agent.id, version=1, config=body.config))
    audit(session, user, "agent.create", "agent", agent.id)
    await session.commit()
    return await agent_out(session, agent)


async def _load_agent(session: AsyncSession, agent_id: uuid.UUID) -> Agent:
    agent = await session.get(Agent, agent_id)
    if agent is None or agent.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.get("/api/agents/{agent_id}", response_model=AgentOut, tags=["agents"])
async def get_agent(agent_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await agent_out(session, await _load_agent(session, agent_id))


@router.put("/api/agents/{agent_id}", response_model=AgentOut, tags=["agents"])
async def update_agent(agent_id: uuid.UUID, body: AgentIn, user: User = Depends(require_writer),
                       session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    _check_agent_config(body)
    agent = await _load_agent(session, agent_id)
    if user.role != "admin" and agent.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Only the owner or an admin can modify this agent")
    agent.name, agent.description, agent.kind, agent.preset = body.name, body.description, body.kind, body.preset
    agent.current_version += 1
    agent.updated_at = utcnow()
    session.add(AgentVersion(agent_id=agent.id, version=agent.current_version, config=body.config))
    audit(session, user, "agent.update", "agent", agent.id, {"version": agent.current_version})
    await session.commit()
    return await agent_out(session, agent)


@router.delete("/api/agents/{agent_id}", status_code=204, tags=["agents"])
async def delete_agent(agent_id: uuid.UUID, user: User = Depends(require_writer), session: AsyncSession = Depends(get_session)) -> Response:
    agent = await _load_agent(session, agent_id)
    if user.role != "admin" and agent.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Only the owner or an admin can delete this agent")
    agent.deleted_at = utcnow()
    audit(session, user, "agent.delete", "agent", agent.id)
    await session.commit()
    return Response(status_code=204)


# -- model providers ----------------------------------------------------------------

def provider_out(p: ModelProvider) -> dict[str, Any]:
    return {"id": str(p.id), "name": p.name, "base_url": p.base_url, "default_model": p.default_model,
            "api_key_ref": p.api_key_ref, "timeout_seconds": p.timeout_seconds, "temperature": p.temperature,
            "max_tokens": p.max_tokens, "created_at": p.created_at,
            "api_key_configured": bool(p.api_key_ref and os.environ.get(p.api_key_ref))}


@router.get("/api/model-providers", response_model=list[ProviderOut], tags=["models"])
async def list_providers(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    return [provider_out(p) for p in (await session.execute(select(ModelProvider).order_by(ModelProvider.created_at))).scalars()]


@router.post("/api/model-providers", response_model=ProviderOut, status_code=201, tags=["models"])
async def create_provider(body: ProviderIn, user: User = Depends(require_admin), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    provider = ModelProvider(id=uuid.uuid4(), **body.model_dump())
    session.add(provider)
    audit(session, user, "provider.create", "model_provider", provider.id)
    try:
        await session.commit()
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="A provider with this name already exists") from exc
    return provider_out(provider)


async def _load_provider(session: AsyncSession, provider_id: uuid.UUID) -> ModelProvider:
    provider = await session.get(ModelProvider, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="Provider not found")
    return provider


@router.get("/api/model-providers/{provider_id}", response_model=ProviderOut, tags=["models"])
async def get_provider(provider_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return provider_out(await _load_provider(session, provider_id))


@router.put("/api/model-providers/{provider_id}", response_model=ProviderOut, tags=["models"])
async def update_provider(provider_id: uuid.UUID, body: ProviderIn, user: User = Depends(require_admin),
                          session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    provider = await _load_provider(session, provider_id)
    for key, value in body.model_dump().items():
        setattr(provider, key, value)
    audit(session, user, "provider.update", "model_provider", provider.id)
    await session.commit()
    return provider_out(provider)


@router.delete("/api/model-providers/{provider_id}", status_code=204, tags=["models"])
async def delete_provider(provider_id: uuid.UUID, user: User = Depends(require_admin), session: AsyncSession = Depends(get_session)) -> Response:
    provider = await _load_provider(session, provider_id)
    await session.delete(provider)
    audit(session, user, "provider.delete", "model_provider", provider_id)
    await session.commit()
    return Response(status_code=204)


@router.post("/api/model-providers/{provider_id}/test", response_model=ProviderTestOut, tags=["models"])
async def test_provider(provider_id: uuid.UUID, user: User = Depends(require_writer), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    provider = await _load_provider(session, provider_id)
    client = LLMClient(provider.base_url, provider.default_model, provider.api_key_ref, provider.timeout_seconds)
    try:
        models = await client.list_models()
    except LLMError as exc:
        return {"ok": False, "detail": str(exc), "models": []}
    found = provider.default_model in models
    detail = f"Reachable; {len(models)} model(s) listed" + ("" if found or not models else f"; '{provider.default_model}' not listed")
    return {"ok": True, "detail": detail, "models": models[:100]}


# -- tools / stats ---------------------------------------------------------------------

@router.get("/api/tools", tags=["tools"])
async def tools(user: User = Depends(current_user)) -> list[dict[str, Any]]:
    return list(tool_catalog().values())


@router.get("/api/stats", response_model=StatsOut, tags=["stats"])
async def stats(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    run_filter = []
    if user.role != "admin":
        owned = select(Workflow.id).where(Workflow.owner_id == user.id)
        run_filter = [(WorkflowRun.created_by == user.id) | WorkflowRun.workflow_id.in_(owned)]
    by_status = dict((await session.execute(
        select(WorkflowRun.status, func.count()).where(*run_filter).group_by(WorkflowRun.status)
    )).all())
    recent = (await session.execute(
        select(WorkflowRun).where(*run_filter).order_by(WorkflowRun.created_at.desc()).limit(10)
    )).scalars().all()
    pending = (await session.execute(
        select(func.count()).select_from(Approval).join(WorkflowRun, WorkflowRun.id == Approval.run_id)
        .where(Approval.status == "pending", *run_filter)
    )).scalar_one()
    active = sum(by_status.get(s, 0) for s in ("PENDING", "RUNNING", "PAUSED", "WAITING_APPROVAL"))
    return {
        "workflows": await count_workflows(session, user),
        "runs_total": sum(by_status.values()),
        "runs_by_status": by_status,
        "active_runs": active,
        "pending_approvals": int(pending),
        "recent_runs": [run_summary(r) for r in recent],
    }
