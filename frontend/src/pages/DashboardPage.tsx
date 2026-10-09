import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Activity, ArrowRight, CheckCircle2, History, ShieldAlert, Workflow, XCircle, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, PageHeader } from "@/components/States";
import { StatusBadge } from "@/components/StatusBadge";
import { api, queryKeys } from "@/services/api";
import { cn, durationBetween, formatDuration, formatRelative } from "@/lib/utils";
import { RUN_STATUSES, type RunStatus } from "@/types";

const STATUS_BAR: Record<RunStatus, string> = {
  PENDING: "bg-muted-foreground/40",
  RUNNING: "bg-info",
  PAUSED: "bg-secondary-foreground/40",
  WAITING_APPROVAL: "bg-warning",
  COMPLETED: "bg-success",
  FAILED: "bg-destructive",
  CANCELLED: "bg-muted-foreground/25",
};

function StatCard({ label, value, icon: Icon, tone, to }: { label: string; value: number | undefined; icon: LucideIcon; tone: string; to?: string }) {
  const body = (
    <Card className={cn("transition-colors", to && "hover:border-foreground/20")}>
      <CardContent className="flex items-center gap-4 p-5">
        <div className={cn("flex size-10 items-center justify-center rounded-lg", tone)}>
          <Icon className="size-5" aria-hidden />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          {value === undefined ? <Skeleton className="mt-1 h-6 w-12" /> : <p className="text-2xl font-semibold tabular-nums tracking-tight">{value}</p>}
        </div>
      </CardContent>
    </Card>
  );
  return to ? (
    <Link to={to} className="rounded-xl focus-visible:outline-2 focus-visible:outline-ring">
      {body}
    </Link>
  ) : (
    body
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const stats = useQuery({ queryKey: queryKeys.stats, queryFn: api.stats, refetchInterval: 15_000 });
  const s = stats.data;
  const byStatus = s?.runs_by_status ?? {};
  const total = Object.values(byStatus).reduce((a, b) => a + (b ?? 0), 0);
  const completed = byStatus.COMPLETED ?? 0;
  const failed = byStatus.FAILED ?? 0;
  const successRate = completed + failed > 0 ? Math.round((completed / (completed + failed)) * 100) : null;

  if (stats.isError) return <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Overview of your workflows and executions."
        actions={
          <Button asChild size="sm">
            <Link to="/workflows">
              <Workflow /> Workflows
            </Link>
          </Button>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Workflows" value={s?.workflows} icon={Workflow} tone="bg-primary/10 text-primary" to="/workflows" />
        <StatCard label="Total runs" value={s?.runs_total} icon={History} tone="bg-secondary text-secondary-foreground" to="/executions" />
        <StatCard label="Active runs" value={s?.active_runs} icon={Activity} tone="bg-info/15 text-info" to="/executions?status=RUNNING" />
        <StatCard label="Succeeded" value={s ? completed : undefined} icon={CheckCircle2} tone="bg-success/15 text-success" to="/executions?status=COMPLETED" />
        <StatCard label="Pending approvals" value={s?.pending_approvals} icon={ShieldAlert} tone="bg-warning/20 text-amber-700 dark:text-warning" to="/approvals" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Runs by status</CardTitle>
            <CardDescription>
              {successRate === null ? "No finished runs yet" : `${successRate}% success rate (${completed} ok / ${failed} failed)`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!s ? (
              <Skeleton className="h-32" />
            ) : (
              <>
                <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" role="img" aria-label="Run status distribution">
                  {RUN_STATUSES.map((st) =>
                    (byStatus[st] ?? 0) > 0 ? (
                      <div key={st} className={STATUS_BAR[st]} style={{ width: `${((byStatus[st] ?? 0) / Math.max(total, 1)) * 100}%` }} />
                    ) : null,
                  )}
                </div>
                <ul className="space-y-1.5">
                  {RUN_STATUSES.map((st) => (
                    <li key={st}>
                      <Link to={`/executions?status=${st}`} className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent">
                        <span className={cn("size-2 rounded-full", STATUS_BAR[st])} aria-hidden />
                        <span className="capitalize">{st.replace("_", " ").toLowerCase()}</span>
                        <span className="ml-auto font-medium tabular-nums">{byStatus[st] ?? 0}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Recent runs</CardTitle>
              <CardDescription>Latest executions across all workflows</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/executions">
                View all <ArrowRight />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="px-0 pb-2">
            {!s ? (
              <div className="space-y-2 px-5">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-8" />
                ))}
              </div>
            ) : s.recent_runs.length === 0 ? (
              <div className="px-5 pb-3">
                <EmptyState icon={History} title="No runs yet" description="Run a workflow to see its execution here." />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-5">Workflow</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead className="pr-5 text-right">Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.recent_runs.map((r) => (
                    <TableRow key={r.id} className="cursor-pointer" onClick={() => navigate(`/executions/${r.id}`)}>
                      <TableCell className="pl-5">
                        <Link to={`/executions/${r.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                          {r.workflow_name}
                        </Link>
                        <span className="ml-1 text-xs text-muted-foreground">v{r.workflow_version}</span>
                        {r.error && <p className="max-w-xs truncate text-[11px] text-destructive">{r.error}</p>}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {formatDuration(durationBetween(r.started_at, r.finished_at))}
                      </TableCell>
                      <TableCell className="pr-5 text-right text-xs text-muted-foreground">{formatRelative(r.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
      {failed > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <XCircle className="size-3.5 text-destructive" aria-hidden />
          {failed} failed run{failed === 1 ? "" : "s"} —{" "}
          <Link to="/executions?status=FAILED" className="text-primary hover:underline">
            investigate
          </Link>
        </p>
      )}
    </div>
  );
}
