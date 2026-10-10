from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AgentArtifact, Approval, NodeRun, WorkflowRun


def run_summary(run: WorkflowRun) -> dict[str, Any]:
    return {
        "id": str(run.id),
        "mode": run.mode,
        "triggered_by": run.triggered_by,
        "department": run.department,
        "workflow_id": str(run.workflow_id),
        "workflow_name": run.workflow_name,
        "workflow_version": run.workflow_version,
        "status": run.status,
        "created_at": run.created_at,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "steps": run.steps,
        "error": run.error,
    }


def node_run_out(nr: NodeRun) -> dict[str, Any]:
    duration = None
    if nr.started_at and nr.finished_at:
        duration = int((nr.finished_at - nr.started_at).total_seconds() * 1000)
    return {
        "id": str(nr.id),
        "node_id": nr.node_id,
        "node_type": nr.node_type,
        "label": nr.label,
        "iteration": nr.iteration,
        "attempt": nr.attempt,
        "status": nr.status,
        "input": nr.input,
        "output": nr.output,
        "error": nr.error,
        "selected_handle": nr.selected_handle,
        "started_at": nr.started_at,
        "finished_at": nr.finished_at,
        "duration_ms": duration,
        "logs": nr.logs or [],
        "tool_calls": nr.tool_calls or [],
        "usage": nr.usage,
        "agent_kind": nr.agent_kind,
        "model": nr.model,
        "retryable": nr.retryable,
    }


async def run_out(session: AsyncSession, run: WorkflowRun) -> dict[str, Any]:
    node_runs = (await session.execute(
        select(NodeRun).where(NodeRun.run_id == run.id).order_by(NodeRun.created_at, NodeRun.attempt)
    )).scalars().all()
    artifacts = (await session.execute(
        select(AgentArtifact).where(AgentArtifact.run_id == run.id).order_by(AgentArtifact.created_at)
    )).scalars().all()
    return {
        **run_summary(run),
        "input": run.input or {},
        "output": run.output,
        "definition": run.definition,
        "node_runs": [node_run_out(nr) for nr in node_runs],
        "last_event_seq": run.event_seq,
        "artifacts": [
            {"id": str(a.id), "node_run_id": str(a.node_run_id) if a.node_run_id else None, "name": a.name,
             "kind": a.kind, "size_bytes": a.size_bytes, "sha256": a.sha256, "created_at": a.created_at}
            for a in artifacts
        ],
    }


def approval_out(approval: Approval, workflow_name: str, problem: str | None = None) -> dict[str, Any]:
    return {
        "department": approval.department,
        "required_role": approval.required_role,
        "separation_of_duties": approval.separation_of_duties,
        "can_decide": problem is None and approval.status == "pending",
        "reason_cannot_decide": problem,
        "id": str(approval.id),
        "run_id": str(approval.run_id),
        "node_id": approval.node_id,
        "workflow_name": workflow_name,
        "title": approval.title,
        "description": approval.description,
        "status": approval.status,
        "requested_at": approval.requested_at,
        "decided_at": approval.decided_at,
        "decided_by": str(approval.decided_by) if approval.decided_by else None,
        "comment": approval.comment,
    }
