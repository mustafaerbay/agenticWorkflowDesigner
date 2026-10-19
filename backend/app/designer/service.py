"""AI Workflow Designer pipeline: planner output -> schema -> registry -> policy -> compile ->
graph validation -> explanation, with a bounded repair loop. Produces proposals only."""

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.llm_client import LLMClient
from app.business.capabilities import CAPABILITIES
from app.business.operations import OperationError, apply_operations, parse_operations
from app.business.plan import BusinessPlan
from app.business.policy import PolicyContext
from app.business.service import all_statuses, evaluate, parse_plan_or_findings, proposal
from app.core.config import get_settings
from app.designer.planner import LlmPlanner, Planner, PlannerContext, PlannerUnavailable
from app.models import ModelProvider

log = logging.getLogger(__name__)
MAX_ATTEMPTS = 3


class DesignerError(RuntimeError):
    """The planner could not produce a valid proposal; message is safe to show to users."""


async def designer_provider(session: AsyncSession) -> ModelProvider | None:
    """Chosen in Model Settings ("AI builder"), else DESIGNER_PROVIDER_NAME, else the default provider."""
    chosen = (await session.execute(select(ModelProvider).where(ModelProvider.use_for_designer.is_(True)).limit(1))).scalar_one_or_none()
    if chosen is not None:
        return chosen
    name = get_settings().designer_provider_name
    if name:
        named = (await session.execute(select(ModelProvider).where(ModelProvider.name == name).limit(1))).scalar_one_or_none()
        if named is not None:
            return named
    from app.services.execution import default_provider

    return await default_provider(session)


async def build_planner(session: AsyncSession) -> Planner:
    provider = await designer_provider(session)
    if provider is None:
        raise PlannerUnavailable("No AI model is configured. An administrator can add one under Model Settings; "
                                 "until then you can start from a template or use the advanced editor.")
    from app.services.env_vars import resolve_env

    client = LLMClient(provider.base_url, provider.default_model, provider.api_key_ref, max(provider.timeout_seconds, 120),
                       api_key=await resolve_env(session, provider.api_key_ref))
    # Respect the provider's Max tokens: a forced higher value can exceed the account's credit or limits.
    return LlmPlanner(client, temperature=min(provider.temperature, 0.3), max_tokens=provider.max_tokens)


def _planner_context(pctx: PolicyContext) -> PlannerContext:
    return PlannerContext(department=pctx.department, departments=sorted(pctx.departments),
                          statuses=all_statuses(pctx))


def _blocking_messages(evaluation: Any) -> list[str]:
    return [f.message for f in evaluation.findings if f.severity == "error"]


async def design_new(planner: Planner, request: str, pctx: PolicyContext) -> dict[str, Any]:
    plctx = _planner_context(pctx)
    errors: list[str] = []
    for attempt in range(1, MAX_ATTEMPTS + 1):
        plctx.errors = errors
        draft = await planner.propose(request, plctx)
        errors = []
        if not isinstance(draft.plan, dict):
            errors.append(f"No valid plan JSON was returned ({draft.summary[:200]})")
            continue
        data = dict(draft.plan)
        data["department"] = pctx.department  # the user's chosen department, never the model's
        data.setdefault("schema", "bp/1")
        unknown = [s.get("capability") for s in data.get("steps") or []
                   if isinstance(s, dict) and s.get("kind") == "action" and s.get("capability") not in CAPABILITIES]
        for cap in unknown:
            errors.append(f"Capability '{cap}' does not exist. Use only catalog ids; describe missing abilities "
                          "in unmet_needs instead.")
        plan, findings = parse_plan_or_findings(data)
        errors.extend(f.message for f in findings)
        if plan is None or errors:
            continue
        evaluation = evaluate(plan, pctx)
        errors = _blocking_messages(evaluation)
        if errors:
            continue
        log.info("designer proposal created", extra={"attempt": attempt, "steps": len(plan.steps)})
        return proposal("create", None, evaluation, summary=draft.summary,
                        unmet_needs=[n for n in draft.unmet_needs if isinstance(n, dict)])
    raise DesignerError("The AI designer could not produce a valid workflow for this request. Problems: "
                        + "; ".join(errors[:5]))


async def design_change(planner: Planner, plan: BusinessPlan, request: str, pctx: PolicyContext) -> dict[str, Any]:
    plctx = _planner_context(pctx)
    errors: list[str] = []
    for attempt in range(1, MAX_ATTEMPTS + 1):
        plctx.errors = errors
        draft = await planner.modify(plan.dump(), request, plctx)
        errors = []
        if not isinstance(draft.operations, list) or not draft.operations:
            errors.append(f"No operations were returned ({draft.summary[:200]})")
            continue
        try:
            operations = parse_operations(draft.operations)
            for op in operations:
                step = getattr(op, "step", None)
                if isinstance(step, dict) and step.get("kind") == "action" and step.get("capability") not in CAPABILITIES:
                    raise OperationError(f"capability '{step.get('capability')}' does not exist; use only catalog ids")
            new_plan = apply_operations(plan, operations)
        except OperationError as exc:
            errors.append(str(exc))
            continue
        if new_plan.department != plan.department:
            errors.append("The department of a workflow cannot be changed by the designer")
            continue
        evaluation = evaluate(new_plan, pctx)
        errors = _blocking_messages(evaluation)
        if errors:
            continue
        log.info("designer change proposed", extra={"attempt": attempt, "operations": len(operations)})
        return proposal("modify", plan, evaluation, operations=operations, summary=draft.summary)
    raise DesignerError("The requested change could not be applied safely. Problems: " + "; ".join(errors[:5]))


def reapply(plan_data: dict[str, Any], operations: list[Any]) -> BusinessPlan:
    return apply_operations(BusinessPlan.model_validate(plan_data), parse_operations(operations))
