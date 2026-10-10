import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, FlaskConical } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { buildSimulationRequest, initialInputValues, type SimulationForm } from "@/business/inputs";
import { api, errorMessage, queryKeys } from "@/services/api";
import { cn } from "@/lib/utils";
import type { BusinessPlan } from "@/types";
import { PlanInputsForm } from "./PlanInputsForm";

function emptyForm(plan: BusinessPlan): SimulationForm {
  const approvals: SimulationForm["approvals"] = {};
  for (const s of plan.steps) if (s.kind === "approval") approvals[s.id] = "approve";
  return { values: initialInputValues(plan.inputs), approvals, stepOutputs: {} };
}

/** Safe test run: sample input, approval outcomes and optional pretend step results. */
export function SimulateDialog({
  workflowId,
  workflowName,
  plan,
  department,
  open,
  onOpenChange,
}: {
  workflowId: string;
  workflowName: string;
  plan: BusinessPlan;
  department?: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState<SimulationForm>(() => emptyForm(plan));
  const [error, setError] = useState<string | null>(null);
  const [showPretend, setShowPretend] = useState(false);
  useEffect(() => {
    if (open) {
      setForm(emptyForm(plan));
      setError(null);
    }
  }, [open, plan]);

  const simulate = useMutation({
    mutationFn: (body: Parameters<typeof api.simulateWorkflow>[1]) => api.simulateWorkflow(workflowId, body),
    onSuccess: (run) => {
      toast.success("Simulation started");
      void qc.invalidateQueries({ queryKey: queryKeys.executionsAll });
      onOpenChange(false);
      navigate(`/executions/${run.id}`);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const submit = () => {
    const r = buildSimulationRequest(plan, form);
    if (!r.ok) return setError(r.error);
    setError(null);
    simulate.mutate(r.body);
  };

  const approvalSteps = plan.steps.filter((s) => s.kind === "approval");
  const actionSteps = plan.steps.filter((s) => s.kind === "action");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlaskConical className="size-5 text-violet-600 dark:text-violet-300" aria-hidden /> Simulate “{workflowName}”
            </DialogTitle>
            <DialogDescription>
              A safe practice run. Nothing is sent and no data is changed — steps that would do so return sample results.
            </DialogDescription>
          </DialogHeader>

          <section className="space-y-2" aria-label="Sample information">
            <h3 className="text-xs font-semibold">Sample information</h3>
            <PlanInputsForm inputs={plan.inputs} values={form.values} department={department} onChange={(values) => setForm((f) => ({ ...f, values }))} />
          </section>

          {approvalSteps.length > 0 && (
            <section className="space-y-2" aria-label="Approval outcomes">
              <h3 className="text-xs font-semibold">What should the approvers decide?</h3>
              <ul className="space-y-2">
                {approvalSteps.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2">
                    <span className="min-w-0 flex-1 text-sm">{s.title}</span>
                    <div role="radiogroup" aria-label={`Decision for ${s.title}`} className="flex gap-1">
                      {(["approve", "reject"] as const).map((choice) => {
                        const checked = (form.approvals[s.id] ?? "approve") === choice;
                        return (
                          <button
                            key={choice}
                            type="button"
                            role="radio"
                            aria-checked={checked}
                            onClick={() => setForm((f) => ({ ...f, approvals: { ...f.approvals, [s.id]: choice } }))}
                            className={cn(
                              "rounded-md border px-2.5 py-1 text-xs font-medium",
                              checked
                                ? choice === "approve"
                                  ? "border-success bg-success/15 text-success"
                                  : "border-destructive bg-destructive/10 text-destructive"
                                : "text-muted-foreground hover:bg-accent",
                            )}
                          >
                            {choice === "approve" ? "Approve" : "Reject"}
                          </button>
                        );
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {actionSteps.length > 0 && (
            <section className="space-y-2">
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
                aria-expanded={showPretend}
                onClick={() => setShowPretend((v) => !v)}
              >
                {showPretend ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
                Pretend a step returns… (optional)
              </button>
              {showPretend && (
                <div className="space-y-3">
                  <p className="text-[11px] text-muted-foreground">
                    Try a specific outcome, e.g. <code className="font-mono">{'{"amount": 12000}'}</code>. Leave empty to use the sample result.
                  </p>
                  {actionSteps.map((s) => (
                    <div key={s.id} className="space-y-1">
                      <Label htmlFor={`pretend-${s.id}`}>{s.title}</Label>
                      <Textarea
                        id={`pretend-${s.id}`}
                        rows={2}
                        spellCheck={false}
                        className="font-mono text-xs"
                        value={form.stepOutputs[s.id] ?? ""}
                        onChange={(e) => setForm((f) => ({ ...f, stepOutputs: { ...f.stepOutputs, [s.id]: e.target.value } }))}
                      />
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={simulate.isPending}>
              {simulate.isPending ? <Spinner className="text-primary-foreground" /> : <FlaskConical />} Run simulation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
