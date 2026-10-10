import type { BusinessPlan, Capability, CapabilityField, JSONValue, PlanOperation, PlanStep } from "@/types";
import { splitList } from "./inputs";

/** Editable draft of one step in the "Edit steps" editor. */
export interface StepDraft {
  title: string;
  description: string;
  /** Literal params as text (lists comma separated). Params bound to other data are not editable. */
  params: Record<string, string>;
  instructions: string;
  /** Max attempts as text ("" = unchanged / none). */
  retry: string;
}

export type ParamKind = "text" | "number" | "list";

export function paramKind(field: CapabilityField | undefined, value: JSONValue | undefined): ParamKind {
  if (Array.isArray(value) || field?.type === "list" || field?.type === "array") return "list";
  if (typeof value === "number" || field?.type === "number" || field?.type === "integer") return "number";
  return "text";
}

/** A param is editable here when it is a plain value (not taken from the request or another step). */
export function isLiteralParam(value: JSONValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  return Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number");
}

function paramText(value: JSONValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
}

export function editableParamFields(step: PlanStep, capability: Capability | undefined): CapabilityField[] {
  if (step.kind !== "action" || !capability) return [];
  return capability.inputs.filter((f) => isLiteralParam(step.params[f.key]));
}

export function draftFor(step: PlanStep, capability: Capability | undefined): StepDraft {
  const params: Record<string, string> = {};
  for (const f of editableParamFields(step, capability)) params[f.key] = paramText(step.kind === "action" ? step.params[f.key] : undefined);
  return {
    title: step.title,
    description: step.description ?? "",
    params,
    instructions: step.kind === "approval" ? step.instructions ?? "" : "",
    retry: step.kind === "action" && step.retry ? String(step.retry.max_attempts) : "",
  };
}

function parseParam(kind: ParamKind, text: string): JSONValue | null {
  const t = text.trim();
  if (!t) return null;
  if (kind === "list") return splitList(t);
  if (kind === "number") {
    const n = Number(t);
    return Number.isFinite(n) ? n : t;
  }
  return t;
}

/** Typed plan operations for the edits made in the "Edit steps" editor (only what changed). */
export function stepEditOperations(
  plan: BusinessPlan,
  drafts: Record<string, StepDraft>,
  capabilities: Capability[],
): PlanOperation[] {
  const ops: PlanOperation[] = [];
  for (const step of plan.steps) {
    const d = drafts[step.id];
    if (!d) continue;
    const update: PlanOperation = { op: "update_step", step_id: step.id };
    let changed = false;
    if (d.title.trim() && d.title.trim() !== step.title) {
      update.title = d.title.trim();
      changed = true;
    }
    if (d.description.trim() !== (step.description ?? "").trim()) {
      update.description = d.description.trim();
      changed = true;
    }
    if (step.kind === "approval" && d.instructions.trim() !== (step.instructions ?? "").trim()) {
      update.instructions = d.instructions.trim();
      changed = true;
    }
    if (step.kind === "action") {
      const cap = capabilities.find((c) => c.id === step.capability);
      const params: Record<string, JSONValue> = {};
      for (const f of editableParamFields(step, cap)) {
        const before = step.params[f.key];
        const text = d.params[f.key] ?? "";
        if (text.trim() === paramText(before).trim()) continue;
        // null removes the param (operations contract: null values remove a param)
        params[f.key] = parseParam(paramKind(f, before), text);
      }
      if (Object.keys(params).length) {
        update.params = params;
        changed = true;
      }
    }
    if (changed) ops.push(update);
    if (step.kind === "action") {
      const retry = Number(d.retry.trim());
      const before = step.retry?.max_attempts ?? null;
      if (d.retry.trim() && Number.isInteger(retry) && retry >= 1 && retry !== before) {
        ops.push({
          op: "set_retry",
          step_id: step.id,
          max_attempts: Math.min(10, retry),
          backoff_seconds: step.retry?.backoff_seconds ?? 5,
        });
      }
    }
  }
  return ops;
}
