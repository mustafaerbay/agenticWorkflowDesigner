import { useCallback, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  type DefaultEdgeOptions,
  type IsValidConnection,
} from "@xyflow/react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { useThemeStore, resolveTheme } from "@/stores/theme";
import type { NodeType } from "@/types";
import { edgeTypes } from "../edges/WorkflowEdge";
import { NODE_META } from "../nodeMeta";
import { nodeTypes } from "../nodes/WorkflowNodes";
import type { FlowEdge, FlowNode } from "../types";
import { DND_MIME } from "./Palette";
import { useEditorStore, type NewNodeSpec } from "./store";

const defaultEdgeOptions: DefaultEdgeOptions = {
  type: "workflow",
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
};
const proOptions = { hideAttribution: true };
const snapGrid: [number, number] = [8, 8];
const minimapNodeColor = (n: FlowNode) => NODE_META[n.type as NodeType]?.color ?? "#94a3b8";

/** Adds a node, refusing a second Start node. Returns the new id or null. */
export function addNodeChecked(spec: NewNodeSpec, position: { x: number; y: number }): string | null {
  const st = useEditorStore.getState();
  if (spec.type === "start" && st.nodes.some((n) => n.type === "start")) {
    toast.error("A workflow can only have one Start node");
    return null;
  }
  return st.addNode(spec, position);
}

export function EditorCanvas() {
  const { nodes, edges, invalidNodes, invalidEdges } = useEditorStore(
    useShallow((s) => ({ nodes: s.nodes, edges: s.edges, invalidNodes: s.invalidNodes, invalidEdges: s.invalidEdges })),
  );
  const onNodesChange = useEditorStore((s) => s.onNodesChange);
  const onEdgesChange = useEditorStore((s) => s.onEdgesChange);
  const onConnect = useEditorStore((s) => s.onConnect);
  const beginDrag = useEditorStore((s) => s.beginDrag);
  const theme = useThemeStore((s) => s.theme);
  const { screenToFlowPosition } = useReactFlow();

  // Only allocate new objects for nodes/edges that are flagged invalid.
  const displayNodes = useMemo(() => {
    if (Object.keys(invalidNodes).length === 0) return nodes;
    return nodes.map((n) => (invalidNodes[n.id] ? { ...n, className: "node-invalid" } : n));
  }, [nodes, invalidNodes]);
  const displayEdges = useMemo(() => {
    if (Object.keys(invalidEdges).length === 0) return edges;
    return edges.map((e) => (invalidEdges[e.id] ? { ...e, className: "edge-invalid" } : e));
  }, [edges, invalidEdges]);

  const isValidConnection: IsValidConnection<FlowEdge> = useCallback((c) => {
    if (c.source === c.target) return false;
    const target = useEditorStore.getState().nodes.find((n) => n.id === c.target);
    return !!target && target.type !== "start";
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(DND_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const raw = e.dataTransfer.getData(DND_MIME);
      if (!raw) return;
      e.preventDefault();
      let spec: NewNodeSpec;
      try {
        spec = JSON.parse(raw) as NewNodeSpec;
      } catch {
        return;
      }
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addNodeChecked(spec, { x: pos.x - 120, y: pos.y - 30 });
    },
    [screenToFlowPosition],
  );

  return (
    <div className="h-full w-full" onDragOver={onDragOver} onDrop={onDrop} data-testid="editor-canvas">
      <ReactFlow<FlowNode, FlowEdge>
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={beginDrag}
        onSelectionDragStart={beginDrag}
        isValidConnection={isValidConnection}
        defaultEdgeOptions={defaultEdgeOptions}
        connectionLineType={ConnectionLineType.Bezier}
        deleteKeyCode={null}
        multiSelectionKeyCode={["Meta", "Control"]}
        selectionKeyCode="Shift"
        selectionMode={SelectionMode.Partial}
        snapToGrid
        snapGrid={snapGrid}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
        minZoom={0.1}
        maxZoom={2}
        onlyRenderVisibleElements={nodes.length > 60}
        colorMode={resolveTheme(theme)}
        proOptions={proOptions}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="var(--canvas-dot)" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap<FlowNode> pannable zoomable nodeColor={minimapNodeColor} nodeStrokeWidth={2} position="bottom-right" ariaLabel="Workflow minimap" />
      </ReactFlow>
    </div>
  );
}
