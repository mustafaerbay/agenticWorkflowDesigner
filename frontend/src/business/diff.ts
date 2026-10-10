import type { JSONValue, PlanDiff } from "@/types";
import { stepKindLabel } from "./labels";

const FIELD_LABELS: Record<string, string> = {
  title: "Name",
  description: "Description",
  params: "Details",
  retry: "Retries",
  next: "What happens next",
  on_failure: "If it fails",
  branches: "Decision rules",
  otherwise: "Otherwise",
  instructions: "Instructions for the approver",
  approver: "Who approves",
  on_reject: "If rejected",
  separation_of_duties: "Approver must differ from requester",
  seconds: "Wait time",
  capability: "What it does",
  kind: "Type of step",
  policy_inserted: "Required by policy",
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Short, plain-language rendering of a plan value for a diff line. */
export function plainValue(field: string, v: JSONValue | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return field === "seconds" ? `${v} seconds` : String(v);
  if (typeof v === "string") {
    if (v === "end") return "Finish";
    if (v === "stop") return "Stop the workflow";
    return v;
  }
  if (Array.isArray(v)) {
    if (field === "branches") {
      return v
        .map((b) => (b && typeof b === "object" && !Array.isArray(b) && typeof b.label === "string" ? b.label : "rule"))
        .join(", ");
    }
    return v.map((x) => plainValue(field, x)).join(", ");
  }
  // objects
  if ("fail" in v && typeof v.fail === "string") return `Stop: ${v.fail}`;
  if ("goto" in v) return `Go to ${plainValue(field, v.goto)}`;
  if ("max_attempts" in v) return `Up to ${String(v.max_attempts)} attempts`;
  if ("role" in v) return `${String(v.role).replace("_", " ")}${v.department ? ` in ${String(v.department)}` : ""}`;
  if ("from" in v && typeof v.from === "string") return fromText(v.from);
  if (field === "params") {
    return Object.entries(v)
      .map(([k, x]) => `${k.replace(/_/g, " ")}: ${plainValue("param", x)}`)
      .join("; ");
  }
  return Object.entries(v)
    .map(([k, x]) => `${k}: ${plainValue(k, x)}`)
    .join("; ");
}

function fromText(ref: string): string {
  const parts = ref.split(".");
  if (parts[0] === "input" && parts[1]) return `the request's "${parts[1]}"`;
  if (parts[0] === "steps" && parts.length >= 3) return `"${parts.slice(2).join(".")}" from step ${parts[1]}`;
  return ref;
}

export type DiffLine = {
  kind: "added" | "removed" | "changed" | "info";
  stepId?: string;
  text: string;
  detail?: string[];
  policy?: boolean;
};

/** A plain-language list describing a plan diff. */
export function diffLines(diff: PlanDiff | null | undefined): DiffLine[] {
  if (!diff) return [];
  const lines: DiffLine[] = [];
  for (const a of diff.added) {
    lines.push({
      kind: "added",
      stepId: a.step_id,
      text: `Added ${stepKindLabel(a.kind).toLowerCase()} step “${a.title}”`,
      policy: a.policy_inserted,
    });
  }
  for (const r of diff.removed) {
    lines.push({ kind: "removed", stepId: r.step_id, text: `Removed ${stepKindLabel(r.kind).toLowerCase()} step “${r.title}”` });
  }
  for (const c of diff.changed) {
    lines.push({
      kind: "changed",
      stepId: c.step_id,
      text: `Changed “${c.title}”`,
      detail: c.fields.map((f) => `${fieldLabel(f.field)}: ${plainValue(f.field, f.before)} → ${plainValue(f.field, f.after)}`),
    });
  }
  if (diff.reordered) lines.push({ kind: "info", text: "The order of steps changed" });
  if (diff.trigger_changed) lines.push({ kind: "info", text: "How the workflow starts changed" });
  if (diff.inputs_added.length) lines.push({ kind: "added", text: `New information requested: ${diff.inputs_added.join(", ")}` });
  if (diff.inputs_removed.length) lines.push({ kind: "removed", text: `No longer requested: ${diff.inputs_removed.join(", ")}` });
  if (diff.title_changed) lines.push({ kind: "info", text: "The workflow was renamed" });
  if (diff.settings_changed) lines.push({ kind: "info", text: "Run limits changed" });
  if (diff.layout_only) lines.push({ kind: "info", text: "Only the diagram layout changed" });
  return lines;
}

export function diffIsEmpty(diff: PlanDiff | null | undefined): boolean {
  return diffLines(diff).length === 0;
}
