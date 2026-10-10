"""Idempotent startup seeding: admin user, default model provider, tool catalog, examples."""

import logging
import uuid
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import hash_password
from app.models import Agent, AgentVersion, Department, ModelProvider, Tool, User, Workflow
from app.services.examples import EXAMPLES
from app.tools.registry import tool_catalog

log = logging.getLogger(__name__)
SEED_LOCK = 774_211
DEPARTMENTS = [("hr", "Human Resources", True), ("finance", "Finance", True), ("operations", "Operations", False),
               ("it", "IT", False), ("engineering", "Software Development", False)]


def agent_profiles() -> dict[str, dict[str, Any]]:
    """Registry metadata for built-in agents, derived from the capability registry."""
    from app.agents.presets import PRESETS
    from app.business.capabilities import CAPABILITIES

    profiles: dict[str, dict[str, Any]] = {}
    for cap in CAPABILITIES.values():
        if cap.implementation["kind"] != "agent":
            continue
        key = cap.implementation["agent"]
        p = profiles.setdefault(key, {"capabilities": [], "departments": set(), "required_tools": set(),
                                      "input_schema": {}, "output_schema": {}})
        p["capabilities"].append(cap.id)
        p["departments"].update(cap.departments)
        p["required_tools"].update(cap.implementation["tools"])
        p["input_schema"][cap.id] = {"type": "object", "properties": {f.key: {"type": f.type} for f in cap.inputs}}
        p["output_schema"][cap.id] = cap.output_schema()
    out = {}
    for key, p in profiles.items():
        preset = PRESETS[key]
        out[key] = {
            "name": preset["name"], "description": preset["description"], "config": preset["config"],
            "profile": {
                "builtin": True, "business_description": preset["description"],
                "capabilities": sorted(p["capabilities"]),
                "departments": ["*"] if "*" in p["departments"] else sorted(p["departments"]),
                "required_tools": sorted(p["required_tools"] | set(preset["config"].get("tools") or [])),
                "input_schema": p["input_schema"], "output_schema": p["output_schema"],
                "config_requirements": ["An AI model provider (Model Settings)"],
                "constraints": {"timeout_seconds": preset["config"].get("timeout_seconds"),
                                "max_steps": preset["config"].get("max_steps"),
                                "untrusted_input": True},
            },
        }
    return out


async def seed_agent_registry(session: AsyncSession, admin: User) -> None:
    existing = {a.preset: a for a in (await session.execute(select(Agent).where(Agent.deleted_at.is_(None)))).scalars()
                if (a.profile or {}).get("builtin")}
    for key, spec in agent_profiles().items():
        agent = existing.get(key)
        if agent is None:
            agent = Agent(id=uuid.uuid4(), name=spec["name"], description=spec["description"], kind="llm", preset=key,
                          current_version=1, owner_id=admin.id, profile=spec["profile"])
            session.add(agent)
            await session.flush()
            session.add(AgentVersion(agent_id=agent.id, version=1, config=spec["config"]))
        else:
            agent.profile = spec["profile"]


async def seed(session: AsyncSession) -> None:
    settings = get_settings()
    await session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": SEED_LOCK})

    admin = (await session.execute(select(User).where(User.email == settings.admin_email))).scalar_one_or_none()
    if admin is None:
        if not settings.admin_password:
            log.error("ADMIN_PASSWORD is not set; no administrator account was created")
            await session.commit()
            return
        admin = User(id=uuid.uuid4(), email=settings.admin_email, name=settings.admin_name,
                     password_hash=hash_password(settings.admin_password), role="admin")
        session.add(admin)
        await session.flush()
        log.info("created administrator account", extra={"email": settings.admin_email})

    for code, name, sensitive in DEPARTMENTS:
        if await session.get(Department, code) is None:
            session.add(Department(code=code, name=name, sensitive=sensitive))

    await seed_agent_registry(session, admin)

    for name, spec in tool_catalog().items():
        tool = await session.get(Tool, name)
        if tool is None:
            session.add(Tool(name=name, description=spec["description"], parameters=spec["parameters"],
                             dangerous=spec["dangerous"]))
        else:
            tool.description, tool.parameters, tool.dangerous = spec["description"], spec["parameters"], spec["dangerous"]

    if settings.llm_base_url and settings.llm_model:
        existing = (await session.execute(select(ModelProvider).where(ModelProvider.name == "Default (environment)"))).scalar_one_or_none()
        if existing is None:
            session.add(ModelProvider(id=uuid.uuid4(), name="Default (environment)", base_url=settings.llm_base_url,
                                      default_model=settings.llm_model, api_key_ref=settings.llm_api_key_ref))
        else:
            existing.base_url, existing.default_model = settings.llm_base_url, settings.llm_model
            existing.api_key_ref = settings.llm_api_key_ref

    from app.api.routes_workflows import create_workflow  # local import avoids a cycle

    for example in EXAMPLES:
        found = (await session.execute(
            select(Workflow).where(Workflow.name == example["name"], Workflow.is_example.is_(True))
        )).scalar_one_or_none()
        if found is None:
            await create_workflow(session, admin, example["name"], example["description"], example["definition"], is_example=True)
            log.info("seeded example workflow", extra={"workflow": example["name"]})
    await session.commit()
