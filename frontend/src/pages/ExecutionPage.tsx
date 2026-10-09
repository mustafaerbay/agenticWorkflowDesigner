import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type DefaultEdgeOptions,
  type NodeChange,
  type NodeMouseHandler,
} from "@xyflow/react";
import { ArrowLeft, Ban, Check, Pause, Pencil, Play, RotateCcw, ShieldAlert, Wifi, WifiOff, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { JsonView } from "@/components/JsonField";
import { ErrorState } from "@/components/States";
import { StatusBadge } from "@/components/StatusBadge";
import { api, errorMessage, queryKeys } from "@/services/api";
import type { WsStatus } from "@/services/ws";
import { isTerminal } from "@/lib/status";
import { cn, durationBetween, formatDate, formatDuration, throttle } from "@/lib/utils";
import { resolveTheme, useThemeStore } from "@/stores/theme";
import type { NodeType, RunEvent } from "@/types";
import { edgeTypes } from "@/workflow/edges/WorkflowEdge";
import { buildExecutionGraph, groupRuns } from "@/workflow/execution/runtime";
import { NodeRunPanel } from "@/workflow/execution/NodeRunPanel";
import { Timeline } from "@/workflow/execution/Timeline";
import { useExecutionStream } from "@/workflow/execution/useExecutionStream";
import { NODE_META } from "@/workflow/nodeMeta";
import { nodeTypes } from "@/workflow/nodes/WorkflowNodes";
import type { FlowEdge, FlowNode } from "@/workflow/types";

const defaultEdgeOptions: DefaultEdgeOptions = {
  type: "workflow",
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
};
const proOptions = { hideAttribution: true };
const TRAVERSE_MS = 1600;
const MAX_LIVE_EVENTS = 1000;

function ConnectionIndicator({ status, terminal }: { status: WsStatus; terminal: boolean }) {
  if (terminal) return <span className="text-[11px] text-muted-foreground">Run finished</span>;
  const map: Record<WsStatus, { label: string; cls: string; Icon: typeof Wifi }> = {
    open: { label: "Live", cls: "text-success", Icon: Wifi },
    connecting: { label: "Connecting…", cls: "text-muted-foreground", Icon: Wifi },
    reconnecting: { label: "Reconnecting…", cls: "text-amber-600 dark:text-warning", Icon: WifiOff },
    closed: { label: "Disconnected", cls: "text-destructive", Icon: WifiOff },
  };
  const { label, cls, Icon } = map[status];
  return (
    <span className={cn("flex items-center gap-1 text-[11px] font-medium", cls)} role="status" aria-live="polite">
      <Icon className={cn("size-3.5", status === "open" && "animate-pulse")} aria-hidden /> {label}
    </span>
  );
}

function ApprovalBanner({ runId }: { runId: string }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState("");
  const approvals = useQuery({
    queryKey: queryKeys.approvals("pending"),
    queryFn: () => api.listApprovals("pending"),
    refetchInterval: 10_000,
  });
  const pending = approvals.data?.filter((a) => a.run_id === runId) ?? [];
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approve" | "reject" }) =>
      api.decideApproval(id, { decision, comment: comment || undefined }),
    onSuccess: (a) => {
      toast.success(`Approval ${a.status}`);
      setComment("");
      void qc.invalidateQueries({ queryKey: queryKeys.approvalsAll });
      void qc.invalidateQueries({ queryKey: queryKeys.execution(runId) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (pending.length === 0) return null;
  return (
    <div className="space-y-2 border-b border-warning/40 bg-warning/10 px-4 py-3" role="region" aria-label="Pending approvals">
      {pending.map((a) => (
        <div key={a.id} className="flex flex-wrap items-start gap-3">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-warning" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{a.title}</p>
            {a.description && <p className="text-xs text-muted-foreground">{a.description}</p>}
            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">node {a.node_id}</p>
          </div>
          <Textarea
            aria-label="Approval comment"
            placeholder="Comment (optional)"
            rows={1}
            className="min-h-8 w-56 text-xs"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="flex gap-1.5">
            <Button size="sm" variant="success" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, decision: "approve" })}>
              <Check /> Approve
            </Button>
            <Button size="sm" variant="destructive" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, decision: "reject" })}>
              <X /> Reject
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ExecutionInner({ runId }: { runId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const theme = useThemeStore((s) => s.theme);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [traversed, setTraversed] = useState<ReadonlySet<string>>(new Set());
  const [liveEvents, setLiveEvents] = useState<RunEvent[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const runQuery = useQuery({ queryKey: queryKeys.execution(runId), queryFn: () => api.getExecution(runId) });
  const eventsQuery = useQuery({
    queryKey: ["execution-events", runId],
    queryFn: () => api.listEvents(runId, 0),
    staleTime: Infinity,
  });
  const run = runQuery.data;
  const terminal = isTerminal(run?.status);

  // Throttled re-fetch so the server stays the source of truth.
  const refetch = useMemo(
    () => throttle(() => void qc.invalidateQueries({ queryKey: queryKeys.execution(runId) }), 600),
    [qc, runId],
  );
  useEffect(() => () => refetch.cancel(), [refetch]);
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach((x) => clearTimeout(x));
  }, []);

  const onEvent = useCallback(
    (e: RunEvent) => {
      setLiveEvents((prev) => {
        const next = [...prev, e];
        return next.length > MAX_LIVE_EVENTS ? next.slice(-MAX_LIVE_EVENTS) : next;
      });
      if (e.type === "edge.traversed") {
        const edgeId = e.data?.edge_id;
        if (typeof edgeId === "string") {
          setTraversed((s) => new Set(s).add(edgeId));
          const prevT = timers.current.get(edgeId);
          if (prevT) clearTimeout(prevT);
          timers.current.set(
            edgeId,
            setTimeout(() => {
              timers.current.delete(edgeId);
              setTraversed((s) => {
                const n = new Set(s);
                n.delete(edgeId);
                return n;
              });
            }, TRAVERSE_MS),
          );
        }
        return;
      }
      if (e.type === "node.progress" && e.node_id && typeof e.data?.message === "string") {
        const msg = e.data.message;
        setProgress((p) => ({ ...p, [e.node_id!]: msg }));
      }
      if (e.type === "node.started" && e.node_id) {
        setProgress((p) => {
          if (!(e.node_id! in p)) return p;
          const n = { ...p };
          delete n[e.node_id!];
          return n;
        });
      }
      if (e.type.startsWith("node.") || e.type.startsWith("workflow.") || e.type.startsWith("approval.")) {
        if (e.type !== "node.progress") refetch();
        if (e.type.startsWith("approval.")) void qc.invalidateQueries({ queryKey: queryKeys.approvalsAll });
      }
    },
    [refetch, qc],
  );

  const ready = !!run && eventsQuery.isSuccess;
  const historicMax = useMemo(
    () => (eventsQuery.data ?? []).reduce((m, e) => Math.max(m, e.seq), 0),
    [eventsQuery.data],
  );
  const after = Math.max(run?.last_event_seq ?? 0, historicMax);
  const wsStatus = useExecutionStream(runId, ready && !terminal, after, onEvent);

  const events = useMemo(() => {
    const base = eventsQuery.data ?? [];
    const seen = new Set(base.map((e) => e.seq));
    return [...base, ...liveEvents.filter((e) => !seen.has(e.seq))];
  }, [eventsQuery.data, liveEvents]);

  const graph = useMemo(
    () => (run ? buildExecutionGraph(run, progress, traversed) : { nodes: [] as FlowNode[], edges: [] as FlowEdge[] }),
    [run, progress, traversed],
  );
  const runsByNode = useMemo(() => groupRuns(run), [run]);

  // Controlled nodes need React Flow's measured dimensions written back (minimap, fitView).
  const [flowNodes, setFlowNodes] = useState<FlowNode[]>([]);
  useEffect(() => {
    setFlowNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return graph.nodes.map((n) => {
        const p = byId.get(n.id);
        return p ? { ...n, measured: p.measured, selected: p.selected } : n;
      });
    });
  }, [graph.nodes]);
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) =>
      setFlowNodes((ns) => applyNodeChanges(changes.filter((c) => c.type === "dimensions" || c.type === "select"), ns)),
    [],
  );

  const action = useMutation({
    mutationFn: (kind: "pause" | "resume" | "cancel" | "retry") => {
      switch (kind) {
        case "pause":
          return api.pauseExecution(runId);
        case "resume":
          return api.resumeExecution(runId);
        case "cancel":
          return api.cancelExecution(runId);
        case "retry":
          return api.retryExecution(runId);
      }
    },
    onSuccess: (r, kind) => {
      if (kind === "retry") {
        toast.success("Retry started");
        navigate(`/executions/${r.id}`);
      } else {
        qc.setQueryData(queryKeys.execution(runId), r);
        toast.success(`Run ${kind === "resume" ? "resumed" : kind === "pause" ? "paused" : "cancelled"}`);
      }
      void qc.invalidateQueries({ queryKey: queryKeys.executionsAll });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const onNodeClick: NodeMouseHandler<FlowNode> = useCallback((_, n) => setSelected(n.id), []);

  // Elapsed ticker for the header
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (terminal || !run?.started_at) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [terminal, run?.started_at]);

  if (runQuery.isError) {
    return (
      <div className="p-8">
        <ErrorState error={runQuery.error} onRetry={() => void runQuery.refetch()} />
      </div>
    );
  }
  if (!run) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading execution…
      </div>
    );
  }

  const selectedNode = selected ? run.definition.nodes.find((n) => n.id === selected) : undefined;
  const elapsed = durationBetween(run.started_at, run.finished_at, now);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b bg-card px-3 py-1.5">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/executions" aria-label="Back to execution history">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {run.workflow_name} <span className="font-normal text-muted-foreground">v{run.workflow_version}</span>
          </p>
          <p className="font-mono text-[10px] text-muted-foreground">{run.id}</p>
        </div>
        <StatusBadge status={run.status} />
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {formatDuration(elapsed)} · {run.steps} steps
        </span>
        <ConnectionIndicator status={wsStatus} terminal={terminal} />
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="sm" asChild>
            <Link to={`/workflows/${run.workflow_id}/edit`}>
              <Pencil /> <span className="hidden sm:inline">Edit workflow</span>
            </Link>
          </Button>
          {run.status === "RUNNING" || run.status === "WAITING_APPROVAL" || run.status === "PENDING" ? (
            <Button variant="outline" size="sm" disabled={action.isPending} onClick={() => action.mutate("pause")}>
              <Pause /> Pause
            </Button>
          ) : null}
          {run.status === "PAUSED" && (
            <Button variant="outline" size="sm" disabled={action.isPending} onClick={() => action.mutate("resume")}>
              <Play /> Resume
            </Button>
          )}
          {!terminal && (
            <Button variant="outline" size="sm" className="text-destructive" disabled={action.isPending} onClick={() => setConfirmCancel(true)}>
              <Ban /> Cancel
            </Button>
          )}
          {terminal && (
            <Button size="sm" disabled={action.isPending} onClick={() => action.mutate("retry")}>
              <RotateCcw /> Retry
            </Button>
          )}
        </div>
      </header>

      {run.status === "WAITING_APPROVAL" && <ApprovalBanner runId={run.id} />}
      {run.error && (
        <div role="alert" className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {run.error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1" data-testid="execution-canvas">
          <ReactFlow<FlowNode, FlowEdge>
            nodes={flowNodes}
            onNodesChange={onNodesChange}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultEdgeOptions={defaultEdgeOptions}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            deleteKeyCode={null}
            onNodeClick={onNodeClick}
            onPaneClick={() => setSelected(null)}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
            minZoom={0.1}
            onlyRenderVisibleElements={graph.nodes.length > 60}
            colorMode={resolveTheme(theme)}
            proOptions={proOptions}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="var(--canvas-dot)" />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap<FlowNode>
              pannable
              zoomable
              position="bottom-right"
              nodeColor={(n) => NODE_META[n.type as NodeType]?.color ?? "#94a3b8"}
            />
          </ReactFlow>
        </div>
        <aside className="hidden w-[380px] shrink-0 flex-col border-l bg-card md:flex" aria-label="Execution details">
          {selectedNode ? (
            <NodeRunPanel
              nodeId={selectedNode.id}
              nodeType={selectedNode.type}
              label={selectedNode.data.label}
              runs={runsByNode.get(selectedNode.id) ?? []}
              onClose={() => setSelected(null)}
            />
          ) : (
            <Tabs defaultValue="timeline" className="flex min-h-0 flex-1 flex-col">
              <div className="border-b p-3">
                <TabsList>
                  <TabsTrigger value="timeline">Timeline {events.length > 0 && <span className="text-muted-foreground">{events.length}</span>}</TabsTrigger>
                  <TabsTrigger value="run">Run</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="timeline" className="mt-0 min-h-0 flex-1 overflow-y-auto">
                <Timeline events={events} onSelectNode={setSelected} />
              </TabsContent>
              <TabsContent value="run" className="mt-0 min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                <dl className="grid grid-cols-2 gap-y-2 text-xs">
                  <dt className="text-muted-foreground">Created</dt>
                  <dd>{formatDate(run.created_at)}</dd>
                  <dt className="text-muted-foreground">Started</dt>
                  <dd>{formatDate(run.started_at)}</dd>
                  <dt className="text-muted-foreground">Finished</dt>
                  <dd>{formatDate(run.finished_at)}</dd>
                </dl>
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Input</p>
                  <JsonView value={run.input} empty="No input" />
                </div>
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Output</p>
                  <JsonView value={run.output} empty={terminal ? "No output" : "Not finished yet"} />
                </div>
                <p className="text-[11px] text-muted-foreground">Click a node to inspect its input, output, logs, tool calls and attempts.</p>
              </TabsContent>
            </Tabs>
          )}
        </aside>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this run?"
        description="In-flight nodes will be cancelled and no further nodes will be dispatched. This cannot be undone."
        confirmLabel="Cancel run"
        destructive
        onConfirm={() => action.mutate("cancel")}
      />
    </div>
  );
}

export default function ExecutionPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return (
    <ReactFlowProvider key={id}>
      <ExecutionInner runId={id} />
    </ReactFlowProvider>
  );
}
