"""Business workflows: AI designer sessions, templates, registry, plan editing, simulation, enabling."""

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import audit, current_user, get_bus, load_workflow
from app.business.capabilities import CAPABILITIES, SENSITIVE_EFFECTS, get_capability
from app.business.operations import OperationError, parse_operations
from app.business.plan import ActionStep, BusinessPlan
from app.business.service import (
    all_statuses,
    capability_status,
    create_plan_workflow,
    current_version,
    evaluate,
    policy_context,
    preview_operations,
    proposal,
    save_plan_version,
)
from app.business.templates import TEMPLATES, get_template
from app.core import permissions
from app.core.db import get_session
from app.designer.planner import PlannerUnavailable
from app.designer.service import DesignerError, build_planner, design_change, design_new, designer_provider
from app.models import DesignerSession, User, Workflow, utcnow
from app.orchestration.bus import Bus
from app.orchestration.events import commit_and_publish
from app.services.execution import create_run
from app.services.serializers import run_out

router = APIRouter(prefix="/api", tags=["business"])


# -- registry -------------------------------------------------------------------------------

@router.get("/capabilities")
async def capabilities(department: str | None = None, user: User = Depends(current_user),
                       session: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    ctx = await policy_context(session, department)
    return [{**cap.public(), **capability_status(cap, ctx)} for cap in CAPABILITIES.values()]


# -- designer -------------------------------------------------------------------------------

class SessionCreate(BaseModel):
    prompt: str | None = Field(default=None, max_length=8000)
    department: str | None = None
    workflow_id: uuid.UUID | None = None


class MessageIn(BaseModel):
    message: str = Field(min_length=1, max_length=8000)


class SaveIn(BaseModel):
    name: str | None = Field(default=None, max_length=200)


def _now() -> str:
    return utcnow().isoformat()


async def _session_out(db: AsyncSession, s: DesignerSession) -> dict[str, Any]:
    accepted = None
    if s.plan:
        ctx = await policy_context(db, s.department)
        accepted = evaluate(BusinessPlan.model_validate(s.plan), ctx)
    return {
        "id": str(s.id), "department": s.department,
        "workflow_id": str(s.workflow_id) if s.workflow_id else None, "base_version": s.base_version,
        "messages": s.messages or [],
        "plan": accepted.plan.dump() if accepted else None,
        "definition": accepted.definition if accepted else None,
        "explanation": accepted.explanation if accepted else None,
        "proposal": s.proposal, "can_undo": bool(s.undo_stack), "can_redo": bool(s.redo_stack),
    }


async def _load_session(db: AsyncSession, session_id: uuid.UUID, user: User) -> DesignerSession:
    s = await db.get(DesignerSession, session_id)
    if s is None or (s.user_id != user.id and not permissions.is_admin(user)):
        raise HTTPException(status_code=404, detail="Designer session not found")
    return s


async def _run_designer(db: AsyncSession, s: DesignerSession, message: str) -> None:
    try:
        planner = await build_planner(db)
    except PlannerUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    ctx = await policy_context(db, s.department)
    base = s.plan or ((s.proposal or {}).get("plan"))
    try:
        if base:
            result = await design_change(planner, BusinessPlan.model_validate(base), message, ctx)
            if not s.plan:  # refining a not-yet-accepted proposal keeps it a "create" proposal
                result["kind"], result["diff"] = "create", None
        else:
            result = await design_new(planner, message, ctx)
    except PlannerUnavailable as exc:
        raise HTTPException(status_code=502, detail=f"The AI model could not be reached: {exc}") from exc
    except DesignerError as exc:
        s.messages = [*s.messages, {"role": "user", "content": message, "at": _now()},
                      {"role": "assistant", "content": str(exc), "at": _now(), "error": True}]
        await db.commit()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    s.proposal = result
    s.messages = [*s.messages, {"role": "user", "content": message, "at": _now()},
                  {"role": "assistant", "content": result["summary"] or "Here is a proposal.", "at": _now(),
                   "proposal_kind": result["kind"]}]


@router.get("/designer/status")
async def designer_status(user: User = Depends(current_user), db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    provider = await designer_provider(db)
    if provider is None:
        return {"available": False, "provider": None, "model": None,
                "reason": "No AI model is configured. An administrator can add one under Model Settings."}
    return {"available": True, "provider": provider.name, "model": provider.default_model, "reason": None}


@router.post("/designer/sessions", status_code=201)
async def create_session(body: SessionCreate, user: User = Depends(current_user),
                         db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    department, plan, base_version, workflow_id = body.department, None, None, None
    if body.workflow_id:
        wf = await load_workflow(db, body.workflow_id, user, write=True)
        version = await current_version(db, wf)
        if version.plan is None:
            raise HTTPException(status_code=409, detail="This workflow was built in the advanced editor and has no "
                                                         "business plan to edit with AI")
        department, plan, base_version, workflow_id = wf.department, version.plan, version.version, wf.id
    if not permissions.can_build_in(user, department):
        raise HTTPException(status_code=403, detail=f"You cannot build workflows for {department or 'this department'}")
    s = DesignerSession(id=uuid.uuid4(), user_id=user.id, workflow_id=workflow_id, base_version=base_version,
                        department=department, messages=[], plan=plan, undo_stack=[], redo_stack=[])
    db.add(s)
    await db.flush()
    if body.prompt and body.prompt.strip():
        await _run_designer(db, s, body.prompt.strip())
    audit(db, user, "designer.session", "designer_session", s.id, {"department": department})
    await db.commit()
    return await _session_out(db, s)


@router.get("/designer/sessions/{session_id}")
async def get_session_(session_id: uuid.UUID, user: User = Depends(current_user),
                       db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await _session_out(db, await _load_session(db, session_id, user))


@router.post("/designer/sessions/{session_id}/messages")
async def send_message(session_id: uuid.UUID, body: MessageIn, user: User = Depends(current_user),
                       db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    s = await _load_session(db, session_id, user)
    await _run_designer(db, s, body.message.strip())
    await db.commit()
    return await _session_out(db, s)


@router.post("/designer/sessions/{session_id}/accept")
async def accept(session_id: uuid.UUID, user: User = Depends(current_user),
                 db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    s = await _load_session(db, session_id, user)
    if not s.proposal:
        raise HTTPException(status_code=409, detail="There is no proposal to accept")
    s.undo_stack = [*s.undo_stack, s.plan] if s.plan else [*s.undo_stack, None]
    s.redo_stack = []
    s.plan = s.proposal["plan"]
    s.messages = [*s.messages, {"role": "system", "content": "Changes accepted (not saved yet).", "at": _now()}]
    s.proposal = None
    audit(db, user, "designer.accept", "designer_session", s.id)
    await db.commit()
    return await _session_out(db, s)


@router.post("/designer/sessions/{session_id}/discard")
async def discard(session_id: uuid.UUID, user: User = Depends(current_user),
                  db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    s = await _load_session(db, session_id, user)
    s.proposal = None
    s.messages = [*s.messages, {"role": "system", "content": "Proposal discarded.", "at": _now()}]
    await db.commit()
    return await _session_out(db, s)


@router.post("/designer/sessions/{session_id}/undo")
async def undo(session_id: uuid.UUID, user: User = Depends(current_user),
               db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    s = await _load_session(db, session_id, user)
    if not s.undo_stack:
        raise HTTPException(status_code=409, detail="Nothing to undo")
    s.redo_stack = [*s.redo_stack, s.plan]
    s.plan = s.undo_stack[-1]
    s.undo_stack = s.undo_stack[:-1]
    s.proposal = None
    await db.commit()
    return await _session_out(db, s)


@router.post("/designer/sessions/{session_id}/redo")
async def redo(session_id: uuid.UUID, user: User = Depends(current_user),
               db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    s = await _load_session(db, session_id, user)
    if not s.redo_stack:
        raise HTTPException(status_code=409, detail="Nothing to redo")
    s.undo_stack = [*s.undo_stack, s.plan]
    s.plan = s.redo_stack[-1]
    s.redo_stack = s.redo_stack[:-1]
    s.proposal = None
    await db.commit()
    return await _session_out(db, s)


@router.post("/designer/sessions/{session_id}/save")
async def save_session(session_id: uuid.UUID, body: SaveIn, user: User = Depends(current_user),
                       db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    from app.api.routes_workflows import to_out

    s = await _load_session(db, session_id, user)
    if not s.plan:
        raise HTTPException(status_code=409, detail="Accept a proposal before saving")
    ctx = await policy_context(db, s.department)
    evaluation = evaluate(BusinessPlan.model_validate(s.plan), ctx)
    try:
        if s.workflow_id:
            wf = await load_workflow(db, s.workflow_id, user, write=True)
            if wf.current_version != s.base_version:
                raise HTTPException(status_code=409, detail="The workflow was changed by someone else since this "
                                                             "session started. Start a new AI session to continue.")
            await save_plan_version(db, wf, evaluation, user, "Changed with the AI builder")
        else:
            wf = await create_plan_workflow(db, user, body.name or evaluation.plan.title, evaluation)
            s.workflow_id = wf.id
        s.base_version = wf.current_version
    except OperationError as exc:
        raise HTTPException(status_code=422, detail={"message": str(exc),
                                                     "findings": [f.as_dict() for f in evaluation.findings]}) from exc
    audit(db, user, "designer.save", "workflow", wf.id, {"version": wf.current_version, "session": str(s.id)})
    await db.commit()
    return await to_out(db, wf, user=user)


# -- templates -------------------------------------------------------------------------------

class UseTemplate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    department: str | None = None


@router.get("/templates")
async def templates(department: str | None = None, user: User = Depends(current_user),
                    db: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    out = []
    for t in TEMPLATES:
        if department and t["plan"]["department"] != department:
            continue
        ctx = await policy_context(db, t["plan"]["department"])
        evaluation = evaluate(BusinessPlan.model_validate(t["plan"]), ctx)
        needs = evaluation.explanation["integrations"]
        out.append({
            "id": t["id"], "name": t["name"], "department": t["plan"]["department"],
            "description": t["plan"]["summary"], "step_count": len(evaluation.plan.steps),
            "runs_locally": not any(n["connector"] for n in needs),
            "needs": [{"connector": n["connector"], "label": n["label"], "status": n["status"]} for n in needs],
            "plan": evaluation.plan.dump(), "explanation": evaluation.explanation,
        })
    return out


@router.post("/templates/{template_id}/use", status_code=201)
async def use_template(template_id: str, body: UseTemplate, user: User = Depends(current_user),
                       db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    from app.api.routes_workflows import to_out

    template = get_template(template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    data = {**template["plan"], "department": body.department or template["plan"]["department"]}
    if not permissions.can_build_in(user, data["department"]):
        raise HTTPException(status_code=403, detail=f"You cannot build workflows for {data['department']}")
    evaluation = evaluate(BusinessPlan.model_validate(data), await policy_context(db, data["department"]))
    try:
        wf = await create_plan_workflow(db, user, body.name or template["name"], evaluation)
    except OperationError as exc:
        raise HTTPException(status_code=422, detail={"message": str(exc),
                                                     "findings": [f.as_dict() for f in evaluation.findings]}) from exc
    audit(db, user, "template.use", "workflow", wf.id, {"template": template_id})
    await db.commit()
    return await to_out(db, wf, user=user)


# -- plan editing ------------------------------------------------------------------------------

class OperationsIn(BaseModel):
    operations: list[dict[str, Any]] = Field(max_length=50)
    base_version: int | None = None
    summary: str | None = Field(default=None, max_length=500)


async def _plan_of(db: AsyncSession, wf: Workflow) -> BusinessPlan:
    version = await current_version(db, wf)
    if version.plan is None:
        raise HTTPException(status_code=409, detail="This workflow has no business plan (advanced-only)")
    return BusinessPlan.model_validate(version.plan)


@router.post("/workflows/{workflow_id}/plan/preview")
async def plan_preview(workflow_id: uuid.UUID, body: OperationsIn, user: User = Depends(current_user),
                       db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    wf = await load_workflow(db, workflow_id, user, write=True)
    plan = await _plan_of(db, wf)
    try:
        operations = parse_operations(body.operations)
        evaluation = preview_operations(plan, operations, await policy_context(db, wf.department))
    except OperationError as exc:
        raise HTTPException(status_code=422, detail={"message": str(exc), "findings": []}) from exc
    return proposal("modify", plan, evaluation, operations=operations, summary=body.summary or "")


@router.post("/workflows/{workflow_id}/plan/apply")
async def plan_apply(workflow_id: uuid.UUID, body: OperationsIn, user: User = Depends(current_user),
                     db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    from app.api.routes_workflows import to_out

    wf = await load_workflow(db, workflow_id, user, write=True)
    if body.base_version is not None and body.base_version != wf.current_version:
        raise HTTPException(status_code=409, detail="The workflow changed since you started editing. Reload and try again.")
    plan = await _plan_of(db, wf)
    try:
        operations = parse_operations(body.operations)
        evaluation = preview_operations(plan, operations, await policy_context(db, wf.department))
        await save_plan_version(db, wf, evaluation, user, body.summary or "Edited steps")
    except OperationError as exc:
        raise HTTPException(status_code=422, detail={"message": str(exc), "findings": []}) from exc
    audit(db, user, "workflow.plan_apply", "workflow", wf.id,
          {"version": wf.current_version, "operations": [o.op for o in operations]})
    await db.commit()
    return await to_out(db, wf, user=user)


@router.post("/workflows/{workflow_id}/detach")
async def detach(workflow_id: uuid.UUID, user: User = Depends(current_user),
                 db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    from app.api.routes_workflows import add_version, to_out

    wf = await load_workflow(db, workflow_id, user, write=True)
    version = await current_version(db, wf)
    if version.plan is None:
        raise HTTPException(status_code=409, detail="This workflow is already advanced-only")
    wf.current_version += 1
    new = await add_version(db, wf, wf.current_version, version.definition, user)
    new.plan = None
    new.change_summary = "Detached from business plan"
    audit(db, user, "workflow.detach", "workflow", wf.id, {"version": wf.current_version})
    await db.commit()
    return await to_out(db, wf, user=user)


# -- simulation and enabling -------------------------------------------------------------------

class SimulateIn(BaseModel):
    input: dict[str, Any] = Field(default_factory=dict)
    approvals: dict[str, str] = Field(default_factory=dict)
    step_outputs: dict[str, dict[str, Any]] = Field(default_factory=dict)
    version: int | None = None


@router.post("/workflows/{workflow_id}/simulate", status_code=201)
async def simulate(workflow_id: uuid.UUID, body: SimulateIn, user: User = Depends(current_user),
                   db: AsyncSession = Depends(get_session), bus: Bus = Depends(get_bus)) -> dict[str, Any]:
    from sqlalchemy import select

    from app.models import WorkflowVersion

    wf = await load_workflow(db, workflow_id, user)
    if not permissions.can_run_workflow(user, wf):
        raise HTTPException(status_code=403, detail="You cannot simulate this workflow")
    version_no = body.version or wf.current_version
    version = (await db.execute(select(WorkflowVersion).where(WorkflowVersion.workflow_id == wf.id,
                                                              WorkflowVersion.version == version_no))).scalar_one_or_none()
    if version is None:
        raise HTTPException(status_code=404, detail="Version not found")
    for choice in body.approvals.values():
        if choice not in ("approve", "reject"):
            raise HTTPException(status_code=422, detail="approval choices must be 'approve' or 'reject'")
    run = await create_run(db, wf, version, body.input, user.id, mode="simulation",
                           simulation={"approvals": body.approvals, "step_outputs": body.step_outputs})
    audit(db, user, "workflow.simulate", "workflow_run", run.id, {"workflow_id": str(wf.id), "version": version_no})
    await commit_and_publish(db, bus)
    return await run_out(db, run)


class EnableIn(BaseModel):
    version: int | None = None
    acknowledgements: list[str] = Field(default_factory=list)


@router.post("/workflows/{workflow_id}/enable")
async def enable(workflow_id: uuid.UUID, body: EnableIn, user: User = Depends(current_user),
                 db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    from sqlalchemy import select

    from app.api.routes_workflows import to_out
    from app.models import WorkflowVersion

    wf = await load_workflow(db, workflow_id, user)
    if not permissions.can_enable_workflow(user, wf):
        raise HTTPException(status_code=403, detail="Only builders of this department or administrators can enable it")
    version_no = body.version or wf.current_version
    version = (await db.execute(select(WorkflowVersion).where(WorkflowVersion.workflow_id == wf.id,
                                                              WorkflowVersion.version == version_no))).scalar_one_or_none()
    if version is None:
        raise HTTPException(status_code=404, detail="Version not found")
    findings: list[dict[str, Any]] = []
    missing: list[str] = []
    trigger: dict[str, Any] = {"type": "manual"}
    if version.plan is not None:
        evaluation = evaluate(BusinessPlan.model_validate(version.plan), await policy_context(db, wf.department))
        if evaluation.plan.dump() != version.plan:
            raise HTTPException(status_code=409, detail="Policy has changed since this version was saved. Open and save "
                                                         "the workflow again to apply the current policy.")
        findings = [f.as_dict() for f in evaluation.findings if f.severity in ("error", "setup")]
        sensitive = [s.id for s in evaluation.plan.steps if isinstance(s, ActionStep)
                     and (cap := get_capability(s.capability)) is not None and cap.side_effect in SENSITIVE_EFFECTS]
        missing = [sid for sid in sensitive if sid not in set(body.acknowledgements)]
        trigger = evaluation.plan.trigger.model_dump()
    if findings or missing:
        raise HTTPException(status_code=422, detail={
            "message": "Resolve the setup requirements and authorize every sensitive step before enabling",
            "findings": findings, "missing_acknowledgements": missing})
    wf.status, wf.enabled_version, wf.enabled_by, wf.enabled_at = "enabled", version_no, user.id, utcnow()
    wf.schedule_cron = trigger.get("cron") if trigger.get("type") == "schedule" else None
    wf.schedule_timezone = trigger.get("timezone") if wf.schedule_cron else None
    audit(db, user, "workflow.enable", "workflow", wf.id,
          {"version": version_no, "acknowledged": sorted(body.acknowledgements), "schedule": wf.schedule_cron})
    await db.commit()
    return await to_out(db, wf, user=user)


@router.post("/workflows/{workflow_id}/disable")
async def disable(workflow_id: uuid.UUID, user: User = Depends(current_user),
                  db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    from app.api.routes_workflows import to_out

    wf = await load_workflow(db, workflow_id, user)
    if not permissions.can_enable_workflow(user, wf):
        raise HTTPException(status_code=403, detail="Only builders of this department or administrators can disable it")
    wf.status, wf.schedule_cron = "disabled", None
    audit(db, user, "workflow.disable", "workflow", wf.id)
    await db.commit()
    return await to_out(db, wf, user=user)


__all__ = ["router", "all_statuses"]
