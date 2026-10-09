"""Event recording. Every transaction that writes run data locks the run row first,
so the per-run sequence number increases in commit order."""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ExecutionEvent, WorkflowRun
from app.orchestration.bus import Bus


async def lock_run(session: AsyncSession, run_id: uuid.UUID | str) -> WorkflowRun | None:
    result = await session.execute(
        select(WorkflowRun)
        .where(WorkflowRun.id == uuid.UUID(str(run_id)))
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    return result.scalar_one_or_none()


def emit(
    session: AsyncSession,
    run: WorkflowRun,
    type_: str,
    node_id: str | None = None,
    node_run_id: uuid.UUID | None = None,
    data: dict[str, Any] | None = None,
) -> ExecutionEvent:
    run.event_seq = (run.event_seq or 0) + 1
    event = ExecutionEvent(
        run_id=run.id,
        seq=run.event_seq,
        type=type_,
        node_id=node_id,
        node_run_id=node_run_id,
        data=data or {},
    )
    session.add(event)
    session.info.setdefault("events", []).append(event)
    return event


def event_to_dict(event: ExecutionEvent) -> dict[str, Any]:
    return {
        "seq": event.seq,
        "run_id": str(event.run_id),
        "type": event.type,
        "node_id": event.node_id,
        "node_run_id": str(event.node_run_id) if event.node_run_id else None,
        "data": event.data,
        "created_at": event.created_at.isoformat() if event.created_at else None,
    }


async def commit_and_publish(session: AsyncSession, bus: Bus) -> None:
    """Commit, then push events, tasks and commands that were staged in the session."""
    events: list[ExecutionEvent] = session.info.pop("events", [])
    tasks: list[dict[str, Any]] = session.info.pop("tasks", [])
    commands: list[dict[str, Any]] = session.info.pop("commands", [])
    await session.commit()
    for event in events:
        await bus.publish_event(event_to_dict(event))
    for task in tasks:
        await bus.send_task(task)
    for command in commands:
        await bus.send_command(command)
