"""Declarative JSON rule evaluation. No eval(), no user code execution."""

import re
from typing import Any

COMPARISON_OPS = {"eq", "neq", "gt", "lt", "gte", "lte", "contains"}
UNARY_OPS = {"exists", "is_true", "is_false"}
GROUP_OPS = {"and", "or"}
ALL_OPS = COMPARISON_OPS | UNARY_OPS | GROUP_OPS | {"not"}

REF_PATTERN = re.compile(r"^(input|run|[a-z][a-z0-9_]{0,63})(\.[A-Za-z0-9_\-]+)*$")
_MISSING = object()


class RuleError(ValueError):
    pass


class EvalContext:
    """Resolves refs like `input.x`, `node.output.a.b`, `node.runs`, `node.status`, `run.steps`."""

    def __init__(
        self,
        run_input: dict[str, Any],
        outputs: dict[str, Any],
        statuses: dict[str, str] | None = None,
        run_counts: dict[str, int] | None = None,
        steps: int = 0,
    ) -> None:
        self.run_input = run_input
        self.outputs = outputs
        self.statuses = statuses or {}
        self.run_counts = run_counts or {}
        self.steps = steps

    def resolve(self, ref: str) -> Any:
        if not isinstance(ref, str) or not REF_PATTERN.match(ref):
            raise RuleError(f"invalid reference: {ref!r}")
        parts = ref.split(".")
        root, rest = parts[0], parts[1:]
        if root == "input":
            return _walk(self.run_input, rest)
        if root == "run":
            if rest == ["steps"]:
                return self.steps
            return None
        if not rest:
            return None
        field_name, path = rest[0], rest[1:]
        if field_name == "output":
            if root not in self.outputs:
                return None
            return _walk(self.outputs[root], path)
        if field_name == "runs" and not path:
            return self.run_counts.get(root, 0)
        if field_name == "status" and not path:
            return self.statuses.get(root)
        return None


def _walk(value: Any, path: list[str]) -> Any:
    for segment in path:
        if isinstance(value, dict):
            value = value.get(segment, _MISSING)
        elif isinstance(value, list) and segment.lstrip("-").isdigit():
            idx = int(segment)
            value = value[idx] if -len(value) <= idx < len(value) else _MISSING
        else:
            value = _MISSING
        if value is _MISSING:
            return None
    return value


def _operand(operand: Any, ctx: EvalContext) -> Any:
    if not isinstance(operand, dict):
        raise RuleError("operand must be an object with 'ref' or 'value'")
    if "ref" in operand:
        return ctx.resolve(operand["ref"])
    if "value" in operand:
        return operand["value"]
    raise RuleError("operand must contain 'ref' or 'value'")


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def evaluate(rule: Any, ctx: EvalContext) -> bool:
    if not isinstance(rule, dict) or "op" not in rule:
        raise RuleError("rule must be an object with an 'op'")
    op = rule["op"]
    if op in GROUP_OPS:
        rules = rule.get("rules")
        if not isinstance(rules, list) or not rules:
            raise RuleError(f"'{op}' requires a non-empty 'rules' list")
        results = (evaluate(r, ctx) for r in rules)
        return all(results) if op == "and" else any(results)
    if op == "not":
        return not evaluate(rule.get("rule"), ctx)
    if op in UNARY_OPS:
        value = _operand(rule.get("left"), ctx)
        if op == "exists":
            return value is not None
        if op == "is_true":
            return value is True
        return value is False
    if op in COMPARISON_OPS:
        left = _operand(rule.get("left"), ctx)
        right = _operand(rule.get("right"), ctx)
        if op == "eq":
            return _equal(left, right)
        if op == "neq":
            return not _equal(left, right)
        if op == "contains":
            if isinstance(left, str) and isinstance(right, str):
                return right in left
            if isinstance(left, list):
                return any(_equal(item, right) for item in left)
            return False
        if not (_is_number(left) and _is_number(right)):
            return False
        return {
            "gt": left > right,
            "lt": left < right,
            "gte": left >= right,
            "lte": left <= right,
        }[op]
    raise RuleError(f"unsupported operator: {op!r}")


def _equal(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if _is_number(a) and _is_number(b):
        return float(a) == float(b)
    return bool(a == b)


def collect_refs(rule: Any) -> list[str]:
    """All refs used by a rule (for validation)."""
    refs: list[str] = []
    if not isinstance(rule, dict):
        return refs
    for key in ("left", "right"):
        operand = rule.get(key)
        if isinstance(operand, dict) and "ref" in operand:
            refs.append(operand["ref"])
    for child in rule.get("rules") or []:
        refs.extend(collect_refs(child))
    if "rule" in rule:
        refs.extend(collect_refs(rule["rule"]))
    return refs


def check_rule_structure(rule: Any, path: str = "rule") -> list[str]:
    """Return structural problems in a rule (empty list = well formed)."""
    problems: list[str] = []
    if not isinstance(rule, dict) or "op" not in rule:
        return [f"{path}: must be an object with 'op'"]
    op = rule["op"]
    if op not in ALL_OPS:
        return [f"{path}: unsupported operator {op!r}"]
    if op in GROUP_OPS:
        rules = rule.get("rules")
        if not isinstance(rules, list) or not rules:
            problems.append(f"{path}: '{op}' requires at least one sub-rule")
        else:
            for i, child in enumerate(rules):
                problems.extend(check_rule_structure(child, f"{path}.rules[{i}]"))
    elif op == "not":
        problems.extend(check_rule_structure(rule.get("rule"), f"{path}.rule"))
    else:
        sides = ["left"] if op in UNARY_OPS else ["left", "right"]
        for side in sides:
            operand = rule.get(side)
            if not isinstance(operand, dict) or not ({"ref", "value"} & operand.keys()):
                problems.append(f"{path}.{side}: must be {{'ref': ...}} or {{'value': ...}}")
            elif "ref" in operand and (
                not isinstance(operand["ref"], str) or not REF_PATTERN.match(operand["ref"])
            ):
                problems.append(f"{path}.{side}: invalid reference {operand['ref']!r}")
        if op in {"gt", "lt", "gte", "lte"}:
            right = rule.get("right")
            if isinstance(right, dict) and "value" in right and not _is_number(right["value"]):
                problems.append(f"{path}: '{op}' requires a numeric value")
    return problems
