import { isPlainObject, parseJson } from "@/lib/utils";
import type { BusinessPlan, JSONObject, JSONValue, PlanInput, SimulateRequest, WorkflowDefinition } from "@/types";

/** Raw form values: strings for text/number/date/email/file(id)/list(comma separated), booleans for checkboxes. */
export type InputValues = Record<string, string | boolean>;

export function initialInputValues(inputs: PlanInput[]): InputValues {
  const out: InputValues = {};
  for (const i of inputs) {
    const ex = i.example;
    if (i.type === "boolean") out[i.key] = ex === true;
    else if (i.type === "file") out[i.key] = "";
    else if (Array.isArray(ex)) out[i.key] = ex.map(String).join(", ");
    else out[i.key] = ex === undefined || ex === null ? "" : String(ex);
  }
  return out;
}

export function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Convert form values into a run input object. Blank optional values are omitted. */
export function coerceInputs(inputs: PlanInput[], values: InputValues): { input: JSONObject; missing: string[]; invalid: string[] } {
  const input: JSONObject = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const i of inputs) {
    const raw = values[i.key];
    if (i.type === "boolean") {
      input[i.key] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) {
      if (i.required) missing.push(i.label || i.key);
      continue;
    }
    if (i.type === "number") {
      const n = Number(text);
      if (!Number.isFinite(n)) invalid.push(i.label || i.key);
      else input[i.key] = n;
    } else if (i.type === "list") {
      input[i.key] = splitList(text);
    } else {
      input[i.key] = text;
    }
  }
  return { input, missing, invalid };
}

export type ApprovalChoice = "approve" | "reject";

export interface SimulationForm {
  values: InputValues;
  approvals: Record<string, ApprovalChoice>;
  /** Raw JSON text per step id: "pretend this step returns…" (blank = use the sample) */
  stepOutputs: Record<string, string>;
}

export type SimulationBuild = { ok: true; body: SimulateRequest } | { ok: false; error: string };

/** Build the POST /workflows/{id}/simulate body from the simulation form. */
export function buildSimulationRequest(plan: BusinessPlan, form: SimulationForm): SimulationBuild {
  const { input, missing, invalid } = coerceInputs(plan.inputs, form.values);
  if (missing.length) return { ok: false, error: `Please fill in: ${missing.join(", ")}` };
  if (invalid.length) return { ok: false, error: `Enter a number for: ${invalid.join(", ")}` };

  const approvals: Record<string, ApprovalChoice> = {};
  for (const step of plan.steps) {
    if (step.kind === "approval") approvals[step.id] = form.approvals[step.id] ?? "approve";
  }

  const stepOutputs: Record<string, JSONObject> = {};
  for (const [stepId, text] of Object.entries(form.stepOutputs)) {
    if (!text.trim()) continue;
    const r = parseJson<JSONValue>(text);
    const title = plan.steps.find((s) => s.id === stepId)?.title ?? stepId;
    if (!r.ok) return { ok: false, error: `“${title}”: the pretend result is not valid. ${r.error}` };
    if (!isPlainObject(r.value)) return { ok: false, error: `“${title}”: the pretend result must be an object like {"field": "value"}` };
    stepOutputs[stepId] = r.value as JSONObject;
  }

  const body: SimulateRequest = { input };
  if (Object.keys(approvals).length) body.approvals = approvals;
  if (Object.keys(stepOutputs).length) body.step_outputs = stepOutputs;
  return { ok: true, body };
}

/** Plan inputs, or (for workflows without a plan in hand) the Start node's input schema. */
export function planInputsOf(plan: BusinessPlan | null | undefined, def: WorkflowDefinition | null | undefined): PlanInput[] {
  if (plan) return plan.inputs;
  const start = def?.nodes.find((n) => n.type === "start");
  const schema = (start?.data.config as { input_schema?: JSONObject } | undefined)?.input_schema;
  const props = schema && isPlainObject(schema.properties) ? (schema.properties as Record<string, JSONObject>) : {};
  const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
  return Object.entries(props).map(([key, p]) => ({
    key,
    label: typeof p.title === "string" ? p.title : key,
    type: (typeof p["x-input-type"] === "string" ? p["x-input-type"] : "string") as PlanInput["type"],
    required: required.includes(key),
    description: typeof p.description === "string" ? p.description : "",
  }));
}
