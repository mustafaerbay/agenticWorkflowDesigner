"""Typed Business Plan operations, applied transactionally, plus a business-level diff."""

import copy
import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.business.plan import Approver, BusinessPlan, InputField, Retry, Step, Trigger
from app.business.policy import insert_approval_before


class OperationError(ValueError):
    pass


class Op(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AddStep(Op):
    op: Literal["add_step"] = "add_step"
    step: dict[str, Any]
    after: str | None = None   # step id, or "start" to insert first
    before: str | None = None


class RemoveStep(Op):
    op: Literal["remove_step"] = "remove_step"
    step_id: str


class UpdateStep(Op):
    op: Literal["update_step"] = "update_step"
    step_id: str
    title: str | None = None
    description: str | None = None
    params: dict[str, Any] | None = None       # merged into existing params; null values remove a param
    seconds: float | None = None               # wait steps
    instructions: str | None = None            # approval steps
    approver: dict[str, Any] | None = None     # approval steps


class SetCondition(Op):
    op: Literal["set_condition"] = "set_condition"
    step_id: str
    branches: list[dict[str, Any]]
    otherwise: Any = None


class AddApprovalBefore(Op):
    op: Literal["add_approval_before"] = "add_approval_before"
    step_id: str
    title: str | None = None
    approver: dict[str, Any] | None = None
    instructions: str = ""
    separation_of_duties: bool = False


class SetRetry(Op):
    op: Literal["set_retry"] = "set_retry"
    step_id: str
    max_attempts: int = Field(ge=1, le=10)
    backoff_seconds: float = Field(default=5, ge=0, le=600)


class SetNext(Op):
    op: Literal["set_next"] = "set_next"
    step_id: str
    next: Any  # step id | "end" | {"fail": msg} | null (= following step)


class SetOnFailure(Op):
    op: Literal["set_on_failure"] = "set_on_failure"
    step_id: str
    on_failure: Any  # "stop" | {"goto": target}


class SetApprovalReject(Op):
    op: Literal["set_on_reject"] = "set_on_reject"
    step_id: str
    on_reject: Any


class SetTrigger(Op):
    op: Literal["set_trigger"] = "set_trigger"
    trigger: dict[str, Any]


class AddInput(Op):
    op: Literal["add_input"] = "add_input"
    input: dict[str, Any]


class RemoveInput(Op):
    op: Literal["remove_input"] = "remove_input"
    key: str


class Rename(Op):
    op: Literal["rename"] = "rename"
    title: str = Field(min_length=1, max_length=200)
    summary: str | None = None


class SetLayout(Op):
    op: Literal["set_layout"] = "set_layout"
    positions: dict[str, dict[str, float]]


class SetSettings(Op):
    op: Literal["set_settings"] = "set_settings"
    settings: dict[str, Any]


Operation = Annotated[
    AddStep | RemoveStep | UpdateStep | SetCondition | AddApprovalBefore | SetRetry | SetNext | SetOnFailure
    | SetApprovalReject | SetTrigger | AddInput | RemoveInput | Rename | SetLayout | SetSettings,
    Field(discriminator="op"),
]


class OperationList(BaseModel):
    operations: list[Operation] = Field(max_length=50)


def parse_operations(raw: Any) -> list[Any]:
    try:
        return OperationList.model_validate({"operations": raw}).operations
    except ValidationError as exc:
        raise OperationError(f"invalid operations: {exc.errors(include_url=False)[:3]}") from exc


def slug(text: str, existing: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:50] or "step"
    if not base[0].isalpha():
        base = "s_" + base
    if base in ("start", "end", "input", "run", "steps"):
        base += "_step"
    candidate, n = base, 2
    while candidate in existing:
        candidate = f"{base}_{n}"
        n += 1
    return candidate


def _references(data: dict[str, Any], step_id: str) -> list[str]:
    hits = []
    for s in data["steps"]:
        targets = [s.get("next")]
        if s["kind"] == "decision":
            targets += [b["goto"] for b in s["branches"]] + [s["otherwise"]]
        if s["kind"] == "approval":
            targets.append(s["on_reject"])
        if s["kind"] == "action" and isinstance(s.get("on_failure"), dict):
            targets.append(s["on_failure"].get("goto"))
        if step_id in targets:
            hits.append(s["id"])
    return hits


def _data_refs(data: dict[str, Any], step_id: str) -> list[str]:
    """Steps whose params or conditions read the output of `step_id`."""
    needle = re.compile(rf"steps\.{re.escape(step_id)}\.")
    hits = []
    for s in data["steps"]:
        if s["id"] == step_id:
            continue
        blob = repr(s.get("params")) + repr(s.get("branches"))
        if needle.search(blob):
            hits.append(s["id"])
    return hits


def _find(data: dict[str, Any], step_id: str) -> tuple[int, dict[str, Any]]:
    for i, s in enumerate(data["steps"]):
        if s["id"] == step_id:
            return i, s
    raise OperationError(f"step '{step_id}' does not exist")


def _apply_one(plan: BusinessPlan, op: Any) -> BusinessPlan:
    data = plan.dump()
    ids = {s["id"] for s in data["steps"]}
    if isinstance(op, AddStep):
        step = copy.deepcopy(op.step)
        step.setdefault("id", slug(step.get("title", "step"), ids))
        if step["id"] in ids:
            step["id"] = slug(step["id"], ids)
        if op.after == "start":
            position = 0
        elif op.after:
            position = _find(data, op.after)[0] + 1
        elif op.before:
            position = _find(data, op.before)[0]
        else:
            position = len(data["steps"])
        data["steps"].insert(position, step)
    elif isinstance(op, RemoveStep):
        index, step = _find(data, op.step_id)
        if step.get("policy_inserted"):
            raise OperationError(f"'{step['title']}' is required by policy and cannot be removed")
        readers = _data_refs(data, op.step_id)
        if readers:
            raise OperationError(f"'{step['title']}' cannot be removed: its result is used by {', '.join(readers)}")
        successor = step.get("next") or (data["steps"][index + 1]["id"] if index + 1 < len(data["steps"]) else "end")
        for other in _references(data, op.step_id):
            _, s = _find(data, other)
            if s.get("next") == op.step_id:
                s["next"] = successor
            if s["kind"] == "decision":
                for b in s["branches"]:
                    if b["goto"] == op.step_id:
                        b["goto"] = successor
                if s["otherwise"] == op.step_id:
                    s["otherwise"] = successor
            if s["kind"] == "approval" and s["on_reject"] == op.step_id:
                s["on_reject"] = successor
            if s["kind"] == "action" and isinstance(s.get("on_failure"), dict) and s["on_failure"].get("goto") == op.step_id:
                s["on_failure"] = "stop"
        del data["steps"][index]
        if not data["steps"]:
            raise OperationError("a workflow needs at least one step")
        (data.get("ui") or {}).get("positions", {}).pop(op.step_id, None)
    elif isinstance(op, UpdateStep):
        _, step = _find(data, op.step_id)
        for key in ("title", "description", "seconds", "instructions"):
            value = getattr(op, key)
            if value is not None:
                if key == "seconds" and step["kind"] != "wait":
                    raise OperationError("only wait steps have a duration")
                if key == "instructions" and step["kind"] != "approval":
                    raise OperationError("only approval steps have instructions")
                step[key] = value
        if op.approver is not None:
            if step["kind"] != "approval":
                raise OperationError("only approval steps have an approver")
            step["approver"] = Approver.model_validate(op.approver).model_dump()
        if op.params is not None:
            if step["kind"] != "action":
                raise OperationError("only action steps have settings")
            for key, value in op.params.items():
                if value is None:
                    step["params"].pop(key, None)
                else:
                    step["params"][key] = value
    elif isinstance(op, SetCondition):
        _, step = _find(data, op.step_id)
        if step["kind"] != "decision":
            raise OperationError(f"'{step['title']}' is not a decision step")
        step["branches"] = op.branches
        if op.otherwise is not None:
            step["otherwise"] = op.otherwise
    elif isinstance(op, AddApprovalBefore):
        _, step = _find(data, op.step_id)
        title = op.title or f"Approve: {step['title']}"
        approver = Approver.model_validate(op.approver) if op.approver else Approver(department=plan.department)
        return insert_approval_before(plan, op.step_id, title, approver, op.separation_of_duties,
                                      instructions=op.instructions)
    elif isinstance(op, SetRetry):
        _, step = _find(data, op.step_id)
        if step["kind"] != "action":
            raise OperationError("only action steps can be retried")
        step["retry"] = Retry(max_attempts=op.max_attempts, backoff_seconds=op.backoff_seconds).model_dump()
    elif isinstance(op, SetNext):
        _, step = _find(data, op.step_id)
        if step["kind"] == "decision":
            raise OperationError("decision steps continue through their branches; use set_condition")
        step["next"] = op.next
    elif isinstance(op, SetOnFailure):
        _, step = _find(data, op.step_id)
        if step["kind"] != "action":
            raise OperationError("only action steps have a failure path")
        step["on_failure"] = op.on_failure
    elif isinstance(op, SetApprovalReject):
        _, step = _find(data, op.step_id)
        if step["kind"] != "approval":
            raise OperationError("only approval steps can be rejected")
        step["on_reject"] = op.on_reject
    elif isinstance(op, SetTrigger):
        data["trigger"] = Trigger.model_validate(op.trigger).model_dump()
    elif isinstance(op, AddInput):
        field_ = InputField.model_validate(op.input)
        if any(i["key"] == field_.key for i in data["inputs"]):
            raise OperationError(f"input '{field_.key}' already exists")
        data["inputs"].append(field_.model_dump())
    elif isinstance(op, RemoveInput):
        if not any(i["key"] == op.key for i in data["inputs"]):
            raise OperationError(f"input '{op.key}' does not exist")
        if re.search(rf"input\.{re.escape(op.key)}\b", repr(data["steps"])):
            raise OperationError(f"input '{op.key}' is still used by a step")
        data["inputs"] = [i for i in data["inputs"] if i["key"] != op.key]
    elif isinstance(op, Rename):
        data["title"] = op.title
        if op.summary is not None:
            data["summary"] = op.summary
    elif isinstance(op, SetLayout):
        ui = data.setdefault("ui", {})
        positions = dict(ui.get("positions") or {})
        positions.update({k: {"x": round(v["x"]), "y": round(v["y"])} for k, v in op.positions.items()})
        ui["positions"] = positions
    elif isinstance(op, SetSettings):
        data["settings"] = {**data["settings"], **op.settings}
    else:  # pragma: no cover
        raise OperationError(f"unsupported operation {op!r}")
    try:
        return BusinessPlan.model_validate(data)
    except ValidationError as exc:
        first = exc.errors(include_url=False)[0]
        raise OperationError(f"{op.op}: {'.'.join(str(p) for p in first['loc'])}: {first['msg']}") from exc


def apply_operations(plan: BusinessPlan, operations: list[Any]) -> BusinessPlan:
    """All-or-nothing: returns a new plan, the input plan is never modified."""
    current = plan
    for i, op in enumerate(operations, 1):
        try:
            current = _apply_one(current, op)
        except OperationError as exc:
            raise OperationError(f"change {i} ({op.op}): {exc}") from exc
    return current


# -- diff ------------------------------------------------------------------------------------

def _comparable(step: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in step.items() if k not in ("id",)}


def diff_plans(old: BusinessPlan | None, new: BusinessPlan) -> dict[str, Any]:
    old_steps = {s.id: s.model_dump(mode="json") for s in (old.steps if old else [])}
    new_steps = {s.id: s.model_dump(mode="json") for s in new.steps}
    changed = []
    for sid, after in new_steps.items():
        before = old_steps.get(sid)
        if before is None or _comparable(before) == _comparable(after):
            continue
        fields = [{"field": k, "before": before.get(k), "after": after.get(k)}
                  for k in sorted(set(before) | set(after)) if before.get(k) != after.get(k)]
        changed.append({"step_id": sid, "title": after["title"], "fields": fields})
    old_order = [s.id for s in old.steps] if old else []
    new_order = [s.id for s in new.steps]
    common_old = [s for s in old_order if s in new_steps]
    common_new = [s for s in new_order if s in old_steps]
    old_data, new_data = (old.dump() if old else {}), new.dump()
    return {
        "added": [{"step_id": sid, "title": new_steps[sid]["title"], "kind": new_steps[sid]["kind"],
                   "policy_inserted": new_steps[sid].get("policy_inserted", False)}
                  for sid in new_order if sid not in old_steps],
        "removed": [{"step_id": sid, "title": old_steps[sid]["title"], "kind": old_steps[sid]["kind"]}
                    for sid in old_order if sid not in new_steps],
        "changed": changed,
        "reordered": common_old != common_new,
        "trigger_changed": old_data.get("trigger") != new_data.get("trigger"),
        "inputs_added": [i["key"] for i in new_data["inputs"] if i["key"] not in {x["key"] for x in old_data.get("inputs", [])}],
        "inputs_removed": [i["key"] for i in old_data.get("inputs", []) if i["key"] not in {x["key"] for x in new_data["inputs"]}],
        "title_changed": old_data.get("title") != new_data.get("title"),
        "settings_changed": old_data.get("settings") != new_data.get("settings"),
        "layout_only": bool(old) and _without_ui(old_data) == _without_ui(new_data),
    }


def _without_ui(data: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in data.items() if k != "ui"}


__all__ = ["Operation", "OperationError", "apply_operations", "diff_plans", "parse_operations", "Step"]
