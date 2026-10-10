"""Governance policy for Business Plans. Pure Python; never delegated to the LLM.

`apply_policy` returns a (possibly amended) plan plus findings. Amendments are limited to
*adding* safety (mandatory approvals, separation of duties); policy never removes steps or
grants anything.
"""

from dataclasses import dataclass, field
from typing import Any, Literal

from app.business.capabilities import CONNECTOR_LABELS, SENSITIVE_EFFECTS, get_capability
from app.business.plan import ActionStep, ApprovalStep, Approver, BusinessPlan, FailTarget, step_targets

POLICY_VERSION = "2026.10.1"

Severity = Literal["error", "setup", "warning", "info"]


@dataclass
class Finding:
    severity: Severity
    code: str
    message: str
    step_id: str | None = None
    capability: str | None = None
    connector: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class PolicyContext:
    """What exists for the workflow's department right now (computed from the database)."""

    department: str | None
    connected: set[str] = field(default_factory=set)  # connector types with a usable connection, incl. "llm"
    departments: set[str] = field(default_factory=set)  # known department codes


@dataclass
class PolicyResult:
    plan: BusinessPlan
    findings: list[Finding]

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "error"]

    @property
    def setup(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "setup"]


def _reachable_without_approval(plan: BusinessPlan, target_id: str) -> bool:
    """Is `target_id` reachable without an approval since the start or since the last other
    sensitive step? An approval only covers the next sensitive action on its path."""
    index = {s.id: i for i, s in enumerate(plan.steps)}

    def sensitive(step: Any) -> bool:
        cap = get_capability(step.capability) if isinstance(step, ActionStep) else None
        return cap is not None and cap.side_effect in SENSITIVE_EFFECTS

    frontier = [plan.steps[0].id]
    for i, s in enumerate(plan.steps):
        if s.id != target_id and sensitive(s):
            frontier.extend(t for _, t in step_targets(plan, i) if isinstance(t, str) and t != "end")
    seen: set[str] = set()
    while frontier:
        current = frontier.pop()
        if current == target_id:
            return True
        if current in seen or current not in index:
            continue
        seen.add(current)
        step = plan.steps[index[current]]
        if isinstance(step, ApprovalStep) or sensitive(step):
            continue  # approvals cover what follows; other sensitive steps restart coverage (seeded above)
        for _, tgt in step_targets(plan, index[current]):
            if isinstance(tgt, str) and tgt != "end":
                frontier.append(tgt)
    return False


def _approval_id(plan: BusinessPlan, step_id: str) -> str:
    base = f"approval_before_{step_id}"[:64]
    existing = {s.id for s in plan.steps}
    candidate, n = base, 2
    while candidate in existing:
        candidate = f"{base[:60]}_{n}"
        n += 1
    return candidate


def insert_approval_before(plan: BusinessPlan, step_id: str, title: str, approver: Approver | None = None,
                           separation_of_duties: bool = False, policy_inserted: bool = False,
                           instructions: str = "") -> BusinessPlan:
    """Insert an approval right before `step_id` and re-point every reference to it."""
    data = plan.dump()
    new_id = _approval_id(plan, step_id)
    steps = data["steps"]
    position = next(i for i, s in enumerate(steps) if s["id"] == step_id)

    def retarget(value: Any) -> Any:
        return new_id if value == step_id else value

    for s in steps:
        if s.get("next") == step_id:
            s["next"] = new_id
        if s["kind"] == "decision":
            for b in s["branches"]:
                b["goto"] = retarget(b["goto"])
            s["otherwise"] = retarget(s["otherwise"])
        if s["kind"] == "approval":
            s["on_reject"] = retarget(s["on_reject"])
        if s["kind"] == "action" and isinstance(s.get("on_failure"), dict):
            s["on_failure"]["goto"] = retarget(s["on_failure"]["goto"])
    approval = {
        "id": new_id, "kind": "approval", "title": title, "description": "",
        "next": step_id, "policy_inserted": policy_inserted,
        "approver": (approver or Approver(department=plan.department)).model_dump(),
        "instructions": instructions, "on_reject": {"fail": f"Rejected: {title}"},
        "separation_of_duties": separation_of_duties,
    }
    steps.insert(position, approval)
    return BusinessPlan.model_validate(data)


def check_plan(plan: BusinessPlan, ctx: PolicyContext) -> list[Finding]:
    """Findings that do not change the plan."""
    findings: list[Finding] = []
    ids = [s.id for s in plan.steps]
    if len(ids) != len(set(ids)):
        findings.append(Finding("error", "duplicate_step_id", "Two steps have the same id"))
    if plan.department and ctx.departments and plan.department not in ctx.departments:
        findings.append(Finding("error", "unknown_department", f"Unknown department '{plan.department}'"))
    input_keys = {i.key for i in plan.inputs}
    step_ids = set(ids)
    for step in plan.steps:
        if not isinstance(step, ActionStep):
            continue
        cap = get_capability(step.capability)
        if cap is None:
            findings.append(Finding("setup", "capability_unavailable",
                                    f"'{step.title}' needs a capability that is not available: {step.capability}",
                                    step.id, step.capability))
            continue
        if not cap.allowed_for(plan.department):
            findings.append(Finding("error", "capability_restricted",
                                    f"'{cap.name}' is not allowed for the {plan.department or 'unassigned'} department",
                                    step.id, cap.id))
        if cap.connector and cap.connector not in ctx.connected:
            findings.append(Finding("setup", "connection_required",
                                    f"'{step.title}' needs a connection: {CONNECTOR_LABELS[cap.connector]}",
                                    step.id, cap.id, cap.connector))
        known = {f.key for f in cap.inputs}
        for f in cap.inputs:
            if f.required and step.params.get(f.key) in (None, ""):
                findings.append(Finding("error", "missing_param",
                                        f"'{step.title}' is missing required information: {f.label}", step.id, cap.id))
        for key, value in step.params.items():
            if key not in known:
                findings.append(Finding("error", "unknown_param", f"'{step.title}' has an unknown setting '{key}'",
                                        step.id, cap.id))
            for ref in _refs(value):
                problem = _check_ref(ref, input_keys, step_ids)
                if problem:
                    findings.append(Finding("error", "invalid_reference", f"'{step.title}': {problem}", step.id))
    for step in plan.steps:
        for value in _step_rule_values(step):
            for ref in _refs(value):
                problem = _check_ref(ref, input_keys, step_ids)
                if problem:
                    findings.append(Finding("error", "invalid_reference", f"'{step.title}': {problem}", step.id))
    if plan.trigger.type == "schedule":
        from croniter import croniter

        if not plan.trigger.cron or not croniter.is_valid(plan.trigger.cron):
            findings.append(Finding("error", "invalid_schedule", "The schedule is not a valid cron expression"))
        if any(i.required for i in plan.inputs):
            findings.append(Finding("warning", "scheduled_inputs",
                                    "Scheduled runs start without manual input; required inputs need examples"))
    return findings


def _refs(value: Any) -> list[str]:
    import re

    out: list[str] = []
    if isinstance(value, dict):
        if set(value) == {"from"} or ("ref" in value and set(value) <= {"ref"}):
            out.append(str(value.get("from") or value.get("ref")))
        else:
            for v in value.values():
                out.extend(_refs(v))
    elif isinstance(value, list):
        for v in value:
            out.extend(_refs(v))
    elif isinstance(value, str):
        out.extend(m.group(1) for m in re.finditer(r"\{\{\s*((?:input|steps)\.[A-Za-z0-9_.\-]+)\s*\}\}", value))
    return out


def _step_rule_values(step: Any) -> list[Any]:
    if step.kind == "decision":
        return [b.when for b in step.branches]
    return []


def _check_ref(ref: str, inputs: set[str], steps: set[str]) -> str | None:
    parts = ref.split(".")
    if parts[0] == "input":
        if len(parts) < 2 or parts[1] not in inputs:
            return f"refers to an input that does not exist ({ref})"
        return None
    if parts[0] == "steps":
        if len(parts) < 3 or parts[1] not in steps:
            return f"refers to a step that does not exist ({ref})"
        return None
    return f"invalid reference {ref!r}"


def apply_policy(plan: BusinessPlan, ctx: PolicyContext) -> PolicyResult:
    findings: list[Finding] = []
    # Rule: sensitive side effects need an approval on every path before them.
    for _ in range(len(plan.steps) + 1):
        target = next(
            (s for s in plan.steps if isinstance(s, ActionStep)
             and (cap := get_capability(s.capability)) is not None and cap.side_effect in SENSITIVE_EFFECTS
             and _reachable_without_approval(plan, s.id)),
            None,
        )
        if target is None:
            break
        cap = get_capability(target.capability)
        assert cap is not None
        plan = insert_approval_before(
            plan, target.id, f"Approve: {target.title}", Approver(department=plan.department),
            separation_of_duties=cap.side_effect == "financial", policy_inserted=True,
            instructions=f"Required by policy before '{cap.name}' ({cap.side_effect.replace('_', ' ')}).",
        )
        findings.append(Finding("info", "approval_inserted",
                                f"Added a required approval before '{target.title}' because it "
                                f"{_effect_text(cap.side_effect)}.", target.id, cap.id))
    # Rule: approvals directly before financial actions enforce separation of duties.
    data = plan.dump()
    changed = False
    by_id = {s["id"]: s for s in data["steps"]}
    for s in data["steps"]:
        if s["kind"] != "approval" or s.get("separation_of_duties"):
            continue
        nxt = by_id.get(s.get("next") or "")
        if nxt is None:
            idx = data["steps"].index(s)
            nxt = data["steps"][idx + 1] if idx + 1 < len(data["steps"]) else None
        cap = get_capability(nxt["capability"]) if nxt and nxt["kind"] == "action" else None
        if cap and cap.side_effect == "financial":
            s["separation_of_duties"] = True
            changed = True
            findings.append(Finding("info", "separation_of_duties",
                                    f"'{s['title']}' must be decided by someone other than the person who started the run.",
                                    s["id"]))
    if changed:
        plan = BusinessPlan.model_validate(data)
    findings.extend(check_plan(plan, ctx))
    return PolicyResult(plan, findings)


def _effect_text(effect: str) -> str:
    return {
        "communication": "sends a message outside the workflow",
        "external_write": "changes data in another system",
        "financial": "has a financial effect",
    }.get(effect, "has side effects")


def fail_targets(plan: BusinessPlan) -> set[str]:
    out: set[str] = set()
    for i in range(len(plan.steps)):
        for _, t in step_targets(plan, i):
            if isinstance(t, FailTarget):
                out.add(t.fail)
    return out
