import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { FlaskConical, History, RefreshCw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, PageHeader, TableSkeleton } from "@/components/States";
import { StatusBadge } from "@/components/StatusBadge";
import { api, queryKeys } from "@/services/api";
import { statusLabel } from "@/lib/status";
import { durationBetween, formatDate, formatDuration } from "@/lib/utils";
import { RUN_STATUSES } from "@/types";

export default function ExecutionsPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const workflowId = params.get("workflow_id") ?? "";
  const [search, setSearch] = useState(params.get("search") ?? "");
  const navigate = useNavigate();

  useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (search.trim()) next.set("search", search.trim());
      else next.delete("search");
      if (next.toString() !== params.toString()) setParams(next, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [search, params, setParams]);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const filters = { status: status || undefined, workflow_id: workflowId || undefined, search: params.get("search") || undefined, limit: 100 };
  const runs = useQuery({
    queryKey: queryKeys.executions(filters),
    queryFn: () => api.listExecutions(filters),
    refetchInterval: 10_000,
  });
  const workflows = useQuery({ queryKey: queryKeys.workflows(""), queryFn: () => api.listWorkflows() });

  return (
    <div>
      <PageHeader
        title="Execution history"
        description="Search previous runs and inspect their node-level results."
        actions={
          <Button variant="outline" size="sm" onClick={() => void runs.refetch()} disabled={runs.isFetching}>
            {runs.isFetching ? <Spinner /> : <RefreshCw />} Refresh
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input className="pl-8" placeholder="Search runs" aria-label="Search runs" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select aria-label="Filter by status" className="w-44" value={status} onChange={(e) => setParam("status", e.target.value)}>
          <option value="">All statuses</option>
          {RUN_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </Select>
        <Select aria-label="Filter by workflow" className="w-56" value={workflowId} onChange={(e) => setParam("workflow_id", e.target.value)}>
          <option value="">All workflows</option>
          {workflows.data?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
        {(status || workflowId || params.get("search")) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setParams(new URLSearchParams(), { replace: true });
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
      <Card className="overflow-hidden">
        {runs.isLoading ? (
          <TableSkeleton rows={6} cols={5} />
        ) : runs.isError ? (
          <ErrorState className="m-4" error={runs.error} onRetry={() => void runs.refetch()} />
        ) : runs.data!.length === 0 ? (
          <EmptyState className="m-4" icon={History} title="No executions found" description="Runs matching your filters will appear here." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Workflow</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Steps</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="pr-4">Run ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data!.map((r) => (
                <TableRow key={r.id} className="cursor-pointer" onClick={() => navigate(`/executions/${r.id}`)}>
                  <TableCell className="max-w-sm pl-4">
                    <Link to={`/executions/${r.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                      {r.workflow_name}
                    </Link>
                    <span className="ml-1 text-xs text-muted-foreground">v{r.workflow_version}</span>
                    {r.error && <p className="truncate text-[11px] text-destructive" title={r.error}>{r.error}</p>}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <StatusBadge status={r.status} />
                      {r.mode === "simulation" && (
                        <Badge variant="outline" className="border-violet-500/50 text-violet-700 dark:text-violet-300">
                          <FlaskConical aria-hidden /> Simulation
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{r.steps}</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{formatDuration(durationBetween(r.started_at, r.finished_at))}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(r.started_at ?? r.created_at)}</TableCell>
                  <TableCell className="pr-4 font-mono text-[10px] text-muted-foreground">{r.id.slice(0, 8)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
