"""Database-aware business-workflow services shared by the designer, templates and editors."""

import uuid
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.business.capabilities import CAPABILITIES, CONNECTOR_LABELS, Capability
from app.business.compiler import CompileError, compile_plan
from app.business.explain import explain_plan
from app.business.operations import OperationError, apply_operations, diff_plans
from app.business.plan import BusinessPlan
from app.business.policy import POLICY_VERSION, Finding, PolicyContext, apply_policy
from app.connections.connectors import CONNECTOR_TYPES
from app.models import Connection, Department, ModelProvider, User, Workflow, WorkflowVersion, utcnow
from app.services.execution import get_validator


async def policy_context(session: AsyncSession, department: str | None) -> PolicyContext:
    connected: set[str] = set()
    rows = (await session.execute(select(Connection).where(Connection.enabled.is_(True)))).scalars().all()
    for c in rows:
        if not c.departments or (department and department in c.departments):
            connected.add(CONNECTOR_TYPES[c.connector]["capability_connector"])
    if (await session.execute(select(ModelProvider.id).limit(1))).first() is not None:
        connected.add("llm")
    departments = set((await session.execute(select(Department.code))).scalars().all())
    return PolicyContext(department=department, connected=connected, departments=departments)


def capability_status(cap: Capability, ctx: PolicyContext) -> dict[str, Any]:
    if not cap.allowed_for(ctx.department):
        return {"status": "restricted", "status_reason": f"Not allowed for the {ctx.department or 'unassigned'} department"}
    if cap.connector and cap.connector not in ctx.connected:
        return {"status": "requires_connection", "status_reason": f"Needs a connection: {CONNECTOR_LABELS[cap.connector]}"}
    return {"status": "available", "status_reason": None}


def all_statuses(ctx: PolicyContext) -> dict[str, dict[str, Any]]:
    return {cid: capability_status(cap, ctx) for cid, cap in CAPABILITIES.items()}


@dataclass
class Evaluation:
    plan: BusinessPlan
    definition: dict[str, Any] | None
    findings: list[Finding]
    explanation: dict[str, Any]

    @property
    def blocking(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "error"]

    def as_dict(self) -> dict[str, Any]:
        return {"plan": self.plan.dump(), "definition": self.definition,
                "findings": [f.as_dict() for f in self.findings], "explanation": self.explanation}


def evaluate(plan: BusinessPlan, ctx: PolicyContext) -> Evaluation:
    """policy -> compile -> graph validation -> explanation. Never raises for plan problems."""
    result = apply_policy(plan, ctx)
    findings = list(result.findings)
    definition: dict[str, Any] | None = None
    if not any(f.code == "capability_unavailable" for f in findings):
        try:
            definition = compile_plan(result.plan, {"policy_version": POLICY_VERSION})
        except CompileError as exc:
            findings.append(Finding("error", "compile_error", str(exc)))
    if definition is not None:
        validation = get_validator().validate(definition)
        for issue in validation.errors:
            findings.append(Finding("error", f"graph_{issue.code}", issue.message, issue.node_id))
    return Evaluation(result.plan, definition, findings, explain_plan(result.plan, findings, all_statuses(ctx)))


def parse_plan_or_findings(data: Any) -> tuple[BusinessPlan | None, list[Finding]]:
    try:
        return BusinessPlan.model_validate(data), []
    except ValidationError as exc:
        return None, [Finding("error", "invalid_plan", f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}")
                      for e in exc.errors(include_url=False)[:10]]


def proposal(kind: str, old: BusinessPlan | None, evaluation: Evaluation, operations: list[Any] | None = None,
             summary: str = "", unmet_needs: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "kind": kind,
        "plan": evaluation.plan.dump(),
        "definition": evaluation.definition,
        "explanation": evaluation.explanation,
        "findings": [f.as_dict() for f in evaluation.findings],
        "diff": diff_plans(old, evaluation.plan) if old is not None else None,
        "operations": [o.model_dump() if hasattr(o, "model_dump") else o for o in operations] if operations else None,
        "unmet_needs": unmet_needs or [],
        "summary": summary,
    }


def preview_operations(plan: BusinessPlan, operations: list[Any], ctx: PolicyContext) -> Evaluation:
    """Apply operations transactionally and evaluate; raises OperationError on invalid edits."""
    return evaluate(apply_operations(plan, operations), ctx)


async def current_version(session: AsyncSession, workflow: Workflow) -> WorkflowVersion:
    return (await session.execute(
        select(WorkflowVersion).where(WorkflowVersion.workflow_id == workflow.id,
                                      WorkflowVersion.version == workflow.current_version)
    )).scalar_one()


async def save_plan_version(session: AsyncSession, workflow: Workflow, evaluation: Evaluation, user: User,
                            summary: str | None = None) -> WorkflowVersion:
    """Persist a new immutable version (plan + compiled definition). Running executions are unaffected."""
    if evaluation.blocking or evaluation.definition is None:
        raise OperationError("; ".join(f.message for f in evaluation.blocking) or "workflow does not compile")
    from app.api.routes_workflows import add_version

    workflow.current_version += 1
    version = await add_version(session, workflow, workflow.current_version, evaluation.definition, user)
    version.plan = evaluation.plan.dump()
    version.change_summary = summary
    workflow.department = evaluation.plan.department
    workflow.name = evaluation.plan.title if workflow.name in ("", None) else workflow.name
    workflow.updated_at = utcnow()
    if workflow.status == "enabled" and workflow.enabled_version is None:
        workflow.status = "draft"
    return version


async def create_plan_workflow(session: AsyncSession, user: User, name: str, evaluation: Evaluation,
                               description: str = "") -> Workflow:
    from app.api.routes_workflows import add_version

    if evaluation.blocking or evaluation.definition is None:
        raise OperationError("; ".join(f.message for f in evaluation.blocking) or "workflow does not compile")
    workflow = Workflow(id=uuid.uuid4(), name=name, description=description or evaluation.plan.summary,
                        owner_id=user.id, current_version=1, department=evaluation.plan.department, status="draft")
    session.add(workflow)
    await session.flush()
    version = await add_version(session, workflow, 1, evaluation.definition, user)
    version.plan = evaluation.plan.dump()
    version.change_summary = "Created"
    return workflow
