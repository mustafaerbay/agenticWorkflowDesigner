import { memo, useEffect, useState } from "react";
import { Handle, Position, type NodeProps, type NodeTypes } from "@xyflow/react";
import { Coins, Repeat } from "lucide-react";
import type {
  AgentNodeConfig,
  ApprovalNodeConfig,
  ConditionNodeConfig,
  DelayNodeConfig,
  FailNodeConfig,
  JoinNodeConfig,
  NodeType,
  ToolNodeConfig,
} from "@/types";
import { cn, formatDuration } from "@/lib/utils";
import { statusLabel } from "@/lib/status";
import { NODE_META, sourceHandles, type HandleInfo } from "../nodeMeta";
import type { FlowNode, NodeRuntime } from "../types";

// ---------------------------------------------------------------------------
// Status styling (execution mode)
// ---------------------------------------------------------------------------

const STATUS_RING: Record<string, string> = {
  PENDING: "border-border",
  QUEUED: "border-info/70",
  RUNNING: "border-info animate-pulse-ring",
  COMPLETED: "border-success",
  FAILED: "border-destructive",
  WAITING: "border-warning",
  SKIPPED: "border-dashed border-muted-foreground/40 opacity-55",
  CANCELLED: "border-muted-foreground/40 opacity-60",
};

const STATUS_DOT: Record<string, string> = {
  PENDING: "bg-muted-foreground/40",
  QUEUED: "bg-info",
  RUNNING: "bg-info animate-pulse",
  COMPLETED: "bg-success",
  FAILED: "bg-destructive",
  WAITING: "bg-warning",
  SKIPPED: "bg-muted-foreground/30",
  CANCELLED: "bg-muted-foreground/40",
};

const STATUS_TEXT: Record<string, string> = {
  QUEUED: "text-info",
  RUNNING: "text-info",
  COMPLETED: "text-success",
  FAILED: "text-destructive",
  WAITING: "text-amber-600 dark:text-warning",
};

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function RuntimeFooter({ rt }: { rt: NodeRuntime }) {
  const running = rt.status === "RUNNING";
  const now = useNow(running);
  const elapsed = rt.startedAt
    ? running
      ? Math.max(0, now - new Date(rt.startedAt).getTime())
      : rt.durationMs
    : null;
  return (
    <div className="space-y-1 border-t px-3 py-2 text-[11px]">
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[rt.status])} aria-hidden />
        <span className={cn("font-medium", STATUS_TEXT[rt.status] ?? "text-muted-foreground")}>
          {rt.status === "WAITING" ? "Waiting for approval" : statusLabel(rt.status)}
        </span>
        <span className="ml-auto flex items-center gap-2 text-muted-foreground tabular-nums">
          {rt.runs > 1 && (
            <span className="flex items-center gap-0.5" title={`${rt.runs} runs`}>
              <Repeat className="size-3" aria-hidden />×{rt.runs}
            </span>
          )}
          {elapsed != null && <span title="Elapsed">{formatDuration(elapsed)}</span>}
        </span>
      </div>
      {rt.progress && (rt.status === "RUNNING" || rt.status === "QUEUED") && (
        <p className="line-clamp-2 text-muted-foreground" title={rt.progress}>
          {rt.progress}
        </p>
      )}
      {rt.error && rt.status === "FAILED" && (
        <p className="line-clamp-2 text-destructive" title={rt.error}>
          {rt.error}
        </p>
      )}
      {rt.totalTokens != null && rt.totalTokens > 0 && (
        <p className="flex items-center gap-1 text-muted-foreground tabular-nums">
          <Coins className="size-3" aria-hidden /> {rt.totalTokens.toLocaleString()} tokens
        </p>
      )}
    </div>
  );
}

const TONE_TEXT: Record<NonNullable<HandleInfo["tone"]>, string> = {
  default: "text-foreground/80",
  success: "text-success",
  danger: "text-destructive",
  muted: "text-muted-foreground",
};

function HandleRows({ handles }: { handles: HandleInfo[] }) {
  return (
    <div className="space-y-0.5 border-t py-1.5">
      {handles.map((h) => (
        <div key={h.id} className="relative flex h-6 items-center justify-end pr-4 pl-3">
          <span className={cn("truncate text-[11px] font-medium", TONE_TEXT[h.tone ?? "default"])} title={h.id}>
            {h.label}
          </span>
          <Handle
            type="source"
            position={Position.Right}
            id={h.id}
            className="handle-labeled"
            style={{ right: -7 }}
            aria-label={`Output ${h.label}`}
          />
        </div>
      ))}
    </div>
  );
}

function subtitle(type: NodeType, config: unknown): React.ReactNode {
  switch (type) {
    case "agent": {
      const c = config as AgentNodeConfig;
      const bits: string[] = [];
      if (c.kind === "scripted") bits.push("Scripted");
      if (c.preset) bits.push(String(c.preset).replace(/_/g, " "));
      if (c.model) bits.push(c.model);
      if (c.agent_id) bits.push("registry agent");
      return bits.join(" · ") || "LLM agent";
    }
    case "tool":
      return (config as ToolNodeConfig).tool || "No tool selected";
    case "join":
      return `Wait for ${(config as JoinNodeConfig).mode === "any" ? "any" : "all"} branches`;
    case "approval":
      return (config as ApprovalNodeConfig).title || "Approval";
    case "delay":
      return `${(config as DelayNodeConfig).seconds ?? 0}s`;
    case "fail":
      return (config as FailNodeConfig).message || "Fail workflow";
    case "condition": {
      const n = (config as ConditionNodeConfig).branches?.length ?? 0;
      return `${n} branch${n === 1 ? "" : "es"} + default`;
    }
    case "start":
      return "Trigger";
    case "parallel":
      return "Run all outgoing branches";
    case "end":
      return "Complete workflow";
  }
}

function BaseNode({ id, type, data, selected }: NodeProps<FlowNode>) {
  const t = type as NodeType;
  const meta = NODE_META[t];
  const Icon = meta.icon;
  const rt = data.runtime;
  const handles = sourceHandles(t, data.config);
  const multi = t === "condition" || t === "approval";
  const scripted = t === "agent" && (data.config as AgentNodeConfig).kind === "scripted";

  return (
    <div
      className={cn(
        "w-[240px] rounded-lg border bg-card text-card-foreground shadow-sm transition-shadow",
        selected && "shadow-md",
        rt ? STATUS_RING[rt.status] : "border-border hover:border-foreground/25",
      )}
      data-testid={`node-${id}`}
      data-status={rt?.status}
    >
      {meta.hasTarget && (
        <Handle type="target" position={Position.Left} id="in" aria-label="Input" />
      )}
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <div className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md", meta.accent)}>
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[13px] font-semibold leading-5">{data.label || meta.title}</p>
            {scripted && (
              <span className="shrink-0 rounded bg-muted px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                no llm
              </span>
            )}
          </div>
          <p className="truncate text-[11px] text-muted-foreground">{subtitle(t, data.config)}</p>
          <p className="truncate font-mono text-[10px] text-muted-foreground/70">{id}</p>
        </div>
      </div>
      {multi && <HandleRows handles={handles} />}
      {!multi && handles.length > 0 && (
        <Handle type="source" position={Position.Right} id="out" aria-label="Output" />
      )}
      {rt && <RuntimeFooter rt={rt} />}
    </div>
  );
}

const MemoNode = memo(BaseNode);

/** Defined at module scope so React Flow never sees a new object. */
export const nodeTypes: NodeTypes = {
  start: MemoNode,
  agent: MemoNode,
  condition: MemoNode,
  tool: MemoNode,
  parallel: MemoNode,
  join: MemoNode,
  approval: MemoNode,
  delay: MemoNode,
  end: MemoNode,
  fail: MemoNode,
};
