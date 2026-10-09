import { memo } from "react";
import { cn } from "@/lib/utils";
import type { RunEvent } from "@/types";

const TYPE_COLOR: Record<string, string> = {
  "workflow.started": "bg-info",
  "workflow.completed": "bg-success",
  "workflow.failed": "bg-destructive",
  "workflow.cancelled": "bg-muted-foreground",
  "workflow.paused": "bg-muted-foreground",
  "workflow.resumed": "bg-info",
  "workflow.waiting_approval": "bg-warning",
  "node.started": "bg-info",
  "node.completed": "bg-success",
  "node.failed": "bg-destructive",
  "node.skipped": "bg-muted-foreground/40",
  "node.cancelled": "bg-muted-foreground/60",
  "node.waiting": "bg-warning",
  "approval.requested": "bg-warning",
  "approval.resolved": "bg-success",
};

function describe(e: RunEvent): string {
  const d = e.data ?? {};
  if (e.type === "node.progress" && typeof d.message === "string") return d.message;
  if (e.type === "edge.traversed" && typeof d.edge_id === "string") return `edge ${d.edge_id}`;
  const parts: string[] = [];
  if (typeof d.iteration === "number" && d.iteration > 1) parts.push(`iteration ${d.iteration}`);
  if (typeof d.attempt === "number" && d.attempt > 1) parts.push(`attempt ${d.attempt}`);
  if (typeof d.selected_handle === "string") parts.push(`→ ${d.selected_handle}`);
  if (typeof d.error === "string") parts.push(d.error);
  if (typeof d.decision === "string") parts.push(d.decision);
  return parts.join(" · ");
}

export const Timeline = memo(function Timeline({
  events,
  onSelectNode,
}: {
  events: RunEvent[];
  onSelectNode: (id: string) => void;
}) {
  if (events.length === 0) return <p className="p-3 text-xs text-muted-foreground">No events yet.</p>;
  return (
    <ol className="space-y-0.5 p-2" aria-label="Event timeline">
      {[...events].reverse().map((e) => (
        <li key={e.seq} className="flex items-start gap-2 rounded px-1.5 py-1 text-[11px] hover:bg-accent/50">
          <span className="w-8 shrink-0 text-right font-mono text-muted-foreground tabular-nums">{e.seq}</span>
          <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", TYPE_COLOR[e.type] ?? "bg-muted-foreground/50")} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="font-medium">{e.type}</span>
            {e.node_id && (
              <button type="button" className="ml-1 font-mono text-primary hover:underline" onClick={() => onSelectNode(e.node_id!)}>
                {e.node_id}
              </button>
            )}
            {describe(e) && <span className="block truncate text-muted-foreground" title={describe(e)}>{describe(e)}</span>}
          </span>
          <span className="shrink-0 text-muted-foreground tabular-nums">{new Date(e.created_at).toLocaleTimeString()}</span>
        </li>
      ))}
    </ol>
  );
});
