"""Static analysis of a workflow definition: adjacency, back edges, cycles."""

from dataclasses import dataclass, field
from typing import Any

NODE_TYPES = {
    "start",
    "agent",
    "condition",
    "tool",
    "parallel",
    "join",
    "approval",
    "delay",
    "end",
    "fail",
}
INLINE_TYPES = {"start", "condition", "parallel", "join", "approval", "delay", "end", "fail"}
WORKER_TYPES = {"agent", "tool"}
TERMINAL_TYPES = {"end", "fail"}


def source_handles(node: dict[str, Any]) -> list[str]:
    ntype = node.get("type")
    config = (node.get("data") or {}).get("config") or {}
    if ntype in TERMINAL_TYPES:
        return []
    if ntype == "condition":
        handles = [b.get("handle") for b in config.get("branches") or [] if b.get("handle")]
        default = config.get("default_handle") or "false"
        return [*handles, default]
    if ntype == "approval":
        return ["approved", "rejected"]
    if ntype in ("agent", "tool"):
        return ["out", "error"]  # "error" is taken only after retries are exhausted
    return ["out"]


@dataclass
class Graph:
    nodes: dict[str, dict[str, Any]]
    edges: dict[str, dict[str, Any]]
    outgoing: dict[str, list[str]] = field(default_factory=dict)
    incoming: dict[str, list[str]] = field(default_factory=dict)
    back_edges: set[str] = field(default_factory=set)
    reachable: set[str] = field(default_factory=set)
    start_id: str | None = None

    @classmethod
    def from_definition(cls, definition: dict[str, Any]) -> "Graph":
        nodes = {n["id"]: n for n in definition.get("nodes") or [] if isinstance(n, dict) and "id" in n}
        edges = {e["id"]: e for e in definition.get("edges") or [] if isinstance(e, dict) and "id" in e}
        g = cls(nodes=nodes, edges=edges)
        g.outgoing = {nid: [] for nid in nodes}
        g.incoming = {nid: [] for nid in nodes}
        for eid, edge in edges.items():
            if edge.get("source") in nodes and edge.get("target") in nodes:
                g.outgoing[edge["source"]].append(eid)
                g.incoming[edge["target"]].append(eid)
        starts = [nid for nid, n in nodes.items() if n.get("type") == "start"]
        g.start_id = starts[0] if len(starts) == 1 else None
        if g.start_id:
            g._dfs(g.start_id)
        return g

    def _dfs(self, start: str) -> None:
        """Iterative DFS from start; edges into a node on the stack are back edges."""
        on_stack: set[str] = set()
        visited: set[str] = set()
        stack: list[tuple[str, int]] = [(start, 0)]
        on_stack.add(start)
        visited.add(start)
        while stack:
            node_id, idx = stack[-1]
            out = self.outgoing[node_id]
            if idx < len(out):
                stack[-1] = (node_id, idx + 1)
                edge = self.edges[out[idx]]
                target = edge["target"]
                if target in on_stack:
                    self.back_edges.add(out[idx])
                elif target not in visited:
                    visited.add(target)
                    on_stack.add(target)
                    stack.append((target, 0))
            else:
                stack.pop()
                on_stack.discard(node_id)
        self.reachable = visited

    def forward_incoming(self, node_id: str) -> list[str]:
        return [e for e in self.incoming.get(node_id, []) if e not in self.back_edges]

    def node_type(self, node_id: str) -> str:
        return str(self.nodes[node_id].get("type"))

    def config(self, node_id: str) -> dict[str, Any]:
        return (self.nodes[node_id].get("data") or {}).get("config") or {}

    def label(self, node_id: str) -> str:
        return str((self.nodes[node_id].get("data") or {}).get("label") or node_id)

    def edges_from_handle(self, node_id: str, handle: str | None) -> list[str]:
        result = []
        for eid in self.outgoing.get(node_id, []):
            edge_handle = self.edges[eid].get("sourceHandle") or "out"
            if handle is None or edge_handle == handle:
                result.append(eid)
        return result

    def strongly_connected_components(self) -> list[set[str]]:
        """Tarjan's algorithm (iterative). Returns only non-trivial SCCs (cycles)."""
        index_of: dict[str, int] = {}
        low: dict[str, int] = {}
        on_stack: set[str] = set()
        stack: list[str] = []
        result: list[set[str]] = []
        counter = 0
        for root in self.nodes:
            if root in index_of:
                continue
            work: list[tuple[str, int]] = [(root, 0)]
            while work:
                v, i = work[-1]
                if i == 0:
                    index_of[v] = low[v] = counter
                    counter += 1
                    stack.append(v)
                    on_stack.add(v)
                succ = [self.edges[e]["target"] for e in self.outgoing[v]]
                if i < len(succ):
                    work[-1] = (v, i + 1)
                    w = succ[i]
                    if w not in index_of:
                        work.append((w, 0))
                    elif w in on_stack:
                        low[v] = min(low[v], index_of[w])
                    continue
                work.pop()
                if work:
                    parent = work[-1][0]
                    low[parent] = min(low[parent], low[v])
                if low[v] == index_of[v]:
                    comp: set[str] = set()
                    while True:
                        w = stack.pop()
                        on_stack.discard(w)
                        comp.add(w)
                        if w == v:
                            break
                    self_loop = any(self.edges[e]["target"] == v for e in self.outgoing[v])
                    if len(comp) > 1 or self_loop:
                        result.append(comp)
        return result
