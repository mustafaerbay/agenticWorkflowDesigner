import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft, FlaskConical, History, ListChecks, Pencil, Play, Power, PowerOff, Sparkles, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RunWorkflowDialog } from "@/components/RunWorkflowDialog";
import { ErrorState } from "@/components/States";
import { StatusBadge } from "@/components/StatusBadge";
import { EditStepsDialog } from "@/components/business/EditStepsDialog";
import { EnableDialog } from "@/components/business/EnableDialog";
import { ExplanationView } from "@/components/business/Explanation";
import { DepartmentBadge, WorkflowStatusBadge } from "@/components/business/Pills";
import { PlanDiagram } from "@/components/business/PlanDiagram";
import { SimulateDialog } from "@/components/business/SimulateDialog";
import { departmentName, isAdmin } from "@/business/labels";
import { api, errorMessage, queryKeys } from "@/services/api";
import { useDepartments } from "@/services/queries";
import { useAuthStore } from "@/stores/auth";
import { formatRelative } from "@/lib/utils";

type DialogName = "edit" | "simulate" | "enable" | "disable" | "run" | null;

function RecentRuns({ workflowId }: { workflowId: string }) {
  const runs = useQuery({
    queryKey: queryKeys.executions({ workflow_id: workflowId, limit: 10 }),
    queryFn: () => api.listExecutions({ workflow_id: workflowId, limit: 10 }),
  });
  if (runs.isLoading) return <Skeleton className="h-24" />;
  if (runs.isError) return <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />;
  if (!runs.data?.length) return <p className="text-sm text-muted-foreground">No runs yet. Try a simulation first — it is completely safe.</p>;
  return (
    <ul className="divide-y rounded-lg border">
      {runs.data.map((r) => (
        <li key={r.id}>
          <Link to={`/executions/${r.id}`} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm hover:bg-accent">
            <StatusBadge status={r.status} />
            {r.mode === "simulation" && (
              <Badge variant="outline" className="border-violet-500/50 text-violet-700 dark:text-violet-300">
                <FlaskConical aria-hidden /> Simulation
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">v{r.workflow_version}</span>
            <span className="ml-auto text-xs text-muted-foreground">{formatRelative(r.created_at)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function WorkflowOverviewPage() {
  const { id } = useParams<{ id: string }>();
  const workflowId = id!;
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const departments = useDepartments();
  const [dialog, setDialog] = useState<DialogName>(null);
  const wfQuery = useQuery({ queryKey: queryKeys.workflow(workflowId), queryFn: () => api.getWorkflow(workflowId) });

  const disable = useMutation({
    mutationFn: () => api.disableWorkflow(workflowId),
    onSuccess: (wf) => {
      qc.setQueryData(queryKeys.workflow(workflowId), wf);
      void qc.invalidateQueries({ queryKey: queryKeys.workflowsAll });
      toast.success(`“${wf.name}” is disabled`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (wfQuery.isError) return <ErrorState error={wfQuery.error} onRetry={() => void wfQuery.refetch()} />;
  const wf = wfQuery.data;
  if (!wf) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  // Workflows without a business plan are edited in the advanced editor.
  if (!wf.has_plan || !wf.plan) return <Navigate to={`/workflows/${wf.id}/edit`} replace />;

  const status = wf.status ?? "draft";
  const enabled = status === "enabled";
  const canConnect = isAdmin(user);
  const dept = wf.department ?? wf.plan.department;
  const deptInfo = departments.data?.find((d) => d.code === dept);
  const newerDraft = enabled && wf.enabled_version != null && wf.enabled_version < wf.version;
  const canEdit = wf.can_edit !== false;
  const canEnable = wf.can_enable !== false;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link to="/workflows">
            <ArrowLeft /> Workflows
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight">{wf.name}</h1>
            <div className="flex flex-wrap items-center gap-1.5">
              <WorkflowStatusBadge wf={wf} />
              {dept && <DepartmentBadge name={departmentName(dept, departments.data)} sensitive={deptInfo?.sensitive} />}
              <Badge variant="muted">Version {wf.version}</Badge>
              <span className="text-xs text-muted-foreground">Updated {formatRelative(wf.updated_at)}</span>
            </div>
            {newerDraft && (
              <p className="text-xs text-amber-700 dark:text-warning">
                Version {wf.version} has changes that are not enabled yet. Runs still use version {wf.enabled_version}. Enable again to use the latest
                version.
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <>
                <Button variant="outline" size="sm" asChild>
                  <Link to={`/workflows/${wf.id}/builder`}>
                    <Sparkles /> Edit with AI
                  </Link>
                </Button>
                <Button variant="outline" size="sm" onClick={() => setDialog("edit")}>
                  <Pencil /> Edit steps
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link to={`/workflows/${wf.id}/edit`}>
                    <Wrench /> Advanced editor
                  </Link>
                </Button>
              </>
            )}
            <Button variant="outline" size="sm" asChild>
              <Link to={`/executions?workflow_id=${wf.id}`}>
                <History /> History
              </Link>
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setDialog("simulate")}>
              <FlaskConical /> Simulate
            </Button>
            {!canEnable ? null : enabled && !newerDraft ? (
              <Button variant="outline" size="sm" onClick={() => setDialog("disable")} disabled={disable.isPending}>
                {disable.isPending ? <Spinner /> : <PowerOff />} Disable
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setDialog("enable")}>
                <Power /> {newerDraft ? "Enable latest" : "Enable"}
              </Button>
            )}
            {enabled ? (
              <Button size="sm" onClick={() => setDialog("run")}>
                <Play /> Run
              </Button>
            ) : (
              <Tooltip content="Enable the workflow before running it. You can simulate it any time.">
                <span tabIndex={0}>
                  <Button size="sm" disabled>
                    <Play /> Run
                  </Button>
                </span>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">
            <ListChecks className="size-3.5" aria-hidden /> How it works
          </TabsTrigger>
          <TabsTrigger value="diagram">Diagram</TabsTrigger>
          <TabsTrigger value="runs">Recent runs</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Card>
            <CardContent className="p-5">
              {wf.explanation ? (
                <ExplanationView explanation={wf.explanation} canConnect={canConnect} />
              ) : (
                <p className="text-sm text-muted-foreground">No explanation is available for this workflow.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="diagram">
          <PlanDiagram definition={wf.definition} className="h-[560px] rounded-xl border bg-canvas" />
        </TabsContent>
        <TabsContent value="runs">
          <RecentRuns workflowId={wf.id} />
        </TabsContent>
      </Tabs>

      {dialog === "edit" && <EditStepsDialog workflow={wf} open onOpenChange={(o) => !o && setDialog(null)} />}
      {dialog === "simulate" && (
        <SimulateDialog
          workflowId={wf.id}
          workflowName={wf.name}
          plan={wf.plan}
          department={dept}
          open
          onOpenChange={(o) => !o && setDialog(null)}
        />
      )}
      {dialog === "enable" && <EnableDialog workflow={wf} open canConnect={canConnect} onOpenChange={(o) => !o && setDialog(null)} />}
      <RunWorkflowDialog
        open={dialog === "run"}
        onOpenChange={(o) => !o && setDialog(null)}
        workflowId={wf.id}
        workflowName={wf.name}
        definition={wf.definition}
        plan={wf.plan}
        department={dept}
      />
      <ConfirmDialog
        open={dialog === "disable"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Disable “${wf.name}”?`}
        description="It stops running on its schedule and nobody can start it until it is enabled again. Runs already in progress continue."
        confirmLabel="Disable"
        destructive
        onConfirm={() => disable.mutate()}
      />
    </div>
  );
}
