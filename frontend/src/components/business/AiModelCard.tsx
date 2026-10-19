import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Cpu, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage, queryKeys } from "@/services/api";
import { useProviders } from "@/services/queries";
import type { AiModelInfo, Workflow } from "@/types";

export function describeAiModel(info: AiModelInfo | undefined | null): string {
  if (!info || !info.provider) return "No AI model configured (add one in Model Settings)";
  return `${info.provider} · ${info.model ?? "default model"}`;
}

const SOURCE_LABEL: Record<string, string> = {
  default: "platform default",
  workflow: "chosen for this workflow",
  step: "chosen for this step",
};

export function aiSourceLabel(source: string | undefined): string {
  return SOURCE_LABEL[source ?? "default"] ?? "";
}

/** The AI model this workflow's AI steps use (individual steps can override it in Edit steps). */
export function AiModelCard({ workflow, canEdit }: { workflow: Workflow; canEdit: boolean }) {
  const info = workflow.explanation?.ai_model;
  const usesAi = (workflow.explanation?.steps ?? []).some((s) => s.ai_model);
  const providers = useProviders();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  useEffect(() => {
    if (!editing) return;
    setProvider(workflow.plan?.ai?.provider_id ?? "");
    setModel(workflow.plan?.ai?.model ?? "");
  }, [editing, workflow.plan]);

  const save = useMutation({
    mutationFn: () =>
      api.applyPlan(workflow.id, {
        base_version: workflow.version,
        summary: "Changed the AI model",
        operations: [{ op: "set_ai_model", step_id: null, provider_id: provider || null, model: model.trim() || null }],
      }),
    onSuccess: (wf) => {
      qc.setQueryData(queryKeys.workflow(workflow.id), wf);
      void qc.invalidateQueries({ queryKey: queryKeys.workflowsAll });
      toast.success("AI model saved");
      setEditing(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!usesAi) return null;
  const overrides = (workflow.explanation?.steps ?? []).filter((s) => s.ai_model?.source === "step").length;
  const selected = (providers.data ?? []).find((p) => p.id === provider);
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Cpu className="size-4 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium">AI model</p>
              <p className="text-xs text-muted-foreground" data-testid="ai-model-summary">
                {describeAiModel(info)} · {aiSourceLabel(info?.source)}
                {overrides > 0 && ` · ${overrides} step${overrides > 1 ? "s use" : " uses"} a different model`}
              </p>
            </div>
          </div>
          {canEdit && !editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil /> Change model
            </Button>
          )}
        </div>
        {editing && (
          <form
            className="grid gap-3 border-t pt-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="ai-provider">Provider</Label>
              <Select id="ai-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="">Platform default</option>
                {(providers.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.is_default ? " (default)" : ""}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-model">Model</Label>
              <Input
                id="ai-model"
                className="font-mono"
                value={model}
                placeholder={selected?.default_model ?? "provider's default model"}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
            <p className="text-[11px] text-muted-foreground sm:col-span-2">
              Applies to every AI step unless a step chooses its own model in Edit steps. Changing the model keeps the workflow enabled;
              runs that already started keep the model they started with.
            </p>
            <div className="flex justify-end gap-2 sm:col-span-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={save.isPending}>
                {save.isPending && <Spinner className="text-primary-foreground" />} Save model
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
