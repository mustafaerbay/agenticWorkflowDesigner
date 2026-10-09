"""Workflow definition validation: structure, references, types and loop bounds."""

import re
from dataclasses import dataclass, field
from typing import Any

import jsonschema

from app.orchestration.conditions import UNARY_OPS, check_rule_structure, collect_refs
from app.orchestration.graph import NODE_TYPES, TERMINAL_TYPES, Graph, source_handles

NODE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
HANDLE_PATTERN = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
RESERVED_IDS = {"input", "run"}
AGENT_KINDS = {"llm", "scripted"}

DEFAULT_SETTINGS = {"max_loop_iterations": 5, "max_total_steps": 100, "max_duration_seconds": 3600}
SETTING_BOUNDS = {
    "max_loop_iterations": (1, 100),
    "max_total_steps": (1, 1000),
    "max_duration_seconds": (10, 86400),
}


@dataclass
class Issue:
    code: str
    message: str
    node_id: str | None = None
    edge_id: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class ValidationResult:
    errors: list[Issue] = field(default_factory=list)
    warnings: list[Issue] = field(default_factory=list)

    @property
    def valid(self) -> bool:
        return not self.errors

    def as_dict(self) -> dict[str, Any]:
        return {
            "valid": self.valid,
            "errors": [i.as_dict() for i in self.errors],
            "warnings": [i.as_dict() for i in self.warnings],
        }


def effective_settings(definition: dict[str, Any]) -> dict[str, int]:
    settings = dict(DEFAULT_SETTINGS)
    for key, value in (definition.get("settings") or {}).items():
        if key in settings and isinstance(value, int) and not isinstance(value, bool):
            settings[key] = value
    return settings


def _schema_type_at(schema: dict[str, Any] | None, path: list[str]) -> str | None:
    """Return the JSON-schema type at a property path, if declared."""
    current = schema
    for segment in path:
        if not isinstance(current, dict):
            return None
        if current.get("type") == "object" or "properties" in current:
            current = (current.get("properties") or {}).get(segment)
        elif current.get("type") == "array" and segment.isdigit():
            current = current.get("items")
        else:
            return None
    if isinstance(current, dict):
        t = current.get("type")
        if isinstance(t, list):
            non_null = [x for x in t if x != "null"]
            return non_null[0] if len(non_null) == 1 else None
        return t if isinstance(t, str) else None
    return None


class WorkflowValidator:
    def __init__(
        self,
        tools: dict[str, dict[str, Any]],
        presets: set[str] | None = None,
    ) -> None:
        # tools: name -> {"parameters": schema, "output_schema": schema}
        self.tools = tools
        self.presets = presets or set()

    def validate(self, definition: Any) -> ValidationResult:
        result = ValidationResult()
        err, warn = result.errors.append, result.warnings.append
        if not isinstance(definition, dict):
            err(Issue("invalid_definition", "Definition must be an object"))
            return result
        nodes = definition.get("nodes")
        edges = definition.get("edges")
        if not isinstance(nodes, list) or not isinstance(edges, list):
            err(Issue("invalid_definition", "Definition requires 'nodes' and 'edges' lists"))
            return result

        self._check_settings(definition.get("settings"), err)

        seen_nodes: set[str] = set()
        for node in nodes:
            if not isinstance(node, dict):
                err(Issue("invalid_node", "Node must be an object"))
                continue
            nid = node.get("id")
            if not isinstance(nid, str) or not NODE_ID_PATTERN.match(nid) or nid in RESERVED_IDS:
                err(Issue("invalid_node_id", f"Invalid node id {nid!r}: use lowercase letters, digits and _", node_id=str(nid)))
                continue
            if nid in seen_nodes:
                err(Issue("duplicate_node_id", f"Duplicate node id '{nid}'", node_id=nid))
            seen_nodes.add(nid)
            if node.get("type") not in NODE_TYPES:
                err(Issue("invalid_node_type", f"Unknown node type {node.get('type')!r}", node_id=nid))

        graph = Graph.from_definition(definition)
        starts = [nid for nid, n in graph.nodes.items() if n.get("type") == "start"]
        if len(starts) != 1:
            err(Issue("start_count", f"Workflow needs exactly one Start node (found {len(starts)})"))
        if not any(n.get("type") == "end" for n in graph.nodes.values()):
            err(Issue("no_end", "Workflow needs at least one End node"))

        self._check_edges(graph, edges, err, warn)

        if graph.start_id:
            for nid in graph.nodes:
                if nid not in graph.reachable:
                    err(Issue("unreachable", f"Node '{graph.label(nid)}' is not reachable from Start", node_id=nid))
            if graph.incoming.get(graph.start_id):
                err(Issue("start_incoming", "Start node cannot have incoming edges", node_id=graph.start_id))

        for nid, node in graph.nodes.items():
            ntype = node.get("type")
            if ntype not in NODE_TYPES:
                continue
            if ntype not in TERMINAL_TYPES and not graph.outgoing[nid]:
                err(Issue("dead_end", f"Node '{graph.label(nid)}' has no outgoing connection", node_id=nid))
            self._check_node(graph, nid, node, err, warn)

        self._check_cycles(graph, err, warn)
        return result

    # -- sections ---------------------------------------------------------

    def _check_settings(self, settings: Any, err: Any) -> None:
        if settings is None:
            return
        if not isinstance(settings, dict):
            err(Issue("invalid_settings", "settings must be an object"))
            return
        for key, (lo, hi) in SETTING_BOUNDS.items():
            if key in settings:
                value = settings[key]
                if not isinstance(value, int) or isinstance(value, bool) or not lo <= value <= hi:
                    err(Issue("invalid_settings", f"settings.{key} must be an integer between {lo} and {hi}"))

    def _check_edges(self, graph: Graph, edges: list[Any], err: Any, warn: Any) -> None:
        seen: set[str] = set()
        triples: set[tuple[str, str, str]] = set()
        for edge in edges:
            if not isinstance(edge, dict) or not isinstance(edge.get("id"), str) or not edge["id"]:
                err(Issue("invalid_edge", "Edge must have a non-empty string id"))
                continue
            eid = edge["id"]
            if eid in seen:
                err(Issue("duplicate_edge_id", f"Duplicate edge id '{eid}'", edge_id=eid))
            seen.add(eid)
            src, tgt = edge.get("source"), edge.get("target")
            if src not in graph.nodes or tgt not in graph.nodes:
                err(Issue("dangling_edge", "Edge references a missing node", edge_id=eid))
                continue
            handle = edge.get("sourceHandle") or "out"
            allowed = source_handles(graph.nodes[src])
            if graph.nodes[src].get("type") in TERMINAL_TYPES:
                err(Issue("terminal_outgoing", f"'{graph.label(src)}' is terminal and cannot have outgoing edges", edge_id=eid))
            elif handle not in allowed:
                err(Issue("invalid_handle", f"Handle '{handle}' does not exist on '{graph.label(src)}' (expected one of {allowed})", edge_id=eid))
            if (edge.get("targetHandle") or "in") != "in":
                err(Issue("invalid_handle", "Target handle must be 'in'", edge_id=eid))
            key = (src, handle, tgt)
            if key in triples:
                warn(Issue("duplicate_edge", "Duplicate connection between the same handles", edge_id=eid))
            triples.add(key)

    def _check_ref(
        self, graph: Graph, nid: str, ref: str, err: Any, warn: Any, expected: str | None = None
    ) -> None:
        parts = ref.split(".")
        root = parts[0]
        if root in ("input", "run"):
            return
        if root not in graph.nodes:
            err(Issue("unknown_ref", f"Reference '{ref}' points to unknown node '{root}'", node_id=nid))
            return
        if len(parts) < 2 or parts[1] not in ("output", "runs", "status"):
            err(Issue("invalid_ref", f"Reference '{ref}' must use .output, .runs or .status", node_id=nid))
            return
        if parts[1] == "output" and expected:
            declared = self._output_type(graph, root, parts[2:])
            if declared and not _compatible(declared, expected):
                err(Issue("type_mismatch", f"'{ref}' is declared as {declared} but the operator needs {expected}", node_id=nid))

    def _output_type(self, graph: Graph, node_id: str, path: list[str]) -> str | None:
        node = graph.nodes[node_id]
        config = graph.config(node_id)
        if node.get("type") == "tool":
            tool = self.tools.get(config.get("tool") or "")
            return _schema_type_at((tool or {}).get("output_schema"), path)
        if node.get("type") == "agent":
            return _schema_type_at(config.get("output_schema"), path)
        if node.get("type") == "approval" and path == ["approved"]:
            return "boolean"
        return None

    def _check_node(self, graph: Graph, nid: str, node: dict[str, Any], err: Any, warn: Any) -> None:
        ntype = node.get("type")
        config = graph.config(nid)
        if ntype == "condition":
            branches = config.get("branches")
            if not isinstance(branches, list) or not branches:
                err(Issue("condition_branches", "Condition needs at least one branch", node_id=nid))
                branches = []
            handles: set[str] = set()
            for i, branch in enumerate(branches):
                handle = branch.get("handle") if isinstance(branch, dict) else None
                if not isinstance(handle, str) or not HANDLE_PATTERN.match(handle):
                    err(Issue("condition_handle", f"Branch {i + 1} has an invalid handle", node_id=nid))
                    continue
                if handle in handles:
                    err(Issue("condition_handle", f"Duplicate branch handle '{handle}'", node_id=nid))
                handles.add(handle)
                rule = branch.get("rule")
                for problem in check_rule_structure(rule, f"branch '{handle}'"):
                    err(Issue("invalid_rule", problem, node_id=nid))
                self._check_rule_refs(graph, nid, rule, err, warn)
            default = config.get("default_handle") or "false"
            if default in handles:
                err(Issue("condition_handle", f"Default handle '{default}' duplicates a branch handle", node_id=nid))
            for handle in [*handles, default]:
                if not graph.edges_from_handle(nid, handle):
                    warn(Issue("unconnected_branch", f"Branch '{handle}' is not connected", node_id=nid))
        elif ntype == "agent":
            kind = config.get("kind") or "llm"
            if kind not in AGENT_KINDS:
                err(Issue("agent_kind", f"Unknown agent kind {kind!r}", node_id=nid))
            preset = config.get("preset")
            if preset and self.presets and preset not in self.presets:
                err(Issue("agent_preset", f"Unknown preset {preset!r}", node_id=nid))
            allowed = config.get("tools") or []
            if not isinstance(allowed, list):
                err(Issue("agent_tools", "tools must be a list", node_id=nid))
                allowed = []
            for tool in allowed:
                if tool not in self.tools:
                    err(Issue("unknown_tool", f"Unknown tool '{tool}'", node_id=nid))
            if kind == "scripted":
                steps = config.get("steps")
                if not isinstance(steps, list) or not steps:
                    err(Issue("scripted_steps", "Scripted agent needs at least one step", node_id=nid))
                for index, step in enumerate(steps or [], 1):
                    tool = step.get("tool") if isinstance(step, dict) else None
                    if tool not in allowed:
                        err(Issue("tool_permission", f"Step tool '{tool}' is not in the agent's tool permissions", node_id=nid))
                    args = step.get("args") if isinstance(step, dict) else None
                    for value in (args or {}).values() if isinstance(args, dict) else []:
                        if isinstance(value, dict) and set(value) == {"ref"}:
                            self._check_ref(graph, nid, str(value["ref"]), err, warn)
                    if tool in self.tools:
                        self._check_tool_args(str(tool), args, nid, f"Step {index} ({tool})", err)
            self._check_retry(config, nid, err)
            self._check_int(config, "timeout_seconds", 1, 3600, nid, err)
            self._check_int(config, "max_steps", 1, 50, nid, err)
            self._check_int(config, "max_tokens", 1, 200_000, nid, err)
            temp = config.get("temperature")
            if temp is not None and (not isinstance(temp, int | float) or not 0 <= temp <= 2):
                err(Issue("agent_temperature", "temperature must be between 0 and 2", node_id=nid))
            mapping = config.get("input_mapping") or {}
            if not isinstance(mapping, dict):
                err(Issue("input_mapping", "input_mapping must be an object", node_id=nid))
            else:
                for ref in mapping.values():
                    if not isinstance(ref, str):
                        err(Issue("input_mapping", "input_mapping values must be reference strings", node_id=nid))
                    else:
                        self._check_ref(graph, nid, ref, err, warn)
            schema = config.get("output_schema")
            if schema is not None and not isinstance(schema, dict):
                err(Issue("output_schema", "output_schema must be a JSON schema object", node_id=nid))
        elif ntype == "tool":
            tool = config.get("tool")
            if tool not in self.tools:
                err(Issue("unknown_tool", f"Unknown tool {tool!r}", node_id=nid))
            args = config.get("args") or {}
            if not isinstance(args, dict):
                err(Issue("tool_args", "args must be an object", node_id=nid))
            else:
                for value in args.values():
                    if isinstance(value, dict) and "ref" in value:
                        self._check_ref(graph, nid, value["ref"], err, warn)
                if tool in self.tools:
                    self._check_tool_args(str(tool), args, nid, f"Tool '{tool}'", err)
            self._check_retry(config, nid, err)
            self._check_int(config, "timeout_seconds", 1, 3600, nid, err)
        elif ntype == "join":
            if (config.get("mode") or "all") not in ("all", "any"):
                err(Issue("join_mode", "Join mode must be 'all' or 'any'", node_id=nid))
            if len(graph.forward_incoming(nid)) < 2:
                warn(Issue("join_inputs", "Join has fewer than two incoming branches", node_id=nid))
        elif ntype == "approval":
            if not str(config.get("title") or "").strip():
                err(Issue("approval_title", "Approval needs a title", node_id=nid))
        elif ntype == "delay":
            seconds = config.get("seconds")
            if not isinstance(seconds, int | float) or isinstance(seconds, bool) or not 0 <= seconds <= 86400:
                err(Issue("delay_seconds", "Delay seconds must be between 0 and 86400", node_id=nid))

    def _check_tool_args(self, tool: str, args: Any, nid: str, where: str, err: Any) -> None:
        """Required arguments must be bound (literal or {"ref"}); literals must match the parameter type."""
        schema = self.tools[tool].get("parameters") or {}
        props: dict[str, Any] = schema.get("properties") or {}
        if args is None:
            args = {}
        if not isinstance(args, dict):
            err(Issue("tool_args", f"{where}: args must be an object", node_id=nid))
            return
        for name in schema.get("required") or []:
            if args.get(name) is None:
                err(Issue("missing_tool_arg",
                          f"{where}: missing required argument '{name}' "
                          f"(set a value or a reference such as {{\"ref\": \"input.{name}\"}})", node_id=nid))
        for name, value in args.items():
            if name not in props:
                if schema.get("additionalProperties") is False:
                    err(Issue("unknown_tool_arg", f"{where}: unknown argument '{name}' (expected one of {sorted(props)})",
                              node_id=nid))
                continue
            if value is None or (isinstance(value, dict) and set(value) == {"ref"}):
                continue  # references are checked separately and resolved at run time
            try:
                jsonschema.validate(value, props[name])
            except jsonschema.ValidationError as exc:
                err(Issue("invalid_tool_arg", f"{where}: argument '{name}' is invalid: {exc.message}", node_id=nid))

    def _check_rule_refs(self, graph: Graph, nid: str, rule: Any, err: Any, warn: Any) -> None:
        if not isinstance(rule, dict):
            return
        op = rule.get("op")
        expected = None
        if op in {"gt", "lt", "gte", "lte"}:
            expected = "number"
        elif op in {"is_true", "is_false"}:
            expected = "boolean"
        elif op == "contains":
            expected = "string|array"
        if op in UNARY_OPS or expected:
            left = rule.get("left")
            if isinstance(left, dict) and isinstance(left.get("ref"), str):
                self._check_ref(graph, nid, left["ref"], err, warn, expected)
            right = rule.get("right")
            if isinstance(right, dict) and isinstance(right.get("ref"), str):
                self._check_ref(graph, nid, right["ref"], err, warn, expected if expected == "number" else None)
        else:
            for ref in collect_refs({k: rule.get(k) for k in ("left", "right") if k in rule}):
                if isinstance(ref, str):
                    self._check_ref(graph, nid, ref, err, warn)
        for child in rule.get("rules") or []:
            self._check_rule_refs(graph, nid, child, err, warn)
        if "rule" in rule:
            self._check_rule_refs(graph, nid, rule["rule"], err, warn)

    def _check_retry(self, config: dict[str, Any], nid: str, err: Any) -> None:
        retry = config.get("retry")
        if retry is None:
            return
        if not isinstance(retry, dict):
            err(Issue("retry", "retry must be an object", node_id=nid))
            return
        self._check_int(retry, "max_attempts", 1, 10, nid, err, "retry.")
        backoff = retry.get("backoff_seconds")
        if backoff is not None and (not isinstance(backoff, int | float) or not 0 <= backoff <= 600):
            err(Issue("retry", "retry.backoff_seconds must be between 0 and 600", node_id=nid))

    def _check_int(
        self, config: dict[str, Any], key: str, lo: int, hi: int, nid: str, err: Any, prefix: str = ""
    ) -> None:
        value = config.get(key)
        if value is None:
            return
        if not isinstance(value, int) or isinstance(value, bool) or not lo <= value <= hi:
            err(Issue("invalid_value", f"{prefix}{key} must be an integer between {lo} and {hi}", node_id=nid))

    def _check_cycles(self, graph: Graph, err: Any, warn: Any) -> None:
        for component in graph.strongly_connected_components():
            exits = [
                nid
                for nid in component
                if graph.node_type(nid) == "condition"
                and any(graph.edges[e]["target"] not in component for e in graph.outgoing[nid])
            ]
            labels = ", ".join(sorted(graph.label(n) for n in component))
            if not exits:
                err(Issue(
                    "unbounded_cycle",
                    f"Cycle [{labels}] has no Condition node with an exit branch; it could loop forever",
                    node_id=sorted(component)[0],
                ))
            if any(graph.node_type(n) == "join" for n in component):
                warn(Issue("join_in_cycle", f"Join inside cycle [{labels}] uses forward edges only", node_id=sorted(component)[0]))


def _compatible(declared: str, expected: str) -> bool:
    if expected == "number":
        return declared in ("number", "integer")
    if expected == "boolean":
        return declared == "boolean"
    if expected == "string|array":
        return declared in ("string", "array")
    return True
