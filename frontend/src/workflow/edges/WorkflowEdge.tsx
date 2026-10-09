import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useNodesData,
  type EdgeProps,
  type EdgeTypes,
} from "@xyflow/react";
import type { NodeType } from "@/types";
import { cn } from "@/lib/utils";
import { handleLabel } from "../nodeMeta";
import type { FlowEdge, FlowNode } from "../types";

function WorkflowEdgeImpl({
  id,
  source,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  sourceHandleId,
  data,
  markerEnd,
  style,
  selected,
}: EdgeProps<FlowEdge>) {
  const sourceNode = useNodesData<FlowNode>(source);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const explicit = data?.label;
  const derived = handleLabel(sourceNode?.type as NodeType | undefined, sourceNode?.data.config, sourceHandleId);
  const label = explicit || derived;
  const tone =
    sourceHandleId === "rejected" || sourceHandleId === "false"
      ? "text-destructive"
      : sourceHandleId === "approved" || sourceHandleId === "true"
        ? "text-success"
        : "text-foreground/80";

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className={cn(
              "nodrag nopan pointer-events-auto absolute rounded-full border bg-card px-2 py-0.5 text-[10px] font-medium shadow-xs",
              tone,
              selected && "border-primary",
              data?.traversed && "border-info",
            )}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            data-testid={`edge-label-${id}`}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const WorkflowEdge = memo(WorkflowEdgeImpl);

export const edgeTypes: EdgeTypes = {
  workflow: WorkflowEdge,
};
