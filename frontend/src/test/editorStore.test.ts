import { beforeEach, describe, expect, it } from "vitest";
import type { ConditionNodeConfig, WorkflowDefinition } from "@/types";
import { HISTORY_LIMIT, useEditorStore } from "@/workflow/editor/store";

const def: WorkflowDefinition = {
  nodes: [{ id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Start", config: {} } }],
  edges: [],
  settings: { max_loop_iterations: 5, max_total_steps: 100, max_duration_seconds: 3600 },
};

const st = () => useEditorStore.getState();

describe("editor store: undo/redo", () => {
  beforeEach(() => {
    st().load({ id: "wf", name: "WF", description: "", version: 1, definition: def });
  });

  it("starts clean", () => {
    expect(st().dirty).toBe(false);
    expect(st().canUndo()).toBe(false);
    expect(st().nodes.map((n) => n.id)).toEqual(["start"]);
  });

  it("undoes and redoes node additions and connections", () => {
    const a = st().addNode({ type: "agent" }, { x: 100, y: 0 });
    expect(a).toBe("agent_1");
    st().onConnect({ source: "start", target: a, sourceHandle: "out", targetHandle: "in" });
    expect(st().edges).toHaveLength(1);
    expect(st().dirty).toBe(true);

    st().undo();
    expect(st().edges).toHaveLength(0);
    expect(st().nodes).toHaveLength(2);
    st().undo();
    expect(st().nodes).toHaveLength(1);
    expect(st().canUndo()).toBe(false);

    st().redo();
    st().redo();
    expect(st().nodes).toHaveLength(2);
    expect(st().edges).toHaveLength(1);
    expect(st().canRedo()).toBe(false);
  });

  it("a new edit clears the redo stack", () => {
    st().addNode({ type: "end" }, { x: 0, y: 0 });
    st().undo();
    expect(st().canRedo()).toBe(true);
    st().addNode({ type: "fail" }, { x: 0, y: 0 });
    expect(st().canRedo()).toBe(false);
  });

  it("coalesces rapid typing into one undo step", () => {
    st().updateNodeData("start", { label: "S" });
    st().updateNodeData("start", { label: "St" });
    st().updateNodeData("start", { label: "Sta" });
    expect(st().past).toHaveLength(1);
    st().undo();
    expect(st().nodes[0]!.data.label).toBe("Start");
  });

  it("bounds the history", () => {
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) st().addNode({ type: "delay" }, { x: i, y: 0 });
    expect(st().past.length).toBe(HISTORY_LIMIT);
  });

  it("deleting a node removes its edges and is undoable", () => {
    const a = st().addNode({ type: "agent" }, { x: 0, y: 0 });
    st().onConnect({ source: "start", target: a, sourceHandle: null, targetHandle: null });
    st().deleteElements([a], []);
    expect(st().edges).toHaveLength(0);
    st().undo();
    expect(st().edges).toHaveLength(1);
    expect(st().edges[0]!.sourceHandle).toBe("out");
  });

  it("renames node keys with validation and rewires edges", () => {
    const a = st().addNode({ type: "agent" }, { x: 0, y: 0 });
    st().onConnect({ source: "start", target: a, sourceHandle: "out", targetHandle: "in" });
    expect(st().renameNode(a, "Bad Key")).toMatchObject({ ok: false });
    expect(st().renameNode(a, "start")).toMatchObject({ ok: false });
    expect(st().renameNode(a, "planner")).toEqual({ ok: true });
    expect(st().edges[0]!.target).toBe("planner");
    st().undo();
    expect(st().edges[0]!.target).toBe(a);
  });

  it("copy/paste duplicates selection with fresh ids and internal edges", () => {
    const a = st().addNode({ type: "agent" }, { x: 0, y: 0 });
    const c = st().addNode({ type: "condition" }, { x: 200, y: 0 });
    st().onConnect({ source: a, target: c, sourceHandle: "out", targetHandle: "in" });
    st().selectOnly([a, c]);
    expect(st().copySelection()).toBe(2);
    expect(st().paste()).toBe(2);
    const ids = st().nodes.map((n) => n.id);
    expect(ids).toEqual(["start", "agent_1", "condition_1", "agent_2", "condition_2"]);
    expect(st().edges.map((e) => [e.source, e.target])).toContainEqual(["agent_2", "condition_2"]);
    expect(st().nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(["agent_2", "condition_2"]);
    st().undo();
    expect(st().nodes).toHaveLength(3);
  });

  it("keeps condition edges when a branch handle is renamed and drops them when removed", () => {
    const c = st().addNode({ type: "condition" }, { x: 0, y: 0 });
    const e = st().addNode({ type: "end" }, { x: 200, y: 0 });
    st().onConnect({ source: c, target: e, sourceHandle: "true", targetHandle: "in" });
    st().onConnect({ source: c, target: e, sourceHandle: "false", targetHandle: "in" });
    const cfg = st().nodes.find((n) => n.id === c)!.data.config as ConditionNodeConfig;
    st().updateNodeConfig(c, { ...cfg, branches: [{ ...cfg.branches[0]!, handle: "passed" }] });
    expect(st().edges.map((x) => x.sourceHandle).sort()).toEqual(["false", "passed"]);
    st().updateNodeConfig(c, { ...cfg, branches: [] });
    expect(st().edges.map((x) => x.sourceHandle)).toEqual(["false"]);
  });

  it("auto-layout positions nodes left to right", () => {
    const a = st().addNode({ type: "agent" }, { x: 0, y: 0 });
    const e = st().addNode({ type: "end" }, { x: 0, y: 0 });
    st().onConnect({ source: "start", target: a, sourceHandle: "out", targetHandle: "in" });
    st().onConnect({ source: a, target: e, sourceHandle: "out", targetHandle: "in" });
    st().layout();
    const x = (id: string) => st().nodes.find((n) => n.id === id)!.position.x;
    expect(x("start")).toBeLessThan(x(a));
    expect(x(a)).toBeLessThan(x(e));
  });

  it("maps validation issues to nodes and edges", () => {
    st().setValidation({
      valid: false,
      errors: [
        { code: "x", message: "bad node", node_id: "start" },
        { code: "y", message: "bad edge", edge_id: "e9" },
      ],
      warnings: [],
    });
    expect(st().invalidNodes).toEqual({ start: ["bad node"] });
    expect(st().invalidEdges).toEqual({ e9: ["bad edge"] });
  });
});
