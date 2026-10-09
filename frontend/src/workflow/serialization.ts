import type {
  AnyNodeConfig,
  NodeType,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowSettings,
} from "@/types";
import { NODE_ID_PATTERN, NODE_TYPES } from "@/types";
import { DEFAULT_SETTINGS } from "./nodeMeta";
import type { FlowEdge, FlowNode } from "./types";

/** Deep clone that drops `undefined` values (JSON semantics). */
export function cloneJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function isNodeType(t: unknown): t is NodeType {
  return typeof t === "string" && (NODE_TYPES as readonly string[]).includes(t);
}

/** Contract definition -> React Flow nodes/edges. */
export function definitionToFlow(def: WorkflowDefinition | null | undefined): {
  nodes: FlowNode[];
  edges: FlowEdge[];
  settings: WorkflowSettings;
} {
  const nodes: FlowNode[] = (def?.nodes ?? []).filter((n) => isNodeType(n.type)).map((n) => {
    const node: FlowNode = {
      id: n.id,
      type: n.type,
      position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
      data: {
        label: n.data?.label ?? n.id,
        config: cloneJson((n.data?.config ?? {}) as AnyNodeConfig),
      },
    };
    if (n.data?.description) node.data.description = n.data.description;
    if (n.type === "start") node.deletable = true;
    return node;
  });
  const edges: FlowEdge[] = (def?.edges ?? []).map((e) => {
    const edge: FlowEdge = {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle || "out",
      targetHandle: "in",
      type: "workflow",
      data: {},
    };
    if (e.label) edge.data = { label: e.label };
    return edge;
  });
  return { nodes, edges, settings: { ...DEFAULT_SETTINGS, ...(def?.settings ?? {}) } };
}

/** React Flow nodes/edges -> contract definition (strips all UI-only state). */
export function flowToDefinition(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  settings: WorkflowSettings,
): WorkflowDefinition {
  const outNodes: WorkflowNode[] = nodes.map((n) => {
    const data: WorkflowNode["data"] = {
      label: n.data.label,
      config: cloneJson(n.data.config ?? {}) as AnyNodeConfig,
    };
    if (n.data.description) data.description = n.data.description;
    return {
      id: n.id,
      type: n.type as NodeType,
      position: { x: Math.round(n.position.x) || 0, y: Math.round(n.position.y) || 0 },
      data,
    };
  });
  const outEdges: WorkflowEdge[] = edges.map((e) => {
    const edge: WorkflowEdge = {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle || "out",
      targetHandle: "in",
    };
    const label = e.data?.label;
    if (typeof label === "string" && label.trim()) edge.label = label;
    return edge;
  });
  return {
    nodes: outNodes,
    edges: outEdges,
    settings: {
      max_loop_iterations: settings.max_loop_iterations,
      max_total_steps: settings.max_total_steps,
      max_duration_seconds: settings.max_duration_seconds,
    },
  };
}

export function emptyDefinition(): WorkflowDefinition {
  return {
    nodes: [
      {
        id: "start",
        type: "start",
        position: { x: 0, y: 0 },
        data: { label: "Start", config: { default_input: {} } },
      },
    ],
    edges: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

export function isValidNodeId(id: string): boolean {
  return NODE_ID_PATTERN.test(id);
}

/** Sanitize an arbitrary string into a node-id base, e.g. "Code Review" -> "code_review". */
export function toNodeIdBase(raw: string): string {
  let s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s || !/^[a-z]/.test(s)) s = `n_${s}`.replace(/_+$/, "") || "node";
  return s.slice(0, 56);
}

/**
 * Generate a unique node id like `agent_1`, `condition_2`.
 * If `preferBare` is set and `base` is free, the bare base is used (e.g. `testing_agent`).
 */
export function generateNodeId(base: string, existing: Iterable<string>, preferBare = false): string {
  const taken = new Set(existing);
  const b = toNodeIdBase(base);
  if (preferBare && !taken.has(b)) return b;
  for (let i = 1; ; i++) {
    const candidate = `${b}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function generateEdgeId(existing: Iterable<string>): string {
  const taken = new Set(existing);
  for (let i = 1; ; i++) {
    const candidate = `e${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Find the start node's default_input (used to prefill run dialogs). */
export function defaultInputOf(def: WorkflowDefinition | null | undefined): Record<string, unknown> {
  const start = def?.nodes.find((n) => n.type === "start");
  const di = (start?.data.config as { default_input?: Record<string, unknown> } | undefined)?.default_input;
  return di && typeof di === "object" ? di : {};
}
