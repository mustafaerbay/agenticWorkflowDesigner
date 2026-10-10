import type { Edge, Node } from "@xyflow/react";
import type { AnyNodeConfig, BusinessNodeInfo, NodeRun, NodeRunStatus, NodeType } from "@/types";

/** Runtime overlay shown on nodes in execution-monitoring mode. */
export interface NodeRuntime {
  status: NodeRunStatus;
  runs: number;
  latest: NodeRun | null;
  progress: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  totalTokens: number | null;
  error: string | null;
  agentKind: "llm" | "scripted" | null;
  model: string | null;
  /** Simulation runs: the output was a labelled sample, nothing was sent or changed. */
  simulated?: boolean;
  simulationNote?: string | null;
}

export interface FlowNodeData extends Record<string, unknown> {
  label: string;
  config: AnyNodeConfig;
  description?: string;
  business?: BusinessNodeInfo;
  runtime?: NodeRuntime;
}

export type FlowNode = Node<FlowNodeData, NodeType>;

export interface FlowEdgeData extends Record<string, unknown> {
  /** Explicit edge label from the definition (optional). */
  label?: string;
  /** execution mode: edge was just traversed (animate). */
  traversed?: boolean;
  /** execution mode: edge has fired at least once. */
  fired?: boolean;
}

export type FlowEdge = Edge<FlowEdgeData, "workflow">;
