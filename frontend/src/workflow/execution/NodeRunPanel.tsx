import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { JsonView } from "@/components/JsonField";
import { StatusBadge } from "@/components/StatusBadge";
import { cn, formatDate, formatDuration } from "@/lib/utils";
import type { NodeRun, NodeType } from "@/types";
import { NODE_META } from "../nodeMeta";

const LOG_COLORS: Record<string, string> = {
  error: "text-destructive",
  warning: "text-amber-600 dark:text-warning",
  warn: "text-amber-600 dark:text-warning",
  debug: "text-muted-foreground",
};

export function NodeRunPanel({
  nodeId,
  nodeType,
  label,
  runs,
  onClose,
}: {
  nodeId: string;
  nodeType: NodeType;
  label: string;
  runs: NodeRun[];
  onClose: () => void;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  useEffect(() => setSelectedRunId(null), [nodeId]);
  const run = runs.find((r) => r.id === selectedRunId) ?? runs[runs.length - 1];
  const meta = NODE_META[nodeType];
  const Icon = meta.icon;
  const errorsCount = runs.filter((r) => r.error).length;

  return (
    <div className="flex h-full flex-col" aria-label={`Node ${label} details`}>
      <div className="flex items-start gap-2.5 border-b p-4">
        <div className={cn("flex size-8 shrink-0 items-center justify-center rounded-md", meta.accent)}>
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{label}</h3>
          <p className="font-mono text-[11px] text-muted-foreground">{nodeId}</p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close node details" onClick={onClose}>
          <X />
        </Button>
      </div>
      {!run ? (
        <p className="p-4 text-xs text-muted-foreground">This node has not run yet.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <dl className="mb-4 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
            <dt className="text-muted-foreground">Status</dt>
            <dd><StatusBadge status={run.status} /></dd>
            <dt className="text-muted-foreground">Iteration / attempt</dt>
            <dd className="tabular-nums">#{run.iteration} · attempt {run.attempt}</dd>
            <dt className="text-muted-foreground">Started</dt>
            <dd>{formatDate(run.started_at)}</dd>
            <dt className="text-muted-foreground">Duration</dt>
            <dd className="tabular-nums">{formatDuration(run.duration_ms)}</dd>
            {run.agent_kind && (
              <>
                <dt className="text-muted-foreground">Agent</dt>
                <dd>
                  {run.agent_kind === "scripted" ? <Badge variant="secondary">Scripted · no LLM</Badge> : <Badge>LLM</Badge>}
                  {run.model && <span className="ml-1 font-mono text-[10px]">{run.model}</span>}
                </dd>
              </>
            )}
            {run.usage && (
              <>
                <dt className="text-muted-foreground">Tokens</dt>
                <dd className="tabular-nums">
                  {run.usage.total_tokens.toLocaleString()}{" "}
                  <span className="text-muted-foreground">
                    ({run.usage.prompt_tokens} in / {run.usage.completion_tokens} out)
                  </span>
                </dd>
              </>
            )}
            {run.selected_handle && (
              <>
                <dt className="text-muted-foreground">Selected branch</dt>
                <dd><code className="font-mono">{run.selected_handle}</code></dd>
              </>
            )}
          </dl>

          <Tabs defaultValue="output">
            <TabsList className="flex h-auto w-full flex-wrap justify-start">
              <TabsTrigger value="input">Input</TabsTrigger>
              <TabsTrigger value="output">Output</TabsTrigger>
              <TabsTrigger value="logs">Logs {run.logs.length > 0 && <span className="text-muted-foreground">{run.logs.length}</span>}</TabsTrigger>
              <TabsTrigger value="tools">Tool calls {run.tool_calls.length > 0 && <span className="text-muted-foreground">{run.tool_calls.length}</span>}</TabsTrigger>
              <TabsTrigger value="errors" className={cn(errorsCount > 0 && "text-destructive")}>Errors {errorsCount > 0 && errorsCount}</TabsTrigger>
              <TabsTrigger value="attempts">Attempts {runs.length}</TabsTrigger>
            </TabsList>
            <TabsContent value="input">
              <JsonView value={run.input} empty="No input" />
            </TabsContent>
            <TabsContent value="output">
              <JsonView value={run.output} empty={run.status === "RUNNING" ? "Running…" : "No output"} />
            </TabsContent>
            <TabsContent value="logs">
              {run.logs.length === 0 ? (
                <p className="text-xs text-muted-foreground">No logs.</p>
              ) : (
                <ol className="max-h-[50vh] space-y-1 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px]">
                  {run.logs.map((l, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="shrink-0 text-muted-foreground tabular-nums">{new Date(l.ts).toLocaleTimeString()}</span>
                      <span className={cn("shrink-0 uppercase", LOG_COLORS[l.level.toLowerCase()] ?? "text-info")}>{l.level}</span>
                      <span className="whitespace-pre-wrap break-words">{l.message}</span>
                    </li>
                  ))}
                </ol>
              )}
            </TabsContent>
            <TabsContent value="tools">
              {run.tool_calls.length === 0 ? (
                <p className="text-xs text-muted-foreground">No tool calls.</p>
              ) : (
                <ol className="space-y-2">
                  {run.tool_calls.map((t, i) => (
                    <li key={i} className="rounded-md border p-2">
                      <details>
                        <summary className="flex cursor-pointer items-center gap-2 text-xs">
                          <code className="font-mono font-medium">{t.tool}</code>
                          {t.error ? <Badge variant="destructive">error</Badge> : <Badge variant="success">ok</Badge>}
                          <span className="ml-auto text-muted-foreground tabular-nums">{formatDuration(t.duration_ms)}</span>
                        </summary>
                        <div className="mt-2 space-y-2">
                          <p className="text-[10px] font-semibold uppercase text-muted-foreground">Args</p>
                          <JsonView value={t.args} empty="No args" />
                          <p className="text-[10px] font-semibold uppercase text-muted-foreground">{t.error ? "Error" : "Result"}</p>
                          {t.error ? <p className="text-xs text-destructive">{t.error}</p> : <JsonView value={t.result} empty="No result" />}
                        </div>
                      </details>
                    </li>
                  ))}
                </ol>
              )}
            </TabsContent>
            <TabsContent value="errors">
              {errorsCount === 0 ? (
                <p className="text-xs text-muted-foreground">No errors.</p>
              ) : (
                <ul className="space-y-2">
                  {runs.filter((r) => r.error).map((r) => (
                    <li key={r.id} className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs">
                      <p className="mb-1 text-[10px] text-muted-foreground">Iteration {r.iteration} · attempt {r.attempt}</p>
                      <p className="whitespace-pre-wrap break-words text-destructive">{r.error}</p>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
            <TabsContent value="attempts">
              <ul className="space-y-1">
                {runs.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedRunId(r.id)}
                      aria-current={r.id === run.id}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs hover:bg-accent",
                        r.id === run.id && "border-primary bg-primary/5",
                      )}
                    >
                      <span className="tabular-nums">#{r.iteration}.{r.attempt}</span>
                      <StatusBadge status={r.status} />
                      <span className="ml-auto text-muted-foreground tabular-nums">{formatDuration(r.duration_ms)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  );
}
