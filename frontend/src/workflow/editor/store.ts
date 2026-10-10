import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type XYPosition,
} from "@xyflow/react";
import { create } from "zustand";
import type {
  AnyNodeConfig,
  ConditionNodeConfig,
  DefinitionMeta,
  Issue,
  NodeType,
  ValidationResult,
  Workflow,
  WorkflowDefinition,
  WorkflowSettings,
} from "@/types";
import { DEFAULT_SETTINGS, defaultConfig, NODE_META, sourceHandles } from "../nodeMeta";
import {
  cloneJson,
  definitionToFlow,
  flowToDefinition,
  generateEdgeId,
  generateNodeId,
  isValidNodeId,
} from "../serialization";
import type { FlowEdge, FlowNode } from "../types";
import { autoLayout } from "./layout";

export interface Snapshot {
  nodes: FlowNode[];
  edges: FlowEdge[];
  settings: WorkflowSettings;
}

export interface NewNodeSpec {
  type: NodeType;
  label?: string;
  config?: AnyNodeConfig;
  /** id base, e.g. "testing_agent"; preferBare picks the base itself when free */
  idBase?: string;
  preferBareId?: boolean;
}

export const HISTORY_LIMIT = 100;

interface Clipboard {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface EditorState {
  workflowId: string | null;
  name: string;
  description: string;
  version: number | null;
  /** Plan-based workflows: the definition's compiler metadata (round-tripped on save). */
  meta: DefinitionMeta | null;
  hasPlan: boolean;
  nodes: FlowNode[];
  edges: FlowEdge[];
  settings: WorkflowSettings;
  past: Snapshot[];
  future: Snapshot[];
  dirty: boolean;
  clipboard: Clipboard | null;
  validation: ValidationResult | null;
  /** node ids / edge ids with validation errors (highlighted red) */
  invalidNodes: Record<string, string[]>;
  invalidEdges: Record<string, string[]>;

  load: (wf: Pick<Workflow, "id" | "name" | "description" | "version" | "definition"> & Partial<Pick<Workflow, "has_plan">>) => void;
  /** Highlight nodes/edges with messages (e.g. unsupported edits) without a ValidationResult. */
  setHighlights: (nodes: Record<string, string[]>, edges?: Record<string, string[]>) => void;
  reset: () => void;
  markSaved: (wf: Pick<Workflow, "version" | "name" | "description">) => void;
  setName: (name: string) => void;
  setDescription: (d: string) => void;

  onNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<FlowEdge>[]) => void;
  onConnect: (c: Connection) => void;
  /** call when a drag starts so the move is a single undo step */
  beginDrag: () => void;

  addNode: (spec: NewNodeSpec, position: XYPosition) => string;
  updateNodeData: (id: string, patch: Partial<Pick<FlowNode["data"], "label" | "description">>) => void;
  updateNodeConfig: (id: string, config: AnyNodeConfig) => void;
  renameNode: (oldId: string, newId: string) => { ok: true } | { ok: false; error: string };
  updateEdgeLabel: (id: string, label: string) => void;
  deleteSelected: () => void;
  deleteElements: (nodeIds: string[], edgeIds: string[]) => void;
  selectOnly: (nodeIds: string[], edgeIds?: string[]) => void;
  copySelection: () => number;
  paste: (offset?: XYPosition) => number;
  setSettings: (s: Partial<WorkflowSettings>) => void;
  layout: () => void;

  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  setValidation: (v: ValidationResult | null) => void;
  getDefinition: () => WorkflowDefinition;
}

function snapshot(s: Pick<EditorState, "nodes" | "edges" | "settings">): Snapshot {
  // Strip selection/measurement flags so restore doesn't resurrect stale UI state.
  return {
    nodes: s.nodes.map((n) => ({ ...n, selected: false, dragging: false })),
    edges: s.edges.map((e) => ({ ...e, selected: false })),
    settings: { ...s.settings },
  };
}

function issuesBy(issues: Issue[], key: "node_id" | "edge_id"): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const i of issues) {
    const k = i[key];
    if (!k) continue;
    (out[k] ??= []).push(i.message);
  }
  return out;
}

const initial = {
  workflowId: null as string | null,
  name: "",
  description: "",
  version: null as number | null,
  meta: null as DefinitionMeta | null,
  hasPlan: false,
  nodes: [] as FlowNode[],
  edges: [] as FlowEdge[],
  settings: { ...DEFAULT_SETTINGS },
  past: [] as Snapshot[],
  future: [] as Snapshot[],
  dirty: false,
  validation: null as ValidationResult | null,
  invalidNodes: {} as Record<string, string[]>,
  invalidEdges: {} as Record<string, string[]>,
};

export const useEditorStore = create<EditorState>()((set, get) => {
  let lastKey: string | null = null;
  let lastAt = 0;
  /**
   * Push the current graph onto the undo stack, clear redo, mark dirty.
   * Rapid edits with the same `coalesceKey` (typing in a field) form one undo step.
   */
  const commit = (coalesceKey?: string) => {
    const now = Date.now();
    if (coalesceKey && coalesceKey === lastKey && now - lastAt < 1000) {
      lastAt = now;
      set({ future: [], dirty: true });
      return;
    }
    lastKey = coalesceKey ?? null;
    lastAt = now;
    const s = get();
    const past = [...s.past, snapshot(s)];
    if (past.length > HISTORY_LIMIT) past.shift();
    set({ past, future: [], dirty: true });
  };

  return {
    ...initial,
    clipboard: null,

    load: (wf) => {
      lastKey = null;
      const { nodes, edges, settings } = definitionToFlow(wf.definition);
      set({
        ...initial,
        workflowId: wf.id,
        name: wf.name,
        description: wf.description ?? "",
        version: wf.version,
        meta: wf.definition?.meta ?? null,
        hasPlan: !!wf.has_plan,
        nodes,
        edges,
        settings,
      });
    },
    setHighlights: (invalidNodes, invalidEdges = {}) => set({ invalidNodes, invalidEdges }),
    reset: () => set({ ...initial }),
    markSaved: (wf) => set({ dirty: false, version: wf.version, name: wf.name, description: wf.description ?? "" }),
    setName: (name) => set({ name, dirty: true }),
    setDescription: (description) => set({ description, dirty: true }),

    onNodesChange: (changes) => {
      const meaningful = changes.some((c) => c.type === "remove" || c.type === "add" || c.type === "replace");
      if (meaningful) commit();
      const moved = changes.some((c) => c.type === "position" && c.position);
      set((s) => ({
        nodes: applyNodeChanges(changes, s.nodes),
        dirty: s.dirty || meaningful || moved,
      }));
      if (changes.some((c) => c.type === "remove")) {
        // remove dangling edges
        const ids = new Set(get().nodes.map((n) => n.id));
        set((s) => ({ edges: s.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) }));
      }
    },

    onEdgesChange: (changes) => {
      const meaningful = changes.some((c) => c.type === "remove" || c.type === "add" || c.type === "replace");
      if (meaningful) commit();
      set((s) => ({ edges: applyEdgeChanges(changes, s.edges) }));
    },

    onConnect: (c) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const s = get();
      const sourceHandle = c.sourceHandle || "out";
      const dup = s.edges.some(
        (e) => e.source === c.source && e.target === c.target && (e.sourceHandle || "out") === sourceHandle,
      );
      if (dup) return;
      commit();
      const edge: FlowEdge = {
        id: generateEdgeId(s.edges.map((e) => e.id)),
        source: c.source,
        target: c.target,
        sourceHandle,
        targetHandle: "in",
        type: "workflow",
        data: {},
      };
      set((st) => ({ edges: addEdge(edge, st.edges) }));
    },

    beginDrag: () => commit(),

    addNode: (spec, position) => {
      const s = get();
      commit();
      const ids = s.nodes.map((n) => n.id);
      const id = generateNodeId(spec.idBase ?? spec.type, ids, spec.preferBareId ?? false);
      const node: FlowNode = {
        id,
        type: spec.type,
        position: { x: Math.round(position.x), y: Math.round(position.y) },
        data: {
          label: spec.label ?? NODE_META[spec.type].title,
          config: cloneJson(spec.config ?? defaultConfig(spec.type)),
        },
        selected: true,
      };
      set((st) => ({
        nodes: [...st.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), node],
        edges: st.edges.map((e) => (e.selected ? { ...e, selected: false } : e)),
      }));
      return id;
    },

    updateNodeData: (id, patch) => {
      commit(`data:${id}:${Object.keys(patch).join(",")}`);
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
      }));
    },

    updateNodeConfig: (id, config) => {
      const s = get();
      const node = s.nodes.find((n) => n.id === id);
      if (!node) return;
      commit(`config:${id}`);
      let edges = s.edges;
      if (node.type === "condition") {
        const before = node.data.config as ConditionNodeConfig;
        const after = config as ConditionNodeConfig;
        // a renamed handle (same index / default) keeps its edges
        const remap = new Map<string, string>();
        if (before.branches?.length === after.branches?.length) {
          before.branches.forEach((b, i) => {
            const nb = after.branches[i];
            if (nb && b.handle !== nb.handle) remap.set(b.handle, nb.handle);
          });
        }
        if (before.default_handle !== after.default_handle) remap.set(before.default_handle, after.default_handle);
        if (remap.size) {
          edges = edges.map((e) =>
            e.source === id && remap.has(e.sourceHandle || "out")
              ? { ...e, sourceHandle: remap.get(e.sourceHandle || "out") }
              : e,
          );
        }
        // drop edges whose source handle no longer exists
        const valid = new Set(sourceHandles("condition", after).map((h) => h.id));
        edges = edges.filter((e) => e.source !== id || valid.has(e.sourceHandle || "out"));
      }
      set({
        nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, config: cloneJson(config) } } : n)),
        edges,
      });
    },

    renameNode: (oldId, newId) => {
      const s = get();
      if (oldId === newId) return { ok: true };
      if (!isValidNodeId(newId)) {
        return { ok: false, error: "Use lowercase letters, digits and _; must start with a letter (max 64)." };
      }
      if (s.nodes.some((n) => n.id === newId)) return { ok: false, error: `Key "${newId}" is already used` };
      commit();
      set({
        nodes: s.nodes.map((n) => (n.id === oldId ? { ...n, id: newId } : n)),
        edges: s.edges.map((e) => ({
          ...e,
          source: e.source === oldId ? newId : e.source,
          target: e.target === oldId ? newId : e.target,
        })),
        invalidNodes: {},
      });
      return { ok: true };
    },

    updateEdgeLabel: (id, label) => {
      commit(`edge:${id}`);
      set((s) => ({
        edges: s.edges.map((e) => (e.id === id ? { ...e, data: { ...e.data, label: label || undefined } } : e)),
      }));
    },

    deleteElements: (nodeIds, edgeIds) => {
      if (nodeIds.length === 0 && edgeIds.length === 0) return;
      commit();
      const nIds = new Set(nodeIds);
      const eIds = new Set(edgeIds);
      set((s) => ({
        nodes: s.nodes.filter((n) => !nIds.has(n.id)),
        edges: s.edges.filter((e) => !eIds.has(e.id) && !nIds.has(e.source) && !nIds.has(e.target)),
      }));
    },

    deleteSelected: () => {
      const s = get();
      s.deleteElements(
        s.nodes.filter((n) => n.selected).map((n) => n.id),
        s.edges.filter((e) => e.selected).map((e) => e.id),
      );
    },

    selectOnly: (nodeIds, edgeIds = []) => {
      const n = new Set(nodeIds);
      const e = new Set(edgeIds);
      set((s) => ({
        nodes: s.nodes.map((x) => (!!x.selected === n.has(x.id) ? x : { ...x, selected: n.has(x.id) })),
        edges: s.edges.map((x) => (!!x.selected === e.has(x.id) ? x : { ...x, selected: e.has(x.id) })),
      }));
    },

    copySelection: () => {
      const s = get();
      const nodes = s.nodes.filter((n) => n.selected);
      if (nodes.length === 0) return 0;
      const ids = new Set(nodes.map((n) => n.id));
      const edges = s.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
      set({ clipboard: { nodes: cloneJson(nodes), edges: cloneJson(edges) } });
      return nodes.length;
    },

    paste: (offset = { x: 40, y: 40 }) => {
      const s = get();
      const clip = s.clipboard;
      if (!clip || clip.nodes.length === 0) return 0;
      commit();
      const taken = s.nodes.map((n) => n.id);
      const idMap = new Map<string, string>();
      const newNodes: FlowNode[] = clip.nodes.map((n) => {
        const base = n.id.replace(/_\d+$/, "") || n.type || "node";
        const id = generateNodeId(base, [...taken, ...idMap.values()]);
        idMap.set(n.id, id);
        return {
          ...cloneJson(n),
          id,
          position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
          selected: true,
          measured: undefined,
        };
      });
      const edgeIds = s.edges.map((e) => e.id);
      const newEdges: FlowEdge[] = clip.edges.map((e) => {
        const id = generateEdgeId(edgeIds);
        edgeIds.push(id);
        return {
          ...cloneJson(e),
          id,
          source: idMap.get(e.source) ?? e.source,
          target: idMap.get(e.target) ?? e.target,
          selected: false,
        };
      });
      set({
        nodes: [...s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...newNodes],
        edges: [...s.edges.map((e) => (e.selected ? { ...e, selected: false } : e)), ...newEdges],
        // shift the clipboard so repeated pastes cascade
        clipboard: {
          nodes: clip.nodes.map((n) => ({ ...n, position: { x: n.position.x + offset.x, y: n.position.y + offset.y } })),
          edges: clip.edges,
        },
      });
      return newNodes.length;
    },

    setSettings: (patch) => {
      commit(`settings:${Object.keys(patch).join(",")}`);
      set((s) => ({ settings: { ...s.settings, ...patch } }));
    },

    layout: () => {
      const s = get();
      if (s.nodes.length === 0) return;
      commit();
      set({ nodes: autoLayout(s.nodes, s.edges) });
    },

    undo: () => {
      lastKey = null;
      const s = get();
      const prev = s.past[s.past.length - 1];
      if (!prev) return;
      set({
        past: s.past.slice(0, -1),
        future: [snapshot(s), ...s.future].slice(0, HISTORY_LIMIT),
        nodes: prev.nodes,
        edges: prev.edges,
        settings: prev.settings,
        dirty: true,
      });
    },

    redo: () => {
      lastKey = null;
      const s = get();
      const next = s.future[0];
      if (!next) return;
      set({
        future: s.future.slice(1),
        past: [...s.past, snapshot(s)].slice(-HISTORY_LIMIT),
        nodes: next.nodes,
        edges: next.edges,
        settings: next.settings,
        dirty: true,
      });
    },

    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,

    setValidation: (v) =>
      set({
        validation: v,
        invalidNodes: v ? issuesBy(v.errors, "node_id") : {},
        invalidEdges: v ? issuesBy(v.errors, "edge_id") : {},
      }),

    getDefinition: () => {
      const s = get();
      return flowToDefinition(s.nodes, s.edges, s.settings, s.meta);
    },
  };
});
