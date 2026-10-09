import asyncio
import contextlib
import json
import logging
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import audit, current_user, get_bus, load_run, user_from_token
from app.core.config import get_settings
from app.core.db import get_session, session_factory
from app.models import AgentArtifact, Approval, ExecutionEvent, User, Workflow, WorkflowRun, WorkflowVersion
from app.orchestration.bus import Bus, event_channel
from app.orchestration.engine import Engine
from app.orchestration.events import commit_and_publish, event_to_dict, lock_run
from app.schemas import ApprovalOut, DecisionIn, EventOut, RunOut, RunSummary
from app.services.execution import create_run
from app.services.serializers import approval_out, run_out, run_summary

log = logging.getLogger(__name__)
router = APIRouter(tags=["executions"])
engine = Engine()


@router.get("/api/executions", response_model=list[RunSummary])
async def list_runs(
    workflow_id: uuid.UUID | None = None, status: str | None = None, search: str | None = None,
    limit: int = Query(default=50, ge=1, le=500), user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    query = select(WorkflowRun).order_by(WorkflowRun.created_at.desc()).limit(limit)
    if user.role != "admin":
        owned = select(Workflow.id).where(Workflow.owner_id == user.id)
        query = query.where((WorkflowRun.created_by == user.id) | WorkflowRun.workflow_id.in_(owned))
    if workflow_id:
        query = query.where(WorkflowRun.workflow_id == workflow_id)
    if status:
        query = query.where(WorkflowRun.status == status.upper())
    if search:
        query = query.where(WorkflowRun.workflow_name.ilike(f"%{search}%"))
    return [run_summary(r) for r in (await session.execute(query)).scalars().all()]


@router.get("/api/executions/{run_id}", response_model=RunOut)
async def get_run(run_id: uuid.UUID, user: User = Depends(current_user),
                  session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await run_out(session, await load_run(session, run_id, user))


async def _control(run_id: uuid.UUID, user: User, session: AsyncSession, bus: Bus, action: str) -> dict[str, Any]:
    await load_run(session, run_id, user, write=True)
    run = await lock_run(session, run_id)
    assert run is not None
    if action == "pause":
        if not await engine.pause(session, run):
            raise HTTPException(status_code=409, detail=f"Cannot pause a run in state {run.status}")
    elif action == "resume":
        if not await engine.resume(session, run):
            raise HTTPException(status_code=409, detail=f"Cannot resume a run in state {run.status}")
    elif action == "cancel":
        if run.status in ("COMPLETED", "FAILED", "CANCELLED"):
            raise HTTPException(status_code=409, detail=f"Run already finished ({run.status})")
        await engine.cancel(session, run)
    audit(session, user, f"run.{action}", "workflow_run", run.id)
    await commit_and_publish(session, bus)
    return await run_out(session, run)


@router.post("/api/executions/{run_id}/pause", response_model=RunOut)
async def pause(run_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session),
                bus: Bus = Depends(get_bus)) -> dict[str, Any]:
    return await _control(run_id, user, session, bus, "pause")


@router.post("/api/executions/{run_id}/resume", response_model=RunOut)
async def resume(run_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session),
                 bus: Bus = Depends(get_bus)) -> dict[str, Any]:
    return await _control(run_id, user, session, bus, "resume")


@router.post("/api/executions/{run_id}/cancel", response_model=RunOut)
async def cancel(run_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session),
                 bus: Bus = Depends(get_bus)) -> dict[str, Any]:
    return await _control(run_id, user, session, bus, "cancel")


@router.post("/api/executions/{run_id}/retry", response_model=RunOut, status_code=201)
async def retry(run_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session),
                bus: Bus = Depends(get_bus)) -> dict[str, Any]:
    old = await load_run(session, run_id, user, write=True)
    workflow = await session.get(Workflow, old.workflow_id)
    version = await session.get(WorkflowVersion, old.workflow_version_id)
    assert workflow is not None and version is not None
    run = await create_run(session, workflow, version, dict(old.input or {}), user.id)
    audit(session, user, "run.retry", "workflow_run", run.id, {"retry_of": str(old.id)})
    await commit_and_publish(session, bus)
    return await run_out(session, run)


@router.get("/api/executions/{run_id}/events", response_model=list[EventOut])
async def events(run_id: uuid.UUID, after: int = 0, limit: int = Query(default=1000, ge=1, le=5000),
                 user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    await load_run(session, run_id, user)
    rows = (await session.execute(
        select(ExecutionEvent).where(ExecutionEvent.run_id == run_id, ExecutionEvent.seq > after)
        .order_by(ExecutionEvent.seq).limit(limit)
    )).scalars().all()
    return [event_to_dict(e) for e in rows]


@router.get("/api/artifacts/{artifact_id}/download")
async def download_artifact(artifact_id: uuid.UUID, user: User = Depends(current_user),
                            session: AsyncSession = Depends(get_session)) -> FileResponse:
    artifact = await session.get(AgentArtifact, artifact_id)
    if artifact is None:
        raise HTTPException(status_code=404, detail="Artifact not found")
    await load_run(session, artifact.run_id, user)
    root = Path(get_settings().artifacts_dir).resolve()
    path = Path(artifact.path).resolve()
    if root not in path.parents or not path.is_file():
        raise HTTPException(status_code=404, detail="Artifact file missing")
    return FileResponse(path, filename=artifact.name, media_type="text/plain")


@router.websocket("/api/executions/{run_id}/stream")
async def stream(websocket: WebSocket, run_id: uuid.UUID, token: str = "", after: int = 0) -> None:
    """Replay persisted events after `after`, then forward live events (deduplicated by seq)."""
    async with session_factory()() as session:
        try:
            user = await user_from_token(session, token)
            await load_run(session, run_id, user)
        except HTTPException:
            await websocket.close(code=4401)
            return
    await websocket.accept()
    bus = websocket.app.state.bus
    pubsub = bus.redis.pubsub()
    await pubsub.subscribe(event_channel(str(run_id)))
    last_seq = after

    async def send_event(event: dict[str, Any]) -> None:
        nonlocal last_seq
        if event["seq"] > last_seq:
            last_seq = event["seq"]
            await websocket.send_text(json.dumps({"type": "event", "event": event}, default=str))

    async def replay() -> None:
        async with session_factory()() as s:
            rows = (await s.execute(
                select(ExecutionEvent).where(ExecutionEvent.run_id == run_id, ExecutionEvent.seq > last_seq)
                .order_by(ExecutionEvent.seq)
            )).scalars().all()
        for row in rows:
            await send_event(event_to_dict(row))

    async def ping() -> None:
        while True:
            await asyncio.sleep(20)
            await websocket.send_text(json.dumps({"type": "ping"}))

    async def drain_client() -> None:
        while True:
            await websocket.receive_text()

    ping_task = asyncio.create_task(ping())
    client_task = asyncio.create_task(drain_client())
    try:
        await replay()
        while not client_task.done():
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if message and message.get("type") == "message":
                event = json.loads(message["data"])
                if event["seq"] > last_seq + 1:
                    await replay()  # gap: fill from the database, which is the source of truth
                else:
                    await send_event(event)
    except (WebSocketDisconnect, RuntimeError):
        pass
    except Exception:
        log.warning("websocket stream error", exc_info=True)
    finally:
        ping_task.cancel()
        client_task.cancel()
        with contextlib.suppress(Exception):
            await pubsub.unsubscribe()
            await pubsub.aclose()


@router.get("/api/approvals", response_model=list[ApprovalOut])
async def list_approvals(status: str | None = None, user: User = Depends(current_user),
                         session: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    query = (select(Approval, WorkflowRun.workflow_name)
             .join(WorkflowRun, WorkflowRun.id == Approval.run_id)
             .order_by(Approval.requested_at.desc()).limit(200))
    if status:
        query = query.where(Approval.status == status)
    if user.role != "admin":
        owned = select(Workflow.id).where(Workflow.owner_id == user.id)
        query = query.where((WorkflowRun.created_by == user.id) | WorkflowRun.workflow_id.in_(owned))
    return [approval_out(a, name) for a, name in (await session.execute(query)).all()]


@router.post("/api/approvals/{approval_id}/decision", response_model=ApprovalOut)
async def decide(approval_id: uuid.UUID, body: DecisionIn, user: User = Depends(current_user),
                 session: AsyncSession = Depends(get_session), bus: Bus = Depends(get_bus)) -> dict[str, Any]:
    approval = await session.get(Approval, approval_id)
    if approval is None:
        raise HTTPException(status_code=404, detail="Approval not found")
    await load_run(session, approval.run_id, user, write=True)
    if user.role not in ("admin", "editor"):
        raise HTTPException(status_code=403, detail="Not authorized to decide approvals")
    run = await lock_run(session, approval.run_id)
    approval = await session.get(Approval, approval_id, with_for_update=True, populate_existing=True)
    assert run is not None and approval is not None
    if approval.status != "pending":
        raise HTTPException(status_code=409, detail=f"Approval already {approval.status}")
    if run.status in ("COMPLETED", "FAILED", "CANCELLED"):
        raise HTTPException(status_code=409, detail=f"Run already finished ({run.status})")
    await engine.decide_approval(session, run, approval, body.decision == "approve", user.id, user.email, body.comment)
    audit(session, user, f"approval.{body.decision}", "approval", approval.id, {"run_id": str(run.id)})
    await commit_and_publish(session, bus)
    return approval_out(approval, run.workflow_name)
