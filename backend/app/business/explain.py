"""Deterministic, business-language explanation of a Business Plan (no LLM involved)."""

from typing import Any

from app.business.capabilities import CONNECTOR_LABELS, SENSITIVE_EFFECTS, get_capability
from app.business.plan import ActionStep, ApprovalStep, BusinessPlan, DecisionStep, FailTarget, WaitStep, step_targets
from app.business.policy import Finding

OPS = {"eq": "is", "neq": "is not", "gt": "is more than", "lt": "is less than", "gte": "is at least",
       "lte": "is at most", "contains": "contains"}


def _ref_text(ref: str, titles: dict[str, str]) -> str:
    parts = ref.split(".")
    if parts[0] == "input" and len(parts) > 1:
        return f"the request's '{parts[1]}'"
    if parts[0] == "steps" and len(parts) >= 3:
        title = titles.get(parts[1], parts[1])
        if parts[2] == "attempts":
            return f"the number of times '{title}' has run"
        return f"'{'.'.join(parts[2:])}' from '{title}'"
    return ref


def _operand(value: Any, titles: dict[str, str]) -> str:
    if isinstance(value, dict) and ("ref" in value or "from" in value):
        return _ref_text(str(value.get("ref") or value.get("from")), titles)
    if isinstance(value, dict) and "value" in value:
        v = value["value"]
        return "yes" if v is True else "no" if v is False else f"{v}"
    return str(value)


def describe_rule(rule: Any, titles: dict[str, str]) -> str:
    if not isinstance(rule, dict):
        return "?"
    op = rule.get("op")
    if op in ("and", "or"):
        joiner = " and " if op == "and" else " or "
        return joiner.join(describe_rule(r, titles) for r in rule.get("rules") or [])
    if op == "not":
        return f"not ({describe_rule(rule.get('rule'), titles)})"
    left = _operand(rule.get("left"), titles)
    if op == "exists":
        return f"{left} is available"
    if op == "is_true":
        return f"{left} is yes"
    if op == "is_false":
        return f"{left} is no"
    return f"{left} {OPS.get(op, op)} {_operand(rule.get('right'), titles)}"


def _target_text(target: Any, titles: dict[str, str]) -> str:
    if isinstance(target, FailTarget):
        return f"stop ({target.fail})"
    if target == "end":
        return "finish"
    return f"go to '{titles.get(target, target)}'"


def explain_plan(plan: BusinessPlan, findings: list[Finding], capability_status: dict[str, dict[str, Any]]) -> dict[str, Any]:
    titles = {s.id: s.title for s in plan.steps}
    steps: list[dict[str, Any]] = []
    integrations: dict[str, dict[str, Any]] = {}
    permissions: list[dict[str, Any]] = []
    for index, step in enumerate(plan.steps):
        entry: dict[str, Any] = {"step_id": step.id, "title": step.title, "kind": step.kind,
                                 "policy_inserted": step.policy_inserted}
        flow = step_targets(plan, index)
        if isinstance(step, ActionStep):
            cap = get_capability(step.capability)
            if cap is None:
                entry["what"] = f"Needs '{step.capability}', which is not available."
                steps.append(entry)
                continue
            status = capability_status.get(cap.id, {"status": "available"})
            entry.update(what=step.description or cap.description, app=cap.app, capability=cap.name,
                         needs=[f.label for f in cap.inputs if f.key in step.params],
                         produces=[f.label for f in cap.outputs], status=status.get("status"),
                         side_effect=cap.side_effect)
            if step.retry and step.retry.max_attempts > 1:
                entry["retry"] = f"Tried up to {step.retry.max_attempts} times if it fails."
            if cap.connector:
                integrations.setdefault(cap.connector, {
                    "connector": cap.connector, "label": CONNECTOR_LABELS[cap.connector],
                    "status": status.get("status"), "steps": []})["steps"].append(step.title)
            if cap.side_effect in SENSITIVE_EFFECTS or cap.side_effect == "internal":
                permissions.append({"step": step.title, "step_id": step.id, "capability": cap.name,
                                    "side_effect": cap.side_effect,
                                    "needs_authorization": cap.side_effect in SENSITIVE_EFFECTS})
        elif isinstance(step, DecisionStep):
            entry["what"] = "Decides how to continue."
            entry["rules"] = [f"If {describe_rule(b.when, titles)}: {_target_text(b.goto, titles)}." for b in step.branches]
            entry["rules"].append(f"Otherwise: {_target_text(step.otherwise, titles)}.")
        elif isinstance(step, ApprovalStep):
            who = step.approver.role + (f" in {step.approver.department}" if step.approver.department else "")
            entry.update(what=f"Waits for a decision by an {who}.", requires_action=True,
                         on_reject=_target_text(step.on_reject, titles),
                         separation_of_duties=step.separation_of_duties)
            if step.separation_of_duties:
                entry["note"] = "The approver must be a different person from whoever started the run."
        elif isinstance(step, WaitStep):
            entry["what"] = f"Waits {int(step.seconds)} seconds."
        entry["then"] = _target_text(flow[0][1], titles) if flow and step.kind != "decision" else None
        steps.append(entry)
    approvals = [s for s in steps if s["kind"] == "approval"]
    outcomes = ["The workflow finishes when it reaches 'Done'."]
    for i in range(len(plan.steps)):
        for _, target in step_targets(plan, i):
            if isinstance(target, FailTarget) and f"It stops if: {target.fail}." not in outcomes:
                outcomes.append(f"It stops if: {target.fail}.")
    trigger = {"manual": "Started manually by a person.", "api": "Started by another system through the API.",
               "schedule": f"Starts automatically on a schedule ({plan.trigger.cron} {plan.trigger.timezone})."}[plan.trigger.type]
    return {
        "title": plan.title,
        "summary": plan.summary,
        "department": plan.department,
        "trigger": trigger,
        "inputs": [{"key": i.key, "label": i.label, "type": i.type, "required": i.required} for i in plan.inputs],
        "steps": steps,
        "integrations": list(integrations.values()),
        "permissions": permissions,
        "approvals": [{"title": a["title"], "policy_inserted": a["policy_inserted"],
                       "separation_of_duties": a.get("separation_of_duties", False)} for a in approvals],
        "outcomes": outcomes,
        "findings": [f.as_dict() for f in findings],
        "ready_to_enable": not any(f.severity in ("error", "setup") for f in findings),
    }
