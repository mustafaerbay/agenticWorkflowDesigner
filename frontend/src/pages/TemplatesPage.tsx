import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, Eye, LayoutTemplate, Plug } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState, ErrorState, PageHeader } from "@/components/States";
import { RequirementsPanel, StepCards } from "@/components/business/Explanation";
import { CapabilityStatusBadge, DepartmentBadge } from "@/components/business/Pills";
import { departmentName, isAdmin } from "@/business/labels";
import { api, errorMessage, queryKeys } from "@/services/api";
import { useDepartments } from "@/services/queries";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/utils";
import type { WorkflowTemplate } from "@/types";

function NeedsLine({ t }: { t: WorkflowTemplate }) {
  if (t.runs_locally || t.needs.length === 0) {
    return (
      <Badge variant="success">
        <CheckCircle2 aria-hidden /> Runs locally
      </Badge>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="flex items-center gap-1 text-muted-foreground">
        <Plug className="size-3.5" aria-hidden /> Needs: {t.needs.map((n) => n.label).join(", ")}
      </span>
      {t.needs
        .filter((n) => n.status !== "available")
        .map((n) => (
          <CapabilityStatusBadge key={n.connector} status={n.status} />
        ))}
    </div>
  );
}

export default function TemplatesPage() {
  const [department, setDepartment] = useState<string>("");
  const [preview, setPreview] = useState<WorkflowTemplate | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const departments = useDepartments();
  const list = useQuery({
    queryKey: queryKeys.templates(department || undefined),
    queryFn: () => api.listTemplates(department || undefined),
  });
  const use = useMutation({
    mutationFn: (t: WorkflowTemplate) => api.useTemplate(t.id, { department: t.department }),
    onSuccess: (wf) => {
      void qc.invalidateQueries({ queryKey: queryKeys.workflowsAll });
      qc.setQueryData(queryKeys.workflow(wf.id), wf);
      toast.success(`Created “${wf.name}” from the template`);
      setPreview(null);
      navigate(`/workflows/${wf.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const filters = [{ code: "", name: "All departments" }, ...(departments.data ?? [])];

  return (
    <div>
      <PageHeader title="Templates" description="Ready-made workflows for common tasks. Use one as a starting point and adjust it to your team." />
      <div className="mb-5 flex flex-wrap gap-1.5" role="group" aria-label="Filter by department">
        {filters.map((d) => (
          <Button
            key={d.code || "all"}
            size="sm"
            variant={department === d.code ? "default" : "outline"}
            aria-pressed={department === d.code}
            onClick={() => setDepartment(d.code)}
          >
            {d.name}
          </Button>
        ))}
      </div>
      {list.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data!.length === 0 ? (
        <EmptyState icon={LayoutTemplate} title="No templates for this department yet" />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.data!.map((t) => (
            <li key={t.id}>
              <Card className="flex h-full flex-col">
                <CardContent className="flex flex-1 flex-col gap-3 p-5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <DepartmentBadge name={departmentName(t.department, departments.data)} />
                    <Badge variant="muted">
                      {t.step_count} step{t.step_count === 1 ? "" : "s"}
                    </Badge>
                  </div>
                  <div className="flex-1 space-y-1">
                    <h2 className="text-sm font-semibold">{t.name}</h2>
                    <p className="text-xs text-muted-foreground">{t.description}</p>
                  </div>
                  <NeedsLine t={t} />
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setPreview(t)} aria-label={`Preview ${t.name}`}>
                      <Eye /> Preview
                    </Button>
                    <Button size="sm" onClick={() => use.mutate(t)} disabled={use.isPending} aria-label={`Use template ${t.name}`}>
                      {use.isPending && use.variables?.id === t.id ? <Spinner className="text-primary-foreground" /> : <LayoutTemplate />} Use template
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-3xl">
          {preview && (
            <>
              <DialogHeader>
                <DialogTitle>{preview.name}</DialogTitle>
                <DialogDescription>{preview.explanation.summary || preview.description}</DialogDescription>
              </DialogHeader>
              <div className={cn("grid gap-5 md:grid-cols-[3fr_2fr]")}>
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">{preview.explanation.trigger}</p>
                  <StepCards explanation={preview.explanation} />
                </div>
                <RequirementsPanel explanation={preview.explanation} canConnect={isAdmin(user)} />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPreview(null)}>
                  Close
                </Button>
                <Button onClick={() => use.mutate(preview)} disabled={use.isPending}>
                  {use.isPending ? <Spinner className="text-primary-foreground" /> : <LayoutTemplate />} Use template
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
