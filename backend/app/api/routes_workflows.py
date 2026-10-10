import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import audit, current_user, get_bus, load_workflow, require_writer
from app.core import permissions
from app.core.db import get_session
from app.models import User, Workflow, WorkflowEdge, WorkflowNode, WorkflowRun, WorkflowVersion, utcnow
from app.orchestration.bus import Bus
from app.orchestration.events import commit_and_publish
from app.schemas import (
    ExecuteIn,
    RunOut,
    ValidateIn,
    WorkflowImport,
    WorkflowIn,
    WorkflowOut,
    WorkflowSummary,
    WorkflowUpdate,
)
from app.services.execution import create_run, get_validator
from app.services.serializers import run_out

router = APIRouter(prefix="/api/workflows", tags=["workflows"])
EXPORT_FORMAT = "agentic-sdlc/workflow@1"


async def current_definition(session: AsyncSession, workflow: Workflow) -> WorkflowVersion:
    return (await session.execute(
        select(WorkflowVersion).where(WorkflowVersion.workflow_id == workflow.id,
                                      WorkflowVersion.version == workflow.current_version)
    )).scalar_one()


async def add_version(session: AsyncSession, workflow: Workflow, version: int, definition: dict[str, Any], user: User) -> WorkflowVersion:
    if not isinstance(definition.get("nodes"), list) or not isinstance(definition.get("edges"), list):
        raise HTTPException(status_code=422, detail="definition requires 'nodes' and 'edges' lists")
    wv = WorkflowVersion(id=uuid.uuid4(), workflow_id=workflow.id, version=version, definition=definition, created_by=user.id)
    session.add(wv)
    await session.flush()
    seen_nodes: set[str] = set()
    for node in definition["nodes"]:
        if isinstance(node, dict) and isinstance(node.get("id"), str) and node["id"] not in seen_nodes:
            seen_nodes.add(node["id"])
            data = node.get("data") or {}
            session.add(WorkflowNode(workflow_version_id=wv.id, node_id=node["id"][:64], type=str(node.get("type"))[:32],
                                     label=str(data.get("label") or "")[:200], config=data.get("config") or {}))
    seen_edges: set[str] = set()
    for edge in definition["edges"]:
        if isinstance(edge, dict) and isinstance(edge.get("id"), str) and edge["id"] not in seen_edges:
            seen_edges.add(edge["id"])
            session.add(WorkflowEdge(workflow_version_id=wv.id, edge_id=edge["id"][:128], source=str(edge.get("source"))[:64],
                                     target=str(edge.get("target"))[:64], source_handle=str(edge.get("sourceHandle") or "out")[:64],
                                     target_handle=str(edge.get("targetHandle") or "in")[:64], label=edge.get("label")))
    return wv


async def last_run_status(session: AsyncSession, workflow_id: uuid.UUID) -> str | None:
    return (await session.execute(
        select(WorkflowRun.status).where(WorkflowRun.workflow_id == workflow_id)
        .order_by(WorkflowRun.created_at.desc()).limit(1)
    )).scalar_one_or_none()


async def to_out(session: AsyncSession, workflow: Workflow, full: bool = True, user: User | None = None) -> dict[str, Any]:
    version = await current_definition(session, workflow)
    meta = (version.definition or {}).get("meta") if version.plan is not None else None
    data: dict[str, Any] = {
        "id": str(workflow.id),
        "name": workflow.name,
        "description": workflow.description,
        "version": workflow.current_version,
        "created_at": workflow.created_at,
        "updated_at": workflow.updated_at,
        "node_count": len(version.definition.get("nodes") or []),
        "last_run_status": await last_run_status(session, workflow.id),
        "is_example": workflow.is_example,
        "department": workflow.department,
        "status": workflow.status,
        "enabled_version": workflow.enabled_version,
        "has_plan": version.plan is not None,
        "plan_meta": {k: meta.get(k) for k in ("compiler_version", "registry_version", "policy_version", "plan_hash")}
        if meta else None,
        "can_edit": permissions.can_edit_workflow(user, workflow) if user else None,
        "can_enable": permissions.can_enable_workflow(user, workflow) if user else None,
    }
    if full:
        data["definition"] = version.definition
        data["plan"] = version.plan
        data["explanation"] = None
        if version.plan is not None:
            from app.business.plan import BusinessPlan
            from app.business.service import evaluate, policy_context

            evaluation = evaluate(BusinessPlan.model_validate(version.plan), await policy_context(session, workflow.department))
            data["explanation"] = evaluation.explanation
    return data


async def create_workflow(session: AsyncSession, user: User, name: str, description: str,
                          definition: dict[str, Any], is_example: bool = False) -> Workflow:
    workflow = Workflow(id=uuid.uuid4(), name=name, description=description, owner_id=user.id,
                        current_version=1, is_example=is_example)
    session.add(workflow)
    await session.flush()
    await add_version(session, workflow, 1, definition, user)
    return workflow


@router.get("", response_model=list[WorkflowSummary])
async def list_workflows(search: str | None = None, user: User = Depends(current_user),
                         session: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    query = select(Workflow).where(Workflow.deleted_at.is_(None)).order_by(Workflow.updated_at.desc())
    if search:
        query = query.where(Workflow.name.ilike(f"%{search}%") | Workflow.description.ilike(f"%{search}%"))
    workflows = [w for w in (await session.execute(query)).scalars().all() if permissions.can_view_workflow(user, w)]
    return [await to_out(session, w, full=False, user=user) for w in workflows]


@router.post("", response_model=WorkflowOut, status_code=201)
async def create(body: WorkflowIn, user: User = Depends(require_writer),
                 session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    if not permissions.can_build_in(user, body.department):
        raise HTTPException(status_code=403, detail=f"You cannot build workflows for {body.department}")
    workflow = await create_workflow(session, user, body.name, body.description, body.definition)
    workflow.department = body.department
    audit(session, user, "workflow.create", "workflow", workflow.id)
    await session.commit()
    return await to_out(session, workflow, user=user)


@router.post("/validate")
async def validate_unsaved(body: ValidateIn, user: User = Depends(current_user)) -> dict[str, Any]:
    return get_validator().validate(body.definition).as_dict()


@router.post("/import", response_model=WorkflowOut, status_code=201)
async def import_workflow(body: WorkflowImport, user: User = Depends(require_writer),
                          session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    if body.format != EXPORT_FORMAT:
        raise HTTPException(status_code=422, detail=f"Unsupported format; expected {EXPORT_FORMAT}")
    workflow = await create_workflow(session, user, body.name, body.description, body.definition)
    audit(session, user, "workflow.import", "workflow", workflow.id)
    await session.commit()
    return await to_out(session, workflow, user=user)


@router.get("/{workflow_id}", response_model=WorkflowOut)
async def get_workflow(workflow_id: uuid.UUID, user: User = Depends(current_user),
                       session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await to_out(session, await load_workflow(session, workflow_id, user), user=user)


@router.put("/{workflow_id}", response_model=WorkflowOut)
async def update_workflow(workflow_id: uuid.UUID, body: WorkflowUpdate, user: User = Depends(require_writer),
                          session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    workflow = await load_workflow(session, workflow_id, user, write=True)
    workflow = (await session.execute(select(Workflow).where(Workflow.id == workflow.id).with_for_update())).scalar_one()
    if body.name is not None:
        workflow.name = body.name
    if body.description is not None:
        workflow.description = body.description
    if body.definition is not None:
        current = await current_definition(session, workflow)
        if current.plan is not None:
            await _apply_visual_edit(session, workflow, current, body.definition, user)
        elif current.definition != body.definition:
            workflow.current_version += 1
            await add_version(session, workflow, workflow.current_version, body.definition, user)
    workflow.updated_at = utcnow()
    audit(session, user, "workflow.update", "workflow", workflow.id, {"version": workflow.current_version})
    await session.commit()
    return await to_out(session, workflow, user=user)


async def _apply_visual_edit(session: AsyncSession, workflow: Workflow, current: WorkflowVersion,
                             definition: dict[str, Any], user: User) -> None:
    """Advanced-editor save of a plan-based workflow: translate graph edits into plan operations."""
    from app.business.graph_edit import graph_to_operations
    from app.business.operations import OperationError
    from app.business.plan import BusinessPlan
    from app.business.service import policy_context, preview_operations, save_plan_version

    plan = BusinessPlan.model_validate(current.plan)
    operations, unsupported = graph_to_operations(plan, definition)
    if unsupported:
        raise HTTPException(status_code=422, detail={
            "message": "Some changes cannot be represented in this business workflow. Nothing was saved.",
            "unsupported": [u.as_dict() for u in unsupported],
            "operations": [o.model_dump() for o in operations]})
    if not operations:
        return
    try:
        evaluation = preview_operations(plan, operations, await policy_context(session, workflow.department))
        await save_plan_version(session, workflow, evaluation, user, "Edited in the advanced editor")
    except OperationError as exc:
        raise HTTPException(status_code=422, detail={"message": str(exc), "unsupported": [{"message": str(exc)}],
                                                     "operations": [o.model_dump() for o in operations]}) from exc


@router.delete("/{workflow_id}", status_code=204)
async def delete_workflow(workflow_id: uuid.UUID, user: User = Depends(require_writer),
                          session: AsyncSession = Depends(get_session)) -> Response:
    workflow = await load_workflow(session, workflow_id, user, write=True)
    workflow.deleted_at = utcnow()  # soft delete keeps execution history intact
    audit(session, user, "workflow.delete", "workflow", workflow.id)
    await session.commit()
    return Response(status_code=204)


@router.post("/{workflow_id}/validate")
async def validate_saved(workflow_id: uuid.UUID, user: User = Depends(current_user),
                         session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    workflow = await load_workflow(session, workflow_id, user)
    version = await current_definition(session, workflow)
    return get_validator().validate(version.definition).as_dict()


@router.post("/{workflow_id}/duplicate", response_model=WorkflowOut, status_code=201)
async def duplicate(workflow_id: uuid.UUID, user: User = Depends(require_writer),
                    session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    source = await load_workflow(session, workflow_id, user)
    version = await current_definition(session, source)
    copy = await create_workflow(session, user, f"{source.name} (copy)", source.description, version.definition)
    copy.department = source.department
    if version.plan is not None:
        copy.status = "draft"
        copy_version = await current_definition(session, copy)
        copy_version.plan = version.plan
    audit(session, user, "workflow.duplicate", "workflow", copy.id, {"source": str(source.id)})
    await session.commit()
    return await to_out(session, copy, user=user)


@router.get("/{workflow_id}/export")
async def export(workflow_id: uuid.UUID, user: User = Depends(current_user),
                 session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    workflow = await load_workflow(session, workflow_id, user)
    version = await current_definition(session, workflow)
    return {"format": EXPORT_FORMAT, "name": workflow.name, "description": workflow.description,
            "definition": version.definition}


@router.get("/{workflow_id}/versions")
async def versions(workflow_id: uuid.UUID, user: User = Depends(current_user),
                   session: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    workflow = await load_workflow(session, workflow_id, user)
    rows = (await session.execute(
        select(WorkflowVersion).where(WorkflowVersion.workflow_id == workflow.id).order_by(WorkflowVersion.version.desc())
    )).scalars().all()
    return [{"version": v.version, "created_at": v.created_at, "created_by": str(v.created_by) if v.created_by else None}
            for v in rows]


@router.post("/{workflow_id}/execute", response_model=RunOut, status_code=201)
async def execute(workflow_id: uuid.UUID, body: ExecuteIn | None = None, user: User = Depends(require_writer),
                  session: AsyncSession = Depends(get_session), bus: Bus = Depends(get_bus)) -> dict[str, Any]:
    workflow = await load_workflow(session, workflow_id, user)
    if not permissions.can_run_workflow(user, workflow):
        raise HTTPException(status_code=403, detail="You are not allowed to run this workflow")
    version = await current_definition(session, workflow)
    run_input = (body.input if body else {}) or {}
    if version.plan is not None or workflow.enabled_version is not None:
        if workflow.status != "enabled" or workflow.enabled_version is None:
            raise HTTPException(status_code=409, detail="This workflow is not enabled yet. Simulate it and enable it "
                                                         "(with the required authorizations) before running it.")
        version = (await session.execute(select(WorkflowVersion).where(
            WorkflowVersion.workflow_id == workflow.id, WorkflowVersion.version == workflow.enabled_version))).scalar_one()
    missing = _missing_inputs(version.definition, run_input)
    if missing:
        raise HTTPException(status_code=422, detail={"message": f"Missing required input: {', '.join(missing)}",
                                                     "missing_inputs": missing})
    run = await create_run(session, workflow, version, run_input, user.id)
    audit(session, user, "workflow.execute", "workflow_run", run.id, {"workflow_id": str(workflow.id)})
    await commit_and_publish(session, bus)
    return await run_out(session, run)


def _missing_inputs(definition: dict[str, Any], run_input: dict[str, Any]) -> list[str]:
    start = next((n for n in definition.get("nodes") or [] if n.get("type") == "start"), None)
    schema = (((start or {}).get("data") or {}).get("config") or {}).get("input_schema") or {}
    return [k for k in schema.get("required") or []
            if run_input.get(k) is None or (isinstance(run_input.get(k), str) and not run_input[k].strip())]


async def count_workflows(session: AsyncSession, user: User) -> int:
    rows = (await session.execute(select(Workflow).where(Workflow.deleted_at.is_(None)))).scalars().all()
    return sum(1 for w in rows if permissions.can_view_workflow(user, w))
