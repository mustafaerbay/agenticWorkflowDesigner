import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@/types";
import {
  definitionToFlow,
  flowToDefinition,
  generateEdgeId,
  generateNodeId,
  isValidNodeId,
  toNodeIdBase,
} from "@/workflow/serialization";

const def: WorkflowDefinition = {
  nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Start", config: { default_input: { requirement: "x" } } } },
    {
      id: "testing_agent",
      type: "agent",
      position: { x: 300, y: 10 },
      data: { label: "Testing", config: { kind: "scripted", tools: ["run_tests"], steps: [{ tool: "run_tests", args: {} }] } },
    },
    {
      id: "gate",
      type: "condition",
      position: { x: 600, y: 0 },
      data: {
        label: "Tests passed?",
        config: {
          branches: [{ handle: "true", label: "True", rule: { op: "is_true", left: { ref: "testing_agent.output.passed" } } }],
          default_handle: "false",
        },
      },
    },
    { id: "review", type: "approval", position: { x: 900, y: 0 }, data: { label: "Review", config: { title: "Ship?" } } },
    { id: "done", type: "end", position: { x: 1200, y: 0 }, data: { label: "Done", config: {} } },
  ],
  edges: [
    { id: "e1", source: "start", target: "testing_agent", sourceHandle: "out", targetHandle: "in" },
    { id: "e2", source: "testing_agent", target: "gate", sourceHandle: "out", targetHandle: "in" },
    { id: "e3", source: "gate", target: "review", sourceHandle: "true", targetHandle: "in", label: "ok" },
    { id: "e4", source: "gate", target: "testing_agent", sourceHandle: "false", targetHandle: "in" },
    { id: "e5", source: "review", target: "done", sourceHandle: "approved", targetHandle: "in" },
  ],
  settings: { max_loop_iterations: 3, max_total_steps: 50, max_duration_seconds: 600 },
};

describe("definition serialization", () => {
  it("round-trips contract definition <-> React Flow", () => {
    const { nodes, edges, settings } = definitionToFlow(def);
    expect(nodes).toHaveLength(5);
    expect(edges.every((e) => e.type === "workflow" && e.targetHandle === "in")).toBe(true);
    expect(flowToDefinition(nodes, edges, settings)).toEqual(def);
  });

  it("strips UI-only state (selection, measurements, runtime, classes)", () => {
    const { nodes, edges, settings } = definitionToFlow(def);
    const dirtyNodes = nodes.map((n) => ({
      ...n,
      selected: true,
      dragging: false,
      measured: { width: 240, height: 80 },
      className: "node-invalid",
      position: { x: n.position.x + 0.4, y: n.position.y - 0.4 },
    }));
    const dirtyEdges = edges.map((e) => ({ ...e, selected: true, animated: true, className: "edge-invalid" }));
    expect(flowToDefinition(dirtyNodes, dirtyEdges, settings)).toEqual(def);
  });

  it("defaults sourceHandle to out and fills default settings", () => {
    const flow = definitionToFlow({
      nodes: def.nodes.slice(0, 2),
      edges: [{ id: "x", source: "start", target: "testing_agent", sourceHandle: "", targetHandle: "in" }],
      settings: undefined as unknown as WorkflowDefinition["settings"],
    });
    expect(flow.edges[0]!.sourceHandle).toBe("out");
    expect(flow.settings).toEqual({ max_loop_iterations: 5, max_total_steps: 100, max_duration_seconds: 3600 });
  });

  it("does not share config objects between definition and flow", () => {
    const { nodes, edges, settings } = definitionToFlow(def);
    (nodes[1]!.data.config as { tools: string[] }).tools.push("hack");
    expect((def.nodes[1]!.data.config as { tools: string[] }).tools).toEqual(["run_tests"]);
    const out = flowToDefinition(nodes, edges, settings);
    (out.nodes[1]!.data.config as { tools: string[] }).tools.push("again");
    expect((nodes[1]!.data.config as { tools: string[] }).tools).toEqual(["run_tests", "hack"]);
  });

  it("generates contract-valid ids", () => {
    expect(generateNodeId("agent", ["agent_1", "agent_2"])).toBe("agent_3");
    expect(generateNodeId("condition", [])).toBe("condition_1");
    expect(generateNodeId("testing_agent", [], true)).toBe("testing_agent");
    expect(generateNodeId("testing_agent", ["testing_agent"], true)).toBe("testing_agent_1");
    expect(toNodeIdBase("Code Review Agent!")).toBe("code_review_agent");
    expect(toNodeIdBase("42 things")).toBe("n_42_things");
    for (const id of [generateNodeId("Hello World", []), toNodeIdBase("ÄÖÜ"), generateNodeId("9lives", [])]) {
      expect(isValidNodeId(id)).toBe(true);
    }
    expect(isValidNodeId("Bad")).toBe(false);
    expect(isValidNodeId("a".repeat(65))).toBe(false);
    expect(generateEdgeId(["e1", "e3"])).toBe("e2");
  });
});
