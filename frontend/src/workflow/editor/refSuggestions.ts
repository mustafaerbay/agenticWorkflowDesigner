import type { AgentNodeConfig, JSONSchema, StartNodeConfig } from "@/types";
import type { FlowNode } from "../types";

function schemaProps(schema: JSONSchema | null | undefined): string[] {
  const props = schema && typeof schema === "object" ? (schema as { properties?: unknown }).properties : null;
  return props && typeof props === "object" ? Object.keys(props as object) : [];
}

/** Reference suggestions for condition operands / input mappings, built from the graph. */
export function buildRefSuggestions(nodes: readonly FlowNode[], excludeId?: string): string[] {
  const out = new Set<string>(["input.", "run.steps"]);
  const start = nodes.find((n) => n.type === "start");
  if (start) {
    const c = start.data.config as StartNodeConfig;
    for (const k of Object.keys(c.default_input ?? {})) out.add(`input.${k}`);
    for (const k of schemaProps(c.input_schema)) out.add(`input.${k}`);
  }
  for (const n of nodes) {
    if (n.id === excludeId || n.type === "start") continue;
    out.add(`${n.id}.output.`);
    if (n.type === "agent") {
      for (const k of schemaProps((n.data.config as AgentNodeConfig).output_schema)) out.add(`${n.id}.output.${k}`);
    }
    out.add(`${n.id}.status`);
    out.add(`${n.id}.runs`);
  }
  return [...out];
}
