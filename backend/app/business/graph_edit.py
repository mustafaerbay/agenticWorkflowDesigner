"""Translate Advanced-editor graph edits back into typed Business Plan operations.

Supported edits map to operations. Anything that cannot be represented safely is returned as an
`Unsupported` entry with a reason, so the caller can reject the save and explain why instead of
silently dropping the change.
"""

from dataclasses import dataclass
from typing import Any

from app.business.capabilities import CAPABILITIES
from app.business.compiler import compile_plan
from app.business.operations import (
    AddStep,
    RemoveStep,
    SetApprovalReject,
    SetCondition,
    SetLayout,
    SetNext,
    SetOnFailure,
    SetRetry,
    SetSettings,
    UpdateStep,
)
from app.business.plan import BusinessPlan, step_targets

TERMINALS = {"end", "fail"}


@dataclass
class Unsupported:
    message: str
    node_id: str | None = None
    edge_id: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


def reverse_ref(ref: str) -> str:
    parts = ref.split(".")
    if parts[0] == "input":
        return ref
    if len(parts) == 2 and parts[1] == "runs":
        return f"steps.{parts[0]}.attempts"
    if len(parts) >= 3 and parts[1] == "output":
        return f"steps.{parts[0]}.{'.'.join(parts[2:])}"
    raise ValueError(f"reference {ref!r} cannot be expressed in a business workflow")


def reverse_value(value: Any) -> Any:
    import re

    if isinstance(value, dict) and set(value) == {"ref"}:
        return {"from": reverse_ref(str(value["ref"]))}
    if isinstance(value, dict):
        return {k: reverse_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [reverse_value(v) for v in value]
    if isinstance(value, str):
        return re.sub(r"\{\{\s*([a-z][a-z0-9_]*)\.output\.([A-Za-z0-9_.\-]+)\s*\}\}",
                      lambda m: "{{steps." + m.group(1) + "." + m.group(2) + "}}", value)
    return value


def reverse_rule(rule: Any) -> Any:
    if isinstance(rule, dict):
        out: dict[str, Any] = {}
        for key, value in rule.items():
            if key in ("left", "right") and isinstance(value, dict) and "ref" in value:
                out[key] = {"ref": reverse_ref(str(value["ref"]))}
            elif key == "rules":
                out[key] = [reverse_rule(r) for r in value]
            elif key == "rule":
                out[key] = reverse_rule(value)
            else:
                out[key] = value
        return out
    return rule


def _capability_for_tool_node(config: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """Find the unique capability whose tool implementation matches a tool node."""
    tool, args = config.get("tool"), config.get("args") or {}
    if config.get("capability") in CAPABILITIES:
        cap = CAPABILITIES[config["capability"]]
    else:
        matches = [c for c in CAPABILITIES.values() if c.implementation["kind"] == "tool"
                   and c.implementation["tool"] == tool
                   and all(args.get(k, v) == v for k, v in (c.implementation.get("fixed") or {}).items())]
        if len(matches) != 1:
            return None
        cap = matches[0]
    params = {}
    for tool_arg, param in cap.implementation["args"].items():
        if tool_arg in args and tool_arg not in (cap.implementation.get("fixed") or {}):
            params[param] = reverse_value(args[tool_arg])
        elif tool_arg in args and args[tool_arg] != (cap.implementation.get("fixed") or {}).get(tool_arg):
            params[param] = reverse_value(args[tool_arg])
    return cap.id, params


def _target(node_id: str, nodes: dict[str, dict[str, Any]]) -> Any:
    node = nodes[node_id]
    if node["type"] == "end":
        return "end"
    if node["type"] == "fail":
        return {"fail": str(((node.get("data") or {}).get("config") or {}).get("message") or "Stopped")}
    return node_id


def graph_to_operations(plan: BusinessPlan, new_definition: dict[str, Any]) -> tuple[list[Any], list[Unsupported]]:
    old = compile_plan(plan)
    old_nodes = {n["id"]: n for n in old["nodes"]}
    new_nodes = {n["id"]: n for n in new_definition.get("nodes") or [] if isinstance(n, dict) and "id" in n}
    new_edges = [e for e in new_definition.get("edges") or [] if isinstance(e, dict)]
    ops: list[Any] = []
    bad: list[Unsupported] = []
    step_ids = {s.id for s in plan.steps}

    def cfg(node: dict[str, Any]) -> dict[str, Any]:
        return (node.get("data") or {}).get("config") or {}

    def label(node: dict[str, Any]) -> str:
        return str((node.get("data") or {}).get("label") or node["id"])

    # -- nodes --------------------------------------------------------------------------
    starts = [n for n in new_nodes.values() if n.get("type") == "start"]
    if len(starts) != 1 or starts[0]["id"] != "start":
        bad.append(Unsupported("A business workflow has exactly one Start step (id 'start')."))
    elif cfg(starts[0]).get("input_schema") != cfg(old_nodes["start"]).get("input_schema") or \
            cfg(starts[0]).get("default_input") != cfg(old_nodes["start"]).get("default_input"):
        bad.append(Unsupported("Change the requested information in the business view (inputs), not on the Start node.",
                               node_id="start"))

    added: list[str] = []
    for nid, node in new_nodes.items():
        ntype = node.get("type")
        if ntype in ("parallel", "join"):
            bad.append(Unsupported("Parallel branches are not supported in business workflows yet. "
                                   "Detach the workflow to use them.", node_id=nid))
            continue
        if ntype in TERMINALS or ntype == "start":
            continue
        if nid not in step_ids:
            added.append(nid)
            continue
        old_node = old_nodes[nid]
        if ntype != old_node["type"]:
            bad.append(Unsupported(f"'{label(node)}' cannot change its type.", node_id=nid))
            continue
        step = plan.step(nid)
        assert step is not None
        new_cfg, old_cfg = cfg(node), cfg(old_node)
        update: dict[str, Any] = {}
        if label(node) != step.title:
            update["title"] = label(node)
        desc = (node.get("data") or {}).get("description")
        if isinstance(desc, str) and desc != step.description:
            update["description"] = desc
        if ntype == "tool":
            if new_cfg.get("tool") != old_cfg.get("tool"):
                bad.append(Unsupported(f"'{label(node)}': choose a different step instead of switching its tool.", node_id=nid))
            elif new_cfg.get("args") != old_cfg.get("args"):
                resolved = _capability_for_tool_node({**new_cfg, "capability": old_cfg.get("capability")})
                if resolved:
                    _, params = resolved
                    current = getattr(step, "params", {})
                    changes = {k: v for k, v in params.items() if current.get(k) != v}
                    changes.update({k: None for k in current if k not in params})
                    if changes:
                        update["params"] = changes
            if new_cfg.get("retry") != old_cfg.get("retry") and new_cfg.get("retry"):
                r = new_cfg["retry"]
                ops.append(SetRetry(step_id=nid, max_attempts=int(r.get("max_attempts") or 1),
                                    backoff_seconds=float(r.get("backoff_seconds") or 0)))
        elif ntype == "agent":
            technical = {k for k in set(new_cfg) | set(old_cfg)
                         if k not in ("retry",) and new_cfg.get(k) != old_cfg.get(k)}
            if technical:
                bad.append(Unsupported(f"'{label(node)}': AI step settings ({', '.join(sorted(technical))}) are managed by "
                                       "its capability. Change the step's information in the business view, or detach "
                                       "the workflow to customize the agent.", node_id=nid))
            if new_cfg.get("retry") != old_cfg.get("retry") and new_cfg.get("retry"):
                r = new_cfg["retry"]
                ops.append(SetRetry(step_id=nid, max_attempts=int(r.get("max_attempts") or 1),
                                    backoff_seconds=float(r.get("backoff_seconds") or 0)))
        elif ntype == "approval":
            if new_cfg.get("description") != old_cfg.get("description"):
                update["instructions"] = new_cfg.get("description") or ""
            if new_cfg.get("title") not in (None, old_cfg.get("title")) and "title" not in update:
                update["title"] = new_cfg["title"]
        elif ntype == "delay":
            if new_cfg.get("seconds") != old_cfg.get("seconds"):
                update["seconds"] = new_cfg.get("seconds")
        if update:
            ops.append(UpdateStep(step_id=nid, **update))

    removed = [sid for sid in step_ids if sid not in new_nodes]
    for sid in removed:
        ops.append(RemoveStep(step_id=sid))

    for nid in added:
        node = new_nodes[nid]
        ntype, title, c = node.get("type"), label(node), cfg(node)
        step: dict[str, Any] | None = None
        if ntype == "approval":
            step = {"id": nid, "kind": "approval", "title": c.get("title") or title, "instructions": c.get("description") or ""}
        elif ntype == "delay":
            step = {"id": nid, "kind": "wait", "title": title, "seconds": c.get("seconds") or 0}
        elif ntype == "condition":
            branches = [{"id": str(b.get("handle")), "label": str(b.get("label") or b.get("handle")),
                         "when": reverse_rule(b.get("rule")), "goto": "end"} for b in c.get("branches") or []]
            step = {"id": nid, "kind": "decision", "title": title, "branches": branches, "otherwise": "end"}
        elif ntype == "tool":
            resolved = _capability_for_tool_node(c)
            if resolved is None:
                bad.append(Unsupported(f"'{title}': tool '{c.get('tool')}' is not a registered business capability.",
                                       node_id=nid))
                continue
            cap_id, params = resolved
            step = {"id": nid, "kind": "action", "title": title, "capability": cap_id, "params": params}
        else:
            bad.append(Unsupported(f"'{title}': {ntype} steps cannot be added in the graph of a business workflow. "
                                   "Use the AI builder or the step list to add AI steps.", node_id=nid))
            continue
        incoming = next((e.get("source") for e in new_edges if e.get("target") == nid
                         and e.get("source") in (step_ids | set(added)) and e.get("source") not in removed), None)
        ops.append(AddStep(step=step, after=incoming) if incoming else AddStep(step=step))

    # -- edges --------------------------------------------------------------------------
    known = set(new_nodes)
    outgoing: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for e in new_edges:
        src, tgt = e.get("source"), e.get("target")
        if src not in known or tgt not in known:
            bad.append(Unsupported("A connection points to a step that no longer exists.", edge_id=e.get("id")))
            continue
        outgoing.setdefault((src, e.get("sourceHandle") or "out"), []).append(e)
    for (src, handle), es in outgoing.items():
        if len(es) > 1:
            bad.append(Unsupported(f"'{label(new_nodes[src])}' can only continue to one next step from "
                                   f"'{handle}'. Parallel branches are not supported in business workflows.",
                                   edge_id=es[1].get("id")))
    start_edges = outgoing.get(("start", "out"), [])
    current_steps = [s.id for s in plan.steps if s.id not in removed] + added
    if start_edges and start_edges[0]["target"] in current_steps and current_steps and start_edges[0]["target"] != current_steps[0]:
        bad.append(Unsupported("To change which step comes first, reorder the steps in the business view.",
                               edge_id=start_edges[0].get("id")))

    # Flow is compared against the plan *after* structural edits, because adding or removing
    # steps changes which step follows implicitly.
    from app.business.operations import OperationError, apply_operations

    old_targets: dict[tuple[str, str], Any] = {}
    for i, s in enumerate(plan.steps):
        for handle, tgt in step_targets(plan, i):
            old_targets[(s.id, handle)] = tgt.model_dump() if hasattr(tgt, "model_dump") else tgt
    try:
        structural = apply_operations(plan, ops)
    except OperationError as exc:
        bad.append(Unsupported(str(exc)))
        return ops, bad
    resolved: dict[tuple[str, str], Any] = {}
    for i, s in enumerate(structural.steps):
        for handle, tgt in step_targets(structural, i):
            resolved[(s.id, handle)] = tgt.model_dump() if hasattr(tgt, "model_dump") else tgt

    def successor(removed_id: str) -> Any:
        """Where flow continues after a removed step (mirrors RemoveStep's reconnection)."""
        seen: set[str] = set()
        target: Any = removed_id
        while isinstance(target, str) and target in removed and target not in seen:
            seen.add(target)
            idx = next(i for i, st in enumerate(plan.steps) if st.id == target)
            step_ = plan.steps[idx]
            target = step_.next if step_.next is not None else (
                plan.steps[idx + 1].id if idx + 1 < len(plan.steps) else "end")
            target = target.model_dump() if hasattr(target, "model_dump") else target
        return target

    def fallback(sid: str, handle: str) -> Any:
        old = old_targets.get((sid, handle))
        return successor(old) if isinstance(old, str) and old in removed else None

    for sid in current_steps:
        node = new_nodes.get(sid)
        if node is None:
            continue
        ntype = node.get("type")
        handles = {"condition": None, "approval": ["approved", "rejected"]}.get(ntype, ["out", "error"])
        if ntype == "condition":
            handles = [str(b.get("handle")) for b in cfg(node).get("branches") or []] + ["otherwise"]
        new_targets = {}
        for handle in handles:
            es = outgoing.get((sid, handle))
            new_targets[handle] = _target(es[0]["target"], new_nodes) if es else fallback(sid, handle)
        if ntype == "condition":
            branches = []
            for b in cfg(node).get("branches") or []:
                goto = new_targets.get(str(b.get("handle")))
                branches.append({"id": str(b.get("handle")), "label": str(b.get("label") or b.get("handle")),
                                 "when": reverse_rule(b.get("rule")), "goto": goto if goto is not None else "end"})
            otherwise = new_targets.get("otherwise") or "end"
            old_step = plan.step(sid)
            old_branches = [b.model_dump(mode="json") for b in old_step.branches] if old_step and old_step.kind == "decision" else None
            old_otherwise = resolved.get((sid, "otherwise"))
            if sid in added or branches != old_branches or otherwise != old_otherwise:
                ops.append(SetCondition(step_id=sid, branches=branches, otherwise=otherwise))
            continue
        primary = "approved" if ntype == "approval" else "out"
        nxt = new_targets.get(primary)
        if nxt is None:
            bad.append(Unsupported(f"'{label(node)}' must continue somewhere (connect it to a step or Done).", node_id=sid))
        elif nxt != resolved.get((sid, primary)):
            ops.append(SetNext(step_id=sid, next=nxt))
        if ntype == "approval":
            rej = new_targets.get("rejected")
            if rej is not None and rej != resolved.get((sid, "rejected")):
                ops.append(SetApprovalReject(step_id=sid, on_reject=rej))
        if ntype in ("tool", "agent"):
            err = new_targets.get("error")
            old_err = resolved.get((sid, "error"))
            if err != old_err:
                ops.append(SetOnFailure(step_id=sid, on_failure={"goto": err} if err is not None else "stop"))

    # -- layout and settings ---------------------------------------------------------------
    moved = {nid: n["position"] for nid, n in new_nodes.items()
             if isinstance(n.get("position"), dict)
             and (nid not in old_nodes or n["position"] != old_nodes[nid]["position"])}
    if moved:
        ops.append(SetLayout(positions={k: {"x": float(v.get("x", 0)), "y": float(v.get("y", 0))} for k, v in moved.items()}))
    settings = new_definition.get("settings")
    if isinstance(settings, dict) and settings != old.get("settings"):
        ops.append(SetSettings(settings={k: v for k, v in settings.items()
                                         if k in ("max_loop_iterations", "max_total_steps", "max_duration_seconds")}))
    return ops, bad


__all__ = ["Unsupported", "graph_to_operations"]
