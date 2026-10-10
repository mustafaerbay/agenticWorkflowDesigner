import { useMemo } from "react";
import { Background, BackgroundVariant, Controls, MarkerType, ReactFlow, type DefaultEdgeOptions } from "@xyflow/react";
import { resolveTheme, useThemeStore } from "@/stores/theme";
import type { WorkflowDefinition } from "@/types";
import { edgeTypes } from "@/workflow/edges/WorkflowEdge";
import { NodeDisplayContext } from "@/workflow/nodes/displayMode";
import { nodeTypes } from "@/workflow/nodes/WorkflowNodes";
import { definitionToFlow } from "@/workflow/serialization";
import type { FlowEdge, FlowNode } from "@/workflow/types";

const defaultEdgeOptions: DefaultEdgeOptions = {
  type: "workflow",
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
};
const proOptions = { hideAttribution: true };

/** Read-only preview of a compiled definition, always in business language. */
export function PlanDiagram({ definition, className }: { definition: WorkflowDefinition; className?: string }) {
  const theme = useThemeStore((s) => s.theme);
  const { nodes, edges } = useMemo(() => {
    const flow = definitionToFlow(definition);
    return {
      nodes: flow.nodes.map((n) => ({ ...n, draggable: false, connectable: false, deletable: false, selectable: false })),
      edges: flow.edges.map((e) => ({ ...e, deletable: false, selectable: false })),
    };
  }, [definition]);
  return (
    <div className={className ?? "h-[480px] rounded-lg border bg-canvas"} data-testid="plan-diagram">
      <NodeDisplayContext.Provider value="business">
        <ReactFlow<FlowNode, FlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          minZoom={0.1}
          onlyRenderVisibleElements={nodes.length > 60}
          colorMode={resolveTheme(theme)}
          proOptions={proOptions}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="var(--canvas-dot)" />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      </NodeDisplayContext.Provider>
    </div>
  );
}
