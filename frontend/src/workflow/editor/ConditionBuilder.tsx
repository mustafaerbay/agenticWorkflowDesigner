import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, FolderPlus, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { CompareOp, ConditionNodeConfig, LogicalOp, UnaryOp } from "@/types";
import {
  addChild,
  COMPARE_OPS,
  describeRule,
  isUnaryOp,
  newComparison,
  newGroup,
  NUMERIC_OPS,
  OP_LABELS,
  operandError,
  removeNode,
  ruleErrors,
  ruleToUI,
  toggleNot,
  uiToRule,
  uid,
  UNARY_OPS,
  updateNode,
  type OperandUI,
  type RuleUI,
  type ValueType,
} from "../ruleBuilder";
import { RefInput } from "./RefInput";

// ---------------------------------------------------------------------------
// Local UI model for the whole condition config
// ---------------------------------------------------------------------------

interface BranchUI {
  key: string;
  handle: string;
  label: string;
  rule: RuleUI;
}

interface ConditionUI {
  branches: BranchUI[];
  default_handle: string;
}

export function conditionToUI(c: ConditionNodeConfig): ConditionUI {
  return {
    branches: (c.branches ?? []).map((b) => ({ key: uid("b"), handle: b.handle, label: b.label, rule: ruleToUI(b.rule) })),
    default_handle: c.default_handle ?? "false",
  };
}

export function uiToCondition(ui: ConditionUI): ConditionNodeConfig {
  return {
    branches: ui.branches.map((b) => ({ handle: b.handle, label: b.label, rule: uiToRule(b.rule) })),
    default_handle: ui.default_handle,
  };
}

const HANDLE_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function handleErrors(ui: ConditionUI): Record<string, string> {
  const errs: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const b of ui.branches) {
    if (!HANDLE_RE.test(b.handle)) errs[b.key] = "Use letters, digits, - or _";
    else if (seen.has(b.handle) || b.handle === ui.default_handle) errs[b.key] = "Handle must be unique";
    seen.set(b.handle, b.key);
  }
  if (!HANDLE_RE.test(ui.default_handle)) errs.default = "Use letters, digits, - or _";
  return errs;
}

// ---------------------------------------------------------------------------
// Operand editor
// ---------------------------------------------------------------------------

function OperandEditor({
  value,
  onChange,
  suggestions,
  side,
  numeric,
}: {
  value: OperandUI;
  onChange: (o: OperandUI) => void;
  suggestions: string[];
  side: "Left" | "Right";
  numeric?: boolean;
}) {
  const err = operandError(value);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex min-w-0 gap-1">
        <Select
          aria-label={`${side} operand source`}
          className="w-[76px] shrink-0 [&_select]:h-8 [&_select]:text-xs"
          value={value.mode}
          onChange={(e) => {
            const mode = e.target.value as OperandUI["mode"];
            if (mode === value.mode) return;
            onChange(
              mode === "ref"
                ? { mode: "ref", ref: "" }
                : { mode: "value", valueType: numeric ? "number" : "string", raw: numeric ? "0" : "" },
            );
          }}
        >
          <option value="ref">Ref</option>
          <option value="value">Value</option>
        </Select>
        {value.mode === "ref" ? (
          <RefInput
            className="min-w-0 flex-1"
            aria-label={`${side} operand reference`}
            value={value.ref}
            onChange={(ref) => onChange({ mode: "ref", ref })}
            suggestions={suggestions}
            invalid={!!err}
          />
        ) : (
          <LiteralEditor value={value} onChange={onChange} side={side} invalid={!!err} />
        )}
      </div>
      {err && <p className="text-[10px] text-destructive">{err}</p>}
    </div>
  );
}

function LiteralEditor({
  value,
  onChange,
  side,
  invalid,
}: {
  value: Extract<OperandUI, { mode: "value" }>;
  onChange: (o: OperandUI) => void;
  side: string;
  invalid: boolean;
}) {
  const setType = (valueType: ValueType) => {
    const raw =
      valueType === "boolean" ? "true" : valueType === "number" ? (Number.isFinite(Number(value.raw)) && value.raw.trim() ? value.raw : "0") : valueType === "null" ? "" : valueType === "json" ? "[]" : value.valueType === "number" ? value.raw : "";
    onChange({ mode: "value", valueType, raw });
  };
  return (
    <div className="flex min-w-0 flex-1 gap-1">
      <Select
        aria-label={`${side} value type`}
        className="w-[82px] shrink-0 [&_select]:h-8 [&_select]:text-xs"
        value={value.valueType}
        onChange={(e) => setType(e.target.value as ValueType)}
      >
        <option value="string">Text</option>
        <option value="number">Number</option>
        <option value="boolean">Boolean</option>
        <option value="null">Null</option>
        <option value="json">JSON</option>
      </Select>
      {value.valueType === "boolean" ? (
        <Select
          aria-label={`${side} value`}
          className="min-w-0 flex-1 [&_select]:h-8 [&_select]:text-xs"
          value={value.raw === "true" ? "true" : "false"}
          onChange={(e) => onChange({ ...value, raw: e.target.value })}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </Select>
      ) : value.valueType === "null" ? (
        <div className="flex h-8 min-w-0 flex-1 items-center rounded-md border border-dashed px-2 font-mono text-xs text-muted-foreground">
          null
        </div>
      ) : (
        <Input
          aria-label={`${side} value`}
          aria-invalid={invalid || undefined}
          className={cn("h-8 min-w-0 flex-1 text-xs", value.valueType !== "string" && "font-mono")}
          inputMode={value.valueType === "number" ? "decimal" : undefined}
          value={value.raw}
          placeholder={value.valueType === "json" ? '["a", "b"]' : value.valueType === "number" ? "0" : "text"}
          onChange={(e) => onChange({ ...value, raw: e.target.value })}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rule tree editor
// ---------------------------------------------------------------------------

interface TreeProps {
  node: RuleUI;
  root: RuleUI;
  setRoot: (r: RuleUI) => void;
  suggestions: string[];
  depth: number;
  negated?: boolean;
}

function RuleNodeEditor({ node, root, setRoot, suggestions, depth, negated }: TreeProps) {
  const patch = (fn: (n: RuleUI) => RuleUI) => setRoot(updateNode(root, node.id, fn) ?? root);

  if (node.kind === "not") {
    return (
      <RuleNodeEditor node={node.child} root={root} setRoot={setRoot} suggestions={suggestions} depth={depth} negated />
    );
  }

  // The id that a NOT toggle / remove acts on: the wrapping NOT if negated.
  const findParentNot = (r: RuleUI): RuleUI | null => {
    if (r.kind === "not") return r.child.id === node.id ? r : findParentNot(r.child);
    if (r.kind === "group") {
      for (const c of r.children) {
        const f = findParentNot(c);
        if (f) return f;
      }
    }
    return null;
  };
  const outerId = negated ? (findParentNot(root)?.id ?? node.id) : node.id;
  const isRoot = outerId === root.id;

  const notToggle = (
    <Button
      variant={negated ? "secondary" : "ghost"}
      size="xs"
      aria-pressed={!!negated}
      aria-label="Toggle NOT"
      className={cn("font-mono text-[10px]", negated && "text-destructive")}
      onClick={() => setRoot(toggleNot(root, outerId))}
    >
      NOT
    </Button>
  );
  const removeBtn = (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={node.kind === "group" ? "Remove group" : "Remove condition"}
      onClick={() => setRoot(removeNode(root, outerId))}
    >
      <Trash2 />
    </Button>
  );

  if (node.kind === "group") {
    return (
      <div
        className={cn(
          "space-y-2 rounded-lg border p-2",
          depth % 2 === 0 ? "bg-muted/30" : "bg-card",
          negated && "border-destructive/40",
        )}
        role="group"
        aria-label={`${negated ? "NOT " : ""}${node.op.toUpperCase()} group`}
      >
        <div className="flex items-center gap-1">
          {notToggle}
          <div className="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label="Group operator">
            {(["and", "or"] as LogicalOp[]).map((op) => (
              <button
                key={op}
                type="button"
                role="radio"
                aria-checked={node.op === op}
                onClick={() => patch((n) => (n.kind === "group" ? { ...n, op } : n))}
                className={cn(
                  "rounded px-2 py-0.5 text-[10px] font-semibold tracking-wide",
                  node.op === op ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                )}
              >
                {op.toUpperCase()}
              </button>
            ))}
          </div>
          <span className="ml-1 text-[10px] text-muted-foreground">
            {node.op === "and" ? "all must match" : "any can match"}
          </span>
          <div className="ml-auto">{!isRoot && removeBtn}</div>
        </div>
        {node.children.length === 0 && (
          <p className="px-1 text-[11px] text-muted-foreground">No conditions yet.</p>
        )}
        <div className="space-y-2">
          {node.children.map((c) => (
            <RuleNodeEditor key={c.id} node={c} root={root} setRoot={setRoot} suggestions={suggestions} depth={depth + 1} />
          ))}
        </div>
        <div className="flex gap-1">
          <Button variant="ghost" size="xs" onClick={() => setRoot(addChild(root, node.id, newComparison()))}>
            <Plus /> Condition
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setRoot(addChild(root, node.id, newGroup(node.op === "and" ? "or" : "and")))}>
            <FolderPlus /> Group
          </Button>
        </div>
      </div>
    );
  }

  // comparison
  const unary = isUnaryOp(node.op);
  const numeric = (NUMERIC_OPS as string[]).includes(node.op);
  return (
    <div
      className={cn("space-y-1.5 rounded-lg border bg-card p-2 shadow-xs", negated && "border-destructive/40")}
      role="group"
      aria-label="Condition"
    >
      <div className="flex items-center gap-1">
        {notToggle}
        <span className="text-[10px] text-muted-foreground">{negated ? "must NOT hold" : "Comparison"}</span>
        <div className="ml-auto">{!isRoot && removeBtn}</div>
      </div>
      <OperandEditor
        side="Left"
        value={node.left}
        suggestions={suggestions}
        onChange={(left) => patch((n) => (n.kind === "cmp" ? { ...n, left } : n))}
      />
      <Select
        aria-label="Operator"
        className="[&_select]:h-8 [&_select]:text-xs"
        value={node.op}
        onChange={(e) => {
          const op = e.target.value as CompareOp | UnaryOp;
          patch((n) => {
            if (n.kind !== "cmp") return n;
            let right = n.right;
            if ((NUMERIC_OPS as string[]).includes(op) && right.mode === "value" && right.valueType !== "number") {
              right = { mode: "value", valueType: "number", raw: "0" };
            }
            return { ...n, op, right };
          });
        }}
      >
        <optgroup label="Compare">
          {COMPARE_OPS.map((op) => (
            <option key={op} value={op}>
              {OP_LABELS[op]}
            </option>
          ))}
        </optgroup>
        <optgroup label="Check">
          {UNARY_OPS.map((op) => (
            <option key={op} value={op}>
              {OP_LABELS[op]}
            </option>
          ))}
        </optgroup>
      </Select>
      {!unary && (
        <OperandEditor
          side="Right"
          value={node.right}
          numeric={numeric}
          suggestions={suggestions}
          onChange={(right) => patch((n) => (n.kind === "cmp" ? { ...n, right } : n))}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function ConditionBuilder({
  value,
  onChange,
  suggestions,
}: {
  value: ConditionNodeConfig;
  onChange: (c: ConditionNodeConfig) => void;
  suggestions: string[];
}) {
  const [ui, setUi] = useState<ConditionUI>(() => conditionToUI(value));
  const lastEmitted = useRef(JSON.stringify(value));

  useEffect(() => {
    const incoming = JSON.stringify(value);
    if (incoming !== lastEmitted.current) {
      lastEmitted.current = incoming;
      setUi(conditionToUI(value));
    }
  }, [value]);

  const update = (next: ConditionUI) => {
    setUi(next);
    const cfg = uiToCondition(next);
    lastEmitted.current = JSON.stringify(cfg);
    onChange(cfg);
  };

  const hErrs = handleErrors(ui);
  const setBranch = (key: string, patch: Partial<BranchUI>) =>
    update({ ...ui, branches: ui.branches.map((b) => (b.key === key ? { ...b, ...patch } : b)) });

  const nextHandle = () => {
    const taken = new Set([...ui.branches.map((b) => b.handle), ui.default_handle]);
    if (!taken.has("true")) return "true";
    for (let i = 1; ; i++) if (!taken.has(`branch_${i}`)) return `branch_${i}`;
  };

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= ui.branches.length) return;
    const branches = [...ui.branches];
    [branches[i], branches[j]] = [branches[j]!, branches[i]!];
    update({ ...ui, branches });
  };

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">
        Branches are evaluated top to bottom; the first matching branch fires. If none match, the default handle fires.
      </p>
      {ui.branches.map((b, i) => {
        const errs = ruleErrors(b.rule);
        return (
          <section
            key={b.key}
            className="space-y-2 rounded-xl border bg-card p-3"
            aria-label={`Branch ${i + 1}`}
            data-testid={`branch-${i}`}
          >
            <div className="flex items-center gap-1">
              <span className="flex size-5 items-center justify-center rounded-full bg-amber-500/15 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                {i + 1}
              </span>
              <span className="text-xs font-semibold">Branch</span>
              <div className="ml-auto flex">
                <Button variant="ghost" size="icon-sm" aria-label="Move branch up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label="Move branch down" disabled={i === ui.branches.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove branch"
                  onClick={() => update({ ...ui, branches: ui.branches.filter((x) => x.key !== b.key) })}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor={`${b.key}-label`}>Label</Label>
                <Input
                  id={`${b.key}-label`}
                  aria-label="Branch label"
                  className="h-8 text-xs"
                  value={b.label}
                  onChange={(e) => setBranch(b.key, { label: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${b.key}-handle`}>Handle</Label>
                <Input
                  id={`${b.key}-handle`}
                  aria-label="Branch handle"
                  aria-invalid={!!hErrs[b.key] || undefined}
                  className="h-8 font-mono text-xs"
                  value={b.handle}
                  onChange={(e) => setBranch(b.key, { handle: e.target.value.trim() })}
                />
              </div>
            </div>
            {hErrs[b.key] && <p className="text-[10px] text-destructive">{hErrs[b.key]}</p>}
            <RuleNodeEditor
              node={b.rule}
              root={b.rule}
              setRoot={(rule) => setBranch(b.key, { rule })}
              suggestions={suggestions}
              depth={0}
            />
            {b.rule.kind === "cmp" && (
              <Button variant="ghost" size="xs" onClick={() => setBranch(b.key, { rule: newGroup("and", [b.rule]) })}>
                <FolderPlus /> Wrap in group
              </Button>
            )}
            <p className="break-all rounded-md bg-muted/50 px-2 py-1 font-mono text-[10px] text-muted-foreground" aria-label="Rule preview">
              {describeRule(uiToRule(b.rule))}
            </p>
            {errs.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 text-[10px] text-destructive">
                {[...new Set(errs)].map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() =>
          update({
            ...ui,
            branches: [
              ...ui.branches,
              { key: uid("b"), handle: nextHandle(), label: `Branch ${ui.branches.length + 1}`, rule: newGroup("and") },
            ],
          })
        }
      >
        <Plus /> Add branch
      </Button>
      <div className="space-y-1 rounded-xl border border-dashed p-3">
        <Label htmlFor="default-handle">Default handle (no branch matched)</Label>
        <Input
          id="default-handle"
          aria-label="Default handle"
          aria-invalid={!!hErrs.default || undefined}
          className="h-8 font-mono text-xs"
          value={ui.default_handle}
          onChange={(e) => update({ ...ui, default_handle: e.target.value.trim() })}
        />
        {hErrs.default && <p className="text-[10px] text-destructive">{hErrs.default}</p>}
      </div>
    </div>
  );
}
