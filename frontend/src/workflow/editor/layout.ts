import dagre from "@dagrejs/dagre";
import type { FlowEdge, FlowNode } from "../types";

export const DEFAULT_NODE_WIDTH = 240;
export const DEFAULT_NODE_HEIGHT = 84;

/** Left-to-right layered layout using dagre. Returns new node objects with updated positions. */
export function autoLayout(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 48, ranksep: 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    const width = n.measured?.width ?? n.width ?? DEFAULT_NODE_WIDTH;
    const height = n.measured?.height ?? n.height ?? DEFAULT_NODE_HEIGHT;
    g.setNode(n.id, { width, height });
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    if (ids.has(e.source) && ids.has(e.target)) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id) as { x: number; y: number; width: number; height: number } | undefined;
    if (!p) return n;
    return { ...n, position: { x: Math.round(p.x - p.width / 2), y: Math.round(p.y - p.height / 2) } };
  });
}
