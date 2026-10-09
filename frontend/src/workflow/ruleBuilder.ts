/**
 * Visual condition builder model: a UI tree (with stable ids for React keys and
 * raw text for literal inputs) that serializes 1:1 to the contract Rule JSON.
 */
import type { CompareOp, JSONValue, LogicalOp, Operand, Rule, UnaryOp } from "@/types";

export const COMPARE_OPS: CompareOp[] = ["eq", "neq", "gt", "lt", "gte", "lte", "contains"];
export const UNARY_OPS: UnaryOp[] = ["exists", "is_true", "is_false"];
export const NUMERIC_OPS: CompareOp[] = ["gt", "lt", "gte", "lte"];

export const OP_LABELS: Record<CompareOp | UnaryOp, string> = {
  eq: "equals",
  neq: "does not equal",
  gt: "is greater than",
  lt: "is less than",
  gte: "is greater than or equal to",
  lte: "is less than or equal to",
  contains: "contains",
  exists: "exists",
  is_true: "is true",
  is_false: "is false",
};

export const OP_SYMBOLS: Record<CompareOp | UnaryOp, string> = {
  eq: "==",
  neq: "!=",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
  contains: "contains",
  exists: "exists",
  is_true: "is true",
  is_false: "is false",
};

export type ValueType = "string" | "number" | "boolean" | "null" | "json";

export type OperandUI =
  | { mode: "ref"; ref: string }
  | { mode: "value"; valueType: ValueType; raw: string };

export type RuleUI =
  | { id: string; kind: "group"; op: LogicalOp; children: RuleUI[] }
  | { id: string; kind: "not"; child: RuleUI }
  | { id: string; kind: "cmp"; op: CompareOp | UnaryOp; left: OperandUI; right: OperandUI };

let counter = 0;
export function uid(prefix = "r"): string {
  counter += 1;
  return `${prefix}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function isUnaryOp(op: string): op is UnaryOp {
  return (UNARY_OPS as string[]).includes(op);
}
export function isCompareOp(op: string): op is CompareOp {
  return (COMPARE_OPS as string[]).includes(op);
}

// ---------------------------------------------------------------------------
// Operand <-> OperandUI
// ---------------------------------------------------------------------------

export function valueTypeOf(v: JSONValue): ValueType {
  if (v === null) return "null";
  if (typeof v === "string") return "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  return "json";
}

export function operandToUI(op: Operand | undefined | null): OperandUI {
  if (!op) return { mode: "value", valueType: "string", raw: "" };
  if ("ref" in op) return { mode: "ref", ref: op.ref ?? "" };
  const v = (op as { value: JSONValue }).value;
  const t = valueTypeOf(v ?? null);
  switch (t) {
    case "null":
      return { mode: "value", valueType: "null", raw: "" };
    case "string":
      return { mode: "value", valueType: "string", raw: v as string };
    case "number":
      return { mode: "value", valueType: "number", raw: String(v) };
    case "boolean":
      return { mode: "value", valueType: "boolean", raw: v ? "true" : "false" };
    default:
      return { mode: "value", valueType: "json", raw: JSON.stringify(v) };
  }
}

/** Parse a literal; never throws (invalid input falls back to a safe value, see `operandError`). */
export function parseLiteral(valueType: ValueType, raw: string): JSONValue {
  switch (valueType) {
    case "null":
      return null;
    case "boolean":
      return raw === "true";
    case "number": {
      const n = Number(raw);
      return raw.trim() !== "" && Number.isFinite(n) ? n : 0;
    }
    case "json":
      try {
        return JSON.parse(raw) as JSONValue;
      } catch {
        return null;
      }
    default:
      return raw;
  }
}

export function operandFromUI(o: OperandUI): Operand {
  if (o.mode === "ref") return { ref: o.ref.trim() };
  return { value: parseLiteral(o.valueType, o.raw) };
}

export function operandError(o: OperandUI): string | null {
  if (o.mode === "ref") {
    if (!o.ref.trim()) return "Choose a value reference";
    if (!/^[A-Za-z_][\w]*(\.[\w-]+)*$/.test(o.ref.trim())) return "Invalid reference path";
    return null;
  }
  if (o.valueType === "number") {
    if (o.raw.trim() === "" || !Number.isFinite(Number(o.raw))) return "Enter a number";
  }
  if (o.valueType === "json") {
    try {
      JSON.parse(o.raw);
    } catch {
      return "Invalid JSON";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule <-> RuleUI
// ---------------------------------------------------------------------------

export function ruleToUI(rule: Rule | null | undefined): RuleUI {
  if (!rule || typeof rule !== "object") return newGroup("and", []);
  const op = (rule as { op: string }).op;
  if (op === "and" || op === "or") {
    const r = rule as { op: LogicalOp; rules?: Rule[] };
    return { id: uid("g"), kind: "group", op, children: (r.rules ?? []).map(ruleToUI) };
  }
  if (op === "not") {
    return { id: uid("n"), kind: "not", child: ruleToUI((rule as { rule: Rule }).rule) };
  }
  if (isUnaryOp(op)) {
    const r = rule as { left: Operand };
    return {
      id: uid("c"),
      kind: "cmp",
      op,
      left: operandToUI(r.left),
      right: { mode: "value", valueType: "boolean", raw: "true" },
    };
  }
  const r = rule as { op: CompareOp; left: Operand; right: Operand };
  return { id: uid("c"), kind: "cmp", op: isCompareOp(op) ? op : "eq", left: operandToUI(r.left), right: operandToUI(r.right) };
}

export function uiToRule(ui: RuleUI): Rule {
  switch (ui.kind) {
    case "group":
      return { op: ui.op, rules: ui.children.map(uiToRule) };
    case "not":
      return { op: "not", rule: uiToRule(ui.child) };
    case "cmp":
      if (isUnaryOp(ui.op)) return { op: ui.op, left: operandFromUI(ui.left) };
      return { op: ui.op, left: operandFromUI(ui.left), right: operandFromUI(ui.right) };
  }
}

// ---------------------------------------------------------------------------
// Constructors & immutable tree edits
// ---------------------------------------------------------------------------

export function newComparison(): RuleUI {
  return {
    id: uid("c"),
    kind: "cmp",
    op: "eq",
    left: { mode: "ref", ref: "" },
    right: { mode: "value", valueType: "boolean", raw: "true" },
  };
}

export function newGroup(op: LogicalOp = "and", children: RuleUI[] = [newComparison()]): RuleUI {
  return { id: uid("g"), kind: "group", op, children };
}

export function newNot(child: RuleUI = newComparison()): RuleUI {
  return { id: uid("n"), kind: "not", child };
}

/** Replace the node with `id` by the result of `fn` (return null to remove it). */
export function updateNode(root: RuleUI, id: string, fn: (n: RuleUI) => RuleUI | null): RuleUI | null {
  if (root.id === id) return fn(root);
  if (root.kind === "group") {
    let changed = false;
    const children: RuleUI[] = [];
    for (const c of root.children) {
      const next = updateNode(c, id, fn);
      if (next !== c) changed = true;
      if (next) children.push(next);
    }
    return changed ? { ...root, children } : root;
  }
  if (root.kind === "not") {
    const next = updateNode(root.child, id, fn);
    if (next === root.child) return root;
    // removing the child of a NOT removes the NOT itself
    return next ? { ...root, child: next } : null;
  }
  return root;
}

export function addChild(root: RuleUI, groupId: string, child: RuleUI): RuleUI {
  return (
    updateNode(root, groupId, (n) => (n.kind === "group" ? { ...n, children: [...n.children, child] } : n)) ?? root
  );
}

export function removeNode(root: RuleUI, id: string): RuleUI {
  if (root.id === id) return newGroup("and", []);
  return updateNode(root, id, () => null) ?? newGroup("and", []);
}

export function toggleNot(root: RuleUI, id: string): RuleUI {
  return (
    updateNode(root, id, (n) => {
      if (n.kind === "not") return n.child;
      return newNot(n);
    }) ?? root
  );
}

/** Collect validation errors for the whole tree (empty = valid). */
export function ruleErrors(ui: RuleUI): string[] {
  const errs: string[] = [];
  const walk = (n: RuleUI) => {
    if (n.kind === "group") {
      if (n.children.length === 0) errs.push(`${n.op.toUpperCase()} group has no conditions`);
      n.children.forEach(walk);
    } else if (n.kind === "not") {
      walk(n.child);
    } else {
      const le = operandError(n.left);
      if (le) errs.push(le);
      if (!isUnaryOp(n.op)) {
        const re = operandError(n.right);
        if (re) errs.push(re);
      }
    }
  };
  walk(ui);
  return errs;
}

/** Human-readable one-liner, e.g. `testing_agent.output.passed == true AND x > 3`. */
export function describeRule(rule: Rule | null | undefined): string {
  if (!rule) return "";
  const operand = (o: Operand | undefined) => {
    if (!o) return "?";
    if ("ref" in o) return o.ref || "?";
    return JSON.stringify((o as { value: JSONValue }).value);
  };
  switch (rule.op) {
    case "and":
    case "or": {
      const parts = rule.rules.map((r) => {
        const s = describeRule(r);
        return r.op === "and" || r.op === "or" ? `(${s})` : s;
      });
      return parts.join(` ${rule.op.toUpperCase()} `) || "(empty)";
    }
    case "not":
      return `NOT (${describeRule(rule.rule)})`;
    case "exists":
    case "is_true":
    case "is_false":
      return `${operand(rule.left)} ${OP_SYMBOLS[rule.op]}`;
    default:
      return `${operand(rule.left)} ${OP_SYMBOLS[rule.op]} ${operand(rule.right)}`;
  }
}
