import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Eye } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/Field";
import { stepKindLabel } from "@/business/labels";
import { draftFor, editableParamFields, paramKind, stepEditOperations, type StepDraft } from "@/business/stepEdits";
import { api, ApiError, errorDetailField, errorMessage, queryKeys } from "@/services/api";
import { useCapabilities } from "@/services/queries";
import type { Finding, PlanOperation, Proposal, Workflow } from "@/types";
import { DiffView } from "./Explanation";
import { FindingsList, PolicyBadge } from "./Pills";

/** Business step list editor: titles, descriptions, simple details, approval instructions and retries. */
export function EditStepsDialog({ workflow, open, onOpenChange }: { workflow: Workflow; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const plan = workflow.plan!;
  const caps = useCapabilities(workflow.department ?? plan.department);
  const [drafts, setDrafts] = useState<Record<string, StepDraft>>({});
  const [review, setReview] = useState<{ ops: PlanOperation[]; proposal: Proposal } | null>(null);
  const [error, setError] = useState<{ message: string; findings: Finding[] } | null>(null);

  useEffect(() => {
    if (!open) return;
    const d: Record<string, StepDraft> = {};
    for (const s of plan.steps) d[s.id] = draftFor(s, caps.data?.find((c) => s.kind === "action" && c.id === s.capability));
    setDrafts(d);
    setReview(null);
    setError(null);
  }, [open, plan, caps.data]);

  const setDraft = (id: string, patch: Partial<StepDraft>) => setDrafts((all) => ({ ...all, [id]: { ...all[id]!, ...patch } }));

  const preview = useMutation({
    mutationFn: (ops: PlanOperation[]) => api.previewPlan(workflow.id, ops),
    onSuccess: (proposal, ops) => {
      setReview({ ops, proposal });
      setError(null);
    },
    onError: (e) => setError({ message: errorDetailField<string>(e, "message") ?? errorMessage(e), findings: errorDetailField<Finding[]>(e, "findings") ?? [] }),
  });
  const apply = useMutation({
    mutationFn: (ops: PlanOperation[]) =>
      api.applyPlan(workflow.id, { operations: ops, base_version: workflow.version, summary: "Edited steps" }),
    onSuccess: (wf) => {
      qc.setQueryData(queryKeys.workflow(workflow.id), wf);
      void qc.invalidateQueries({ queryKey: queryKeys.workflowsAll });
      toast.success(`Saved · version ${wf.version}`);
      onOpenChange(false);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        setError({ message: "Someone else changed this workflow since you opened it. Close this editor and reload to see the latest version.", findings: [] });
        void qc.invalidateQueries({ queryKey: queryKeys.workflow(workflow.id) });
        return;
      }
      setError({ message: errorDetailField<string>(e, "message") ?? errorMessage(e), findings: errorDetailField<Finding[]>(e, "findings") ?? [] });
    },
  });

  const submitReview = () => {
    const ops = stepEditOperations(plan, drafts, caps.data ?? []);
    if (ops.length === 0) {
      setError({ message: "You haven't changed anything yet.", findings: [] });
      return;
    }
    preview.mutate(ops);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{review ? "Review your changes" : "Edit steps"}</DialogTitle>
          <DialogDescription>
            {review
              ? "This is what will change. Nothing is saved until you confirm."
              : "Change names, descriptions and simple details. To add, remove or rearrange steps, use Edit with AI."}
          </DialogDescription>
        </DialogHeader>

        {review ? (
          <div className="space-y-4">
            <DiffView diff={review.proposal.diff} empty="No visible changes." />
            {review.proposal.findings.length > 0 && <FindingsList findings={review.proposal.findings} />}
          </div>
        ) : (
          <ol className="space-y-3">
            {plan.steps.map((s, i) => {
              const d = drafts[s.id];
              if (!d) return null;
              const cap = s.kind === "action" ? caps.data?.find((c) => c.id === s.capability) : undefined;
              const paramFields = editableParamFields(s, cap);
              const bound = s.kind === "action" && cap ? cap.inputs.filter((f) => !paramFields.includes(f) && f.key in s.params) : [];
              return (
                <li key={s.id} className="space-y-3 rounded-lg border p-3" aria-label={`Step ${i + 1}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs tabular-nums text-muted-foreground">{i + 1}.</span>
                    <Badge variant="muted">{stepKindLabel(s.kind)}</Badge>
                    {cap && <span className="text-xs text-muted-foreground">{cap.app}</span>}
                    {s.policy_inserted && <PolicyBadge />}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Step name">
                      {(id) => <Input id={id} value={d.title} onChange={(e) => setDraft(s.id, { title: e.target.value })} />}
                    </Field>
                    {s.kind === "action" && (
                      <Field label="Retries if it fails" hint="How many times to try in total (1–10).">
                        {(id) => (
                          <Input id={id} type="number" min={1} max={10} value={d.retry} placeholder="1" onChange={(e) => setDraft(s.id, { retry: e.target.value })} />
                        )}
                      </Field>
                    )}
                  </div>
                  <Field label="Description">
                    {(id) => <Textarea id={id} rows={2} value={d.description} onChange={(e) => setDraft(s.id, { description: e.target.value })} />}
                  </Field>
                  {s.kind === "approval" && (
                    <Field label="Instructions for the approver">
                      {(id) => <Textarea id={id} rows={2} value={d.instructions} onChange={(e) => setDraft(s.id, { instructions: e.target.value })} />}
                    </Field>
                  )}
                  {paramFields.length > 0 && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {paramFields.map((f) => {
                        const kind = paramKind(f, s.kind === "action" ? s.params[f.key] : undefined);
                        return (
                          <Field key={f.key} label={f.label} hint={kind === "list" ? "Separate items with commas." : f.description}>
                            {(id) => (
                              <Input
                                id={id}
                                type={kind === "number" ? "number" : "text"}
                                value={d.params[f.key] ?? ""}
                                onChange={(e) => setDraft(s.id, { params: { ...d.params, [f.key]: e.target.value } })}
                              />
                            )}
                          </Field>
                        );
                      })}
                    </div>
                  )}
                  {bound.length > 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      Filled in automatically: {bound.map((f) => f.label).join(", ")}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {error && (
          <div role="alert" className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
            <p className="text-destructive">{error.message}</p>
            <FindingsList findings={error.findings} />
          </div>
        )}

        <DialogFooter>
          {review ? (
            <>
              <Button variant="outline" onClick={() => setReview(null)}>
                <ArrowLeft /> Back to editing
              </Button>
              <Button onClick={() => apply.mutate(review.ops)} disabled={apply.isPending}>
                {apply.isPending ? <Spinner className="text-primary-foreground" /> : <Check />} Save changes
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={submitReview} disabled={preview.isPending || caps.isLoading}>
                {preview.isPending ? <Spinner className="text-primary-foreground" /> : <Eye />} Review changes
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
