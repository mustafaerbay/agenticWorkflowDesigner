"""Deterministic Business Plan -> workflow definition compiler.

Pure function: the same plan always produces the same definition. Node ids are the stable step
ids, so unchanged steps keep their identity across edits.
"""

import hashlib
import json
import re
from typing import Any

from app.business.capabilities import CONNECTOR_LABELS, REGISTRY_VERSION, Capability, get_capability
from app.business.plan import (
    PLAN_SCHEMA,
    ActionStep,
    ApprovalStep,
    BusinessPlan,
    DecisionStep,
    FailTarget,
    Target,
    WaitStep,
    step_targets,
)

COMPILER_VERSION = "1.0.0"
X_STEP, Y_MAIN, Y_FAIL = 280, 120, 360
STEP_REF = re.compile(r"\{\{\s*steps\.([a-z][a-z0-9_]*)\.([A-Za-z0-9_.\-]+)\s*\}\}")


class CompileError(ValueError):
    pass


def plan_hash(plan: BusinessPlan) -> str:
    data = plan.dump()
    data.pop("ui", None)  # layout does not change behaviour
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]


def fail_node_id(message: str) -> str:
    return "fail_" + hashlib.sha1(message.encode()).hexdigest()[:8]


def translate_ref(ref: str) -> str:
    """Plan ref -> engine ref: input.x | steps.<id>.attempts | steps.<id>.<field...>."""
    parts = ref.split(".")
    if parts[0] == "input":
        return ref
    if parts[0] == "steps" and len(parts) >= 3:
        if parts[2:] == ["attempts"]:
            return f"{parts[1]}.runs"
        return f"{parts[1]}.output.{'.'.join(parts[2:])}"
    raise CompileError(f"invalid reference {ref!r} (use input.<key> or steps.<step>.<field>)")


def translate_value(value: Any) -> Any:
    """Plan param value -> engine value: {"from": ref} -> {"ref": ...}; templates rewritten."""
    if isinstance(value, dict) and set(value) == {"from"}:
        return {"ref": translate_ref(str(value["from"]))}
    if isinstance(value, dict):
        return {k: translate_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [translate_value(v) for v in value]
    if isinstance(value, str):
        return STEP_REF.sub(lambda m: "{{" + f"{m.group(1)}.output.{m.group(2)}" + "}}", value)
    return value


def translate_rule(rule: Any) -> Any:
    if isinstance(rule, dict):
        out: dict[str, Any] = {}
        for key, value in rule.items():
            if key in ("left", "right") and isinstance(value, dict) and "ref" in value:
                out[key] = {"ref": translate_ref(str(value["ref"]))}
            elif key in ("left", "right") and isinstance(value, dict) and "from" in value:
                out[key] = {"ref": translate_ref(str(value["from"]))}
            elif key == "rules":
                out[key] = [translate_rule(r) for r in value]
            elif key == "rule":
                out[key] = translate_rule(value)
            else:
                out[key] = value
        return out
    return rule


def _target_node(target: Target) -> str:
    if isinstance(target, FailTarget):
        return fail_node_id(target.fail)
    return target  # step id or "end"


def _describe_value(value: Any) -> str:
    if isinstance(value, dict) and set(value) == {"from"}:
        ref = str(value["from"])
        return f"'{ref.split('.', 1)[1]}' from the request" if ref.startswith("input.") else ref.replace("steps.", "result of ")
    return json.dumps(value) if not isinstance(value, str) else value


def _business(step: Any, cap: Capability | None) -> dict[str, Any]:
    info: dict[str, Any] = {"title": step.title, "description": step.description, "kind": step.kind,
                            "policy_inserted": step.policy_inserted}
    if isinstance(step, ActionStep) and cap is not None:
        info.update(
            capability=cap.id, capability_name=cap.name, app=cap.app, side_effect=cap.side_effect,
            needs=[{"label": f.label, "value": _describe_value(step.params[f.key])}
                   for f in cap.inputs if f.key in step.params],
            produces=[f.label for f in cap.outputs],
            connector=cap.connector, connector_label=CONNECTOR_LABELS.get(cap.connector or ""),
            requires_action=False,
        )
        if not info["description"]:
            info["description"] = cap.description
    elif isinstance(step, ApprovalStep):
        dept = step.approver.department
        info.update(app="Approvals (built-in)", requires_action=True, side_effect="none",
                    needs=[{"label": "Decision by", "value": f"{step.approver.role}{' in ' + dept if dept else ''}"}],
                    produces=["Approved / rejected", "Comment"],
                    separation_of_duties=step.separation_of_duties)
    elif isinstance(step, DecisionStep):
        info.update(app=None, requires_action=False, side_effect="none", needs=[],
                    produces=[b.label for b in step.branches] + ["Otherwise"])
    elif isinstance(step, WaitStep):
        info.update(app=None, requires_action=False, side_effect="none", needs=[], produces=[])
    return info


def _action_config(step: ActionStep, cap: Capability) -> tuple[str, dict[str, Any]]:
    impl = cap.implementation
    retry = step.retry.model_dump() if step.retry else {"max_attempts": 1, "backoff_seconds": 5}
    common = {"capability": cap.id, "side_effect": cap.side_effect, "connector": cap.connector}
    if impl["kind"] == "tool":
        args: dict[str, Any] = dict(impl.get("fixed") or {})
        for tool_arg, param in impl["args"].items():
            if param in step.params and step.params[param] is not None:
                args[tool_arg] = translate_value(step.params[param])
        return "tool", {"tool": impl["tool"], "args": args, "retry": retry, "timeout_seconds": 300, **common}
    mapping: dict[str, str] = {}
    literal_lines: list[str] = []
    for f in cap.inputs:
        if f.key not in step.params:
            continue
        value = translate_value(step.params[f.key])
        if isinstance(value, dict) and set(value) == {"ref"}:
            mapping[f.key] = value["ref"]
        else:
            literal_lines.append(f"- {f.label} ({f.key}): {value if isinstance(value, str) else json.dumps(value)}")
    prompt = f"Task: {step.title}\n{cap.description}"
    if step.description:
        prompt += f"\nDetails: {step.description}"
    if literal_lines:
        prompt += "\nParameters:\n" + "\n".join(literal_lines)
    if mapping:
        prompt += "\nThe remaining parameters are provided as JSON inputs: " + ", ".join(sorted(mapping))
    return "agent", {
        "kind": "llm",
        "preset": impl["agent"],
        "system_prompt": None,
        "instructions": impl["instructions"],
        "user_prompt": prompt,
        "tools": list(impl["tools"]),
        "input_mapping": mapping,
        "minimize_inputs": True,
        "output_schema": cap.output_schema(),
        "retry": retry,
        **common,
    }


def compile_plan(plan: BusinessPlan, meta_extra: dict[str, Any] | None = None) -> dict[str, Any]:
    positions = (plan.ui or {}).get("positions") or {}
    order = {s.id: i for i, s in enumerate(plan.steps)}

    def pos(node_id: str, default_x: float, default_y: float) -> dict[str, float]:
        p = positions.get(node_id)
        if isinstance(p, dict) and isinstance(p.get("x"), int | float) and isinstance(p.get("y"), int | float):
            return {"x": p["x"], "y": p["y"]}
        return {"x": default_x, "y": default_y}

    required = [i.key for i in plan.inputs if i.required]
    start_config = {
        "default_input": {i.key: i.example for i in plan.inputs if i.example is not None},
        "input_schema": {
            "type": "object",
            "properties": {i.key: {"type": {"number": "number", "boolean": "boolean", "list": "array"}.get(i.type, "string"),
                                   "title": i.label, "description": i.description, "x-input-type": i.type}
                           for i in plan.inputs},
            "required": required,
        },
        "trigger": plan.trigger.model_dump(),
    }
    nodes: list[dict[str, Any]] = [{
        "id": "start", "type": "start", "position": pos("start", 0, Y_MAIN),
        "data": {"label": "Start", "config": start_config,
                 "business": {"title": "Start", "kind": "start",
                              "description": _trigger_text(plan), "needs": [{"label": i.label, "value": i.type}
                                                                              for i in plan.inputs],
                              "produces": [], "requires_action": plan.trigger.type == "manual"}},
    }]
    edges: list[dict[str, Any]] = []
    fail_messages: dict[str, str] = {}

    for index, step in enumerate(plan.steps):
        cap = get_capability(step.capability) if isinstance(step, ActionStep) else None
        if isinstance(step, ActionStep):
            if cap is None:
                raise CompileError(f"step '{step.id}' uses unknown capability '{step.capability}'")
            node_type, config = _action_config(step, cap)
        elif isinstance(step, DecisionStep):
            node_type = "condition"
            config = {"branches": [{"handle": b.id, "label": b.label, "rule": translate_rule(b.when)} for b in step.branches],
                      "default_handle": "otherwise"}
        elif isinstance(step, ApprovalStep):
            node_type = "approval"
            config = {"title": step.title, "description": step.instructions or step.description,
                      "department": step.approver.department, "required_role": step.approver.role,
                      "separation_of_duties": step.separation_of_duties}
        elif isinstance(step, WaitStep):
            node_type, config = "delay", {"seconds": step.seconds}
        else:  # pragma: no cover - exhaustive union
            raise CompileError(f"unsupported step kind {step.kind}")
        nodes.append({"id": step.id, "type": node_type, "position": pos(step.id, (index + 1) * X_STEP, Y_MAIN),
                      "data": {"label": step.title, "config": config, "business": _business(step, cap)}})
        for handle, target in step_targets(plan, index):
            if isinstance(target, str) and target != "end" and target not in order:
                raise CompileError(f"step '{step.id}' points to unknown step '{target}'")
            if isinstance(target, FailTarget):
                fail_messages[fail_node_id(target.fail)] = target.fail
            label = None
            if isinstance(step, DecisionStep):
                label = next((b.label for b in step.branches if b.id == handle), "Otherwise")
            elif isinstance(step, ApprovalStep):
                label = "Approved" if handle == "approved" else "Rejected"
            elif handle == "error":
                label = "If it fails"
            tgt = _target_node(target)
            edge = {"id": f"e_{step.id}_{handle}_{tgt}", "source": step.id, "target": tgt,
                    "sourceHandle": handle, "targetHandle": "in"}
            if label:
                edge["label"] = label
            edges.append(edge)

    first = plan.steps[0].id
    edges.insert(0, {"id": f"e_start_out_{first}", "source": "start", "target": first, "sourceHandle": "out",
                     "targetHandle": "in"})
    end_x = (len(plan.steps) + 1) * X_STEP
    nodes.append({"id": "end", "type": "end", "position": pos("end", end_x, Y_MAIN),
                  "data": {"label": "Done", "config": {},
                           "business": {"title": "Done", "kind": "end", "description": "The workflow finished successfully.",
                                        "needs": [], "produces": [], "requires_action": False}}})
    for i, (node_id, message) in enumerate(sorted(fail_messages.items())):
        nodes.append({"id": node_id, "type": "fail", "position": pos(node_id, (i + 1) * X_STEP, Y_FAIL),
                      "data": {"label": message[:60], "config": {"message": message},
                               "business": {"title": "Stop: " + message[:80], "kind": "fail", "description": message,
                                            "needs": [], "produces": [], "requires_action": False}}})

    meta = {"plan_schema": PLAN_SCHEMA, "compiler_version": COMPILER_VERSION, "registry_version": REGISTRY_VERSION,
            "plan_hash": plan_hash(plan), "department": plan.department, "trigger": plan.trigger.model_dump(),
            **(meta_extra or {})}
    return {"nodes": nodes, "edges": edges, "settings": plan.settings.model_dump(), "meta": meta}


def _trigger_text(plan: BusinessPlan) -> str:
    if plan.trigger.type == "schedule":
        return f"Starts automatically on schedule ({plan.trigger.cron}, {plan.trigger.timezone})."
    if plan.trigger.type == "api":
        return "Starts when another system calls the workflow's API."
    return "Starts when someone runs it and provides the requested information."
