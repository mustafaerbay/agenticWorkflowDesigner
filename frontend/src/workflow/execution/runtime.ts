import type { NodeRun, NodeRunStatus, Run } from "@/types";
import { definitionToFlow } from "../serialization";
import type { FlowEdge, FlowNode, NodeRuntime } from "../types";

/** Sort node runs chronologically by (iteration, attempt). */
export function sortRuns(runs: NodeRun[]): NodeRun[] {
  return [...runs].sort((a, b) => a.iteration - b.iteration || a.attempt - b.attempt);
}

export function groupRuns(run: Run | undefined): Map<string, NodeRun[]> {
  const m = new Map<string, NodeRun[]>();
  for (const nr of run?.node_runs ?? []) {
    const list = m.get(nr.node_id) ?? [];
    list.push(nr);
    m.set(nr.node_id, list);
  }
  for (const [k, v] of m) m.set(k, sortRuns(v));
  return m;
}

export function buildRuntime(runs: NodeRun[] | undefined, progress: string | undefined): NodeRuntime {
  const list = runs ?? [];
  const latest = list[list.length - 1] ?? null;
  const status: NodeRunStatus = latest?.status ?? "PENDING";
  const lastLog = latest?.logs?.[latest.logs.length - 1]?.message ?? null;
  const completedRuns = list.filter((r) => r.status === "COMPLETED").length;
  return {
    status,
    runs: Math.max(completedRuns, new Set(list.map((r) => r.iteration)).size),
    latest,
    progress: progress ?? lastLog,
    startedAt: latest?.started_at ?? null,
    finishedAt: latest?.finished_at ?? null,
    durationMs: latest?.duration_ms ?? null,
    totalTokens: latest?.usage?.total_tokens ?? null,
    error: latest?.error ?? null,
    agentKind: latest?.agent_kind ?? null,
    model: latest?.model ?? null,
  };
}

/** Did this edge fire, based on persisted node runs (server is the source of truth)? */
export function edgeFired(edge: FlowEdge, runsByNode: Map<string, NodeRun[]>): boolean {
  const runs = runsByNode.get(edge.source);
  if (!runs?.length) return false;
  const handle = edge.sourceHandle || "out";
  return runs.some(
    (r) => r.status === "COMPLETED" && (r.selected_handle ? r.selected_handle === handle : handle === "out"),
  );
}

/** Build monitoring-mode nodes/edges from a run's definition snapshot + node runs. */
export function buildExecutionGraph(
  run: Run,
  progressByNode: Record<string, string>,
  traversed: ReadonlySet<string>,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const { nodes, edges } = definitionToFlow(run.definition);
  const runsByNode = groupRuns(run);
  return {
    nodes: nodes.map((n) => ({
      ...n,
      draggable: false,
      connectable: false,
      deletable: false,
      data: { ...n.data, runtime: buildRuntime(runsByNode.get(n.id), progressByNode[n.id]) },
    })),
    edges: edges.map((e) => {
      const isTraversed = traversed.has(e.id);
      const fired = edgeFired(e, runsByNode);
      return {
        ...e,
        deletable: false,
        animated: isTraversed,
        className: isTraversed ? "edge-traversed" : fired ? "edge-fired" : undefined,
        data: { ...e.data, traversed: isTraversed, fired },
      };
    }),
  };
}
