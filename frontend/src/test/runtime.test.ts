import { describe, expect, it } from "vitest";
import type { NodeRun, Run } from "@/types";
import { buildExecutionGraph, buildRuntime } from "@/workflow/execution/runtime";

const nr = (p: Partial<NodeRun>): NodeRun => ({
  id: Math.random().toString(36),
  node_id: "a",
  node_type: "agent",
  label: "A",
  iteration: 1,
  attempt: 1,
  status: "COMPLETED",
  input: null,
  output: null,
  error: null,
  selected_handle: null,
  started_at: "2026-01-01T00:00:00Z",
  finished_at: "2026-01-01T00:00:02Z",
  duration_ms: 2000,
  logs: [],
  tool_calls: [],
  usage: null,
  agent_kind: "llm",
  model: "m",
  ...p,
});

describe("execution runtime overlay", () => {
  it("uses the latest (iteration, attempt) node run", () => {
    const rt = buildRuntime(
      [nr({ iteration: 2, attempt: 1, status: "FAILED", error: "boom" }), nr({ iteration: 1 }), nr({ iteration: 2, attempt: 2, status: "RUNNING", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, logs: [{ ts: "", level: "info", message: "thinking" }] })].sort((a, b) => a.iteration - b.iteration || a.attempt - b.attempt),
      undefined,
    );
    expect(rt.status).toBe("RUNNING");
    expect(rt.runs).toBe(2);
    expect(rt.totalTokens).toBe(3);
    expect(rt.progress).toBe("thinking");
    expect(buildRuntime(undefined, "live").progress).toBe("live");
    expect(buildRuntime([], undefined).status).toBe("PENDING");
  });

  it("marks fired edges from selected handles and traversed edges from events", () => {
    const run = {
      definition: {
        nodes: [
          { id: "c", type: "condition", position: { x: 0, y: 0 }, data: { label: "C", config: { branches: [], default_handle: "false" } } },
          { id: "x", type: "end", position: { x: 0, y: 0 }, data: { label: "X", config: {} } },
          { id: "y", type: "fail", position: { x: 0, y: 0 }, data: { label: "Y", config: {} } },
        ],
        edges: [
          { id: "t", source: "c", target: "x", sourceHandle: "true", targetHandle: "in" },
          { id: "f", source: "c", target: "y", sourceHandle: "false", targetHandle: "in" },
        ],
        settings: { max_loop_iterations: 5, max_total_steps: 100, max_duration_seconds: 3600 },
      },
      node_runs: [nr({ node_id: "c", node_type: "condition", selected_handle: "true" }), nr({ node_id: "y", status: "SKIPPED" })],
    } as unknown as Run;
    const g = buildExecutionGraph(run, {}, new Set(["f"]));
    const t = g.edges.find((e) => e.id === "t")!;
    const f = g.edges.find((e) => e.id === "f")!;
    expect(t.data?.fired).toBe(true);
    expect(f.data?.fired).toBe(false);
    expect(f.animated).toBe(true);
    expect(g.nodes.find((n) => n.id === "y")!.data.runtime!.status).toBe("SKIPPED");
    expect(g.nodes.find((n) => n.id === "x")!.data.runtime!.status).toBe("PENDING");
    expect(g.nodes.every((n) => n.draggable === false)).toBe(true);
  });
});
