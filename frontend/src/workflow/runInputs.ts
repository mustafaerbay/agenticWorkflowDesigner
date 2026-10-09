import type { ToolInfo, WorkflowDefinition } from "@/types";

/** Run-input fields a workflow reads via `input.*`, derived from its definition. */
export interface RunInputSpec {
  /** Bound to a required tool argument (or required by the Start input schema). */
  required: string[];
  /** Referenced somewhere, but not required. */
  optional: string[];
  /** Start node default_input with an empty value added for every missing required field. */
  prefill: Record<string, unknown>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const TEMPLATE = /\{\{\s*input\.([A-Za-z0-9_-]+)/g;

function inputKey(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const m = /^input\.([A-Za-z0-9_-]+)/.exec(ref);
  return m ? m[1] : null;
}

/** Walk any JSON value, collecting `{"ref": "input.x"}` objects, rule operands and `{{input.x}}` templates. */
function collect(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(TEMPLATE)) into.add(m[1]);
    return;
  }
  if (Array.isArray(value)) return value.forEach((v) => collect(v, into));
  if (!isObj(value)) return;
  const key = "ref" in value ? inputKey(value.ref) : null;
  if (key) into.add(key);
  for (const v of Object.values(value)) collect(v, into);
}

/** Required args bound directly to an input ref: {"repo_url": {"ref": "input.repo_url"}}. */
function requiredFromArgs(tool: ToolInfo | undefined, args: unknown, into: Set<string>): void {
  if (!tool || !isObj(args)) return;
  const required = Array.isArray(tool.parameters.required) ? (tool.parameters.required as string[]) : [];
  for (const name of required) {
    const bound = args[name];
    const key = isObj(bound) ? inputKey(bound.ref) : null;
    if (key) into.add(key);
  }
}

export function runInputSpec(def: WorkflowDefinition | null | undefined, tools: ToolInfo[] = []): RunInputSpec {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const referenced = new Set<string>();
  const required = new Set<string>();
  let defaults: Obj = {};

  for (const node of def?.nodes ?? []) {
    const config = (node.data?.config ?? {}) as Obj;
    if (node.type === "start") {
      if (isObj(config.default_input)) defaults = config.default_input;
      const schema = isObj(config.input_schema) ? config.input_schema : {};
      if (Array.isArray(schema.required)) schema.required.forEach((k) => typeof k === "string" && required.add(k));
      if (isObj(schema.properties)) Object.keys(schema.properties).forEach((k) => referenced.add(k));
      continue;
    }
    collect(config, referenced);
    if (node.type === "tool") requiredFromArgs(byName.get(String(config.tool)), config.args, required);
    if (node.type === "agent" && Array.isArray(config.steps)) {
      for (const step of config.steps) {
        if (isObj(step)) requiredFromArgs(byName.get(String(step.tool)), step.args, required);
      }
    }
  }

  const prefill: Obj = { ...defaults };
  for (const key of required) if (!(key in prefill)) prefill[key] = "";
  return {
    required: [...required].sort(),
    optional: [...referenced].filter((k) => !required.has(k)).sort(),
    prefill,
  };
}

/** Required fields that are absent, null or blank in the given input. */
export function missingRequired(spec: RunInputSpec, input: Obj): string[] {
  return spec.required.filter((k) => {
    const v = input[k];
    return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  });
}
