import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Power, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { authorizationPhrase, isBlocking, permissionStepId, sensitivePermissions } from "@/business/labels";
import { api, errorDetailField, errorMessage, queryKeys } from "@/services/api";
import type { Finding, Workflow } from "@/types";
import { CapabilityStatusBadge, FindingsList } from "./Pills";

export function EnableDialog({
  workflow,
  open,
  onOpenChange,
  canConnect,
}: {
  workflow: Workflow;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  canConnect: boolean;
}) {
  const qc = useQueryClient();
  const explanation = workflow.explanation ?? null;
  const sensitive = useMemo(
    () =>
      sensitivePermissions(explanation).map((p) => {
        const stepId = permissionStepId(p, workflow.plan, explanation);
        const app = explanation?.steps.find((s) => s.step_id === stepId)?.app ?? null;
        return { ...p, stepId, phrase: authorizationPhrase(p.side_effect, app) };
      }),
    [explanation, workflow.plan],
  );
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [serverError, setServerError] = useState<{ message: string; findings: Finding[]; missing: string[] } | null>(null);
  useEffect(() => {
    if (open) {
      setAcks({});
      setServerError(null);
    }
  }, [open]);

  const blocking = (explanation?.findings ?? []).filter((f) => isBlocking(f.severity));
  const missingConnections = (explanation?.integrations ?? []).filter((i) => i.status !== "available");
  const ready = explanation?.ready_to_enable ?? false;
  const allAcked = sensitive.every((p) => acks[p.stepId]);
  const canEnable = ready && allAcked;

  const enable = useMutation({
    mutationFn: () => api.enableWorkflow(workflow.id, { acknowledgements: [...new Set(sensitive.map((p) => p.stepId))] }),
    onSuccess: (wf) => {
      qc.setQueryData(queryKeys.workflow(workflow.id), wf);
      void qc.invalidateQueries({ queryKey: queryKeys.workflowsAll });
      toast.success(`“${wf.name}” is enabled`);
      onOpenChange(false);
    },
    onError: (e) => {
      setServerError({
        message: errorDetailField<string>(e, "message") ?? errorMessage(e),
        findings: errorDetailField<Finding[]>(e, "findings") ?? [],
        missing: errorDetailField<string[]>(e, "missing_acknowledgements") ?? [],
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Enable “{workflow.name}”</DialogTitle>
          <DialogDescription>
            Once enabled, people in the department can run version {workflow.version}
            {workflow.plan?.trigger.type === "schedule" ? " and it will start on its schedule" : ""}.
          </DialogDescription>
        </DialogHeader>

        {(blocking.length > 0 || missingConnections.length > 0 || !ready) && (
          <section className="space-y-2" aria-label="Setup requirements">
            <h3 className="text-xs font-semibold">Before you can enable it</h3>
            {missingConnections.length > 0 && (
              <ul className="space-y-1.5">
                {missingConnections.map((i) => (
                  <li key={i.connector} className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 text-xs">
                    <span className="font-medium">{i.label}</span>
                    <CapabilityStatusBadge status={i.status} />
                    {canConnect && i.status === "requires_connection" && (
                      <Button variant="outline" size="xs" asChild className="ml-auto">
                        <Link to="/settings/connections">Connect</Link>
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <FindingsList findings={blocking} />
            {!ready && blocking.length === 0 && missingConnections.length === 0 && (
              <p className="text-xs text-muted-foreground">This workflow is not ready to be enabled yet.</p>
            )}
          </section>
        )}

        <section className="space-y-2" aria-label="Authorizations">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold">
            <ShieldCheck className="size-4 text-info" aria-hidden /> Your authorization
          </h3>
          {sensitive.length === 0 ? (
            <p className="text-xs text-muted-foreground">This workflow does not send messages, change other systems or perform financial actions.</p>
          ) : (
            <ul className="space-y-2">
              {sensitive.map((p) => {
                const id = `ack-${p.stepId}`;
                return (
                  <li key={p.stepId} className="flex items-start gap-2.5 rounded-md border px-3 py-2.5">
                    <Checkbox
                      id={id}
                      checked={!!acks[p.stepId]}
                      onCheckedChange={(c) => setAcks((a) => ({ ...a, [p.stepId]: c === true }))}
                    />
                    <Label htmlFor={id} className="cursor-pointer text-sm font-normal leading-snug">
                      I authorize this workflow to <b>{p.phrase}</b>
                      <span className="block text-xs text-muted-foreground">Step: {p.step}</span>
                    </Label>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {serverError && (
          <div role="alert" className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
            <p className="font-medium text-destructive">{serverError.message}</p>
            {serverError.missing.length > 0 && <p>Still needs your authorization: {serverError.missing.join(", ")}</p>}
            <FindingsList findings={serverError.findings} />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => enable.mutate()} disabled={!canEnable || enable.isPending}>
            {enable.isPending ? <Spinner className="text-primary-foreground" /> : <Power />} Enable workflow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
