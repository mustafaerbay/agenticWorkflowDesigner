import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { FileUploadField } from "@/components/business/FileUploadField";
import { coerceInputs, initialInputValues, planInputsOf, type InputValues } from "@/business/inputs";
import { PlanInputsForm } from "@/components/business/PlanInputsForm";
import { api, ApiError, errorDetailField, queryKeys } from "@/services/api";
import { useTools } from "@/services/queries";
import { missingRequired, runInputSpec } from "@/workflow/runInputs";
import { isPlainObject, parseJson, prettyJson } from "@/lib/utils";
import type { BusinessPlan, Issue, JSONObject, WorkflowDefinition } from "@/types";

export function RunWorkflowDialog({
  open,
  onOpenChange,
  workflowId,
  workflowName,
  definition,
  beforeRun,
  plan,
  department,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workflowId: string;
  workflowName: string;
  /** Used to prefill the input (start default_input + required fields) and check required fields. */
  definition: WorkflowDefinition | null | undefined;
  /** e.g. save unsaved editor changes first; return false to abort */
  beforeRun?: () => Promise<boolean>;
  /** Business plan (if any): its file inputs get an upload control. */
  plan?: BusinessPlan | null;
  department?: string | null;
}) {
  const [text, setText] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const tools = useTools();
  const spec = useMemo(() => runInputSpec(definition, tools.data ?? []), [definition, tools.data]);
  const edited = useRef(false);
  const fileInputs = useMemo(() => planInputsOf(plan, definition).filter((i) => i.type === "file"), [plan, definition]);
  // Business workflows get a plain form instead of JSON.
  const businessInputs = plan ? plan.inputs : null;
  const [values, setValues] = useState<InputValues>({});
  const currentObject = (): JSONObject | null => {
    const r = parseJson(text.trim() || "{}");
    return r.ok && isPlainObject(r.value) ? (r.value as JSONObject) : null;
  };
  const setFileId = (key: string, fileId: string) => {
    const obj = currentObject();
    if (!obj) {
      setError("Fix the input JSON before attaching a file");
      return;
    }
    const next = { ...obj };
    if (fileId) next[key] = fileId;
    else delete next[key];
    edited.current = true;
    setText(prettyJson(next));
    setError(null);
  };

  useEffect(() => {
    edited.current = false;
    setError(null);
    setIssues([]);
  }, [open]);

  useEffect(() => {
    // Prefill examples once the plan is known (it may load after the dialog opens).
    if (open && businessInputs) setValues((v) => (Object.keys(v).length ? v : initialInputValues(businessInputs)));
    if (!open) setValues({});
  }, [open, businessInputs]);

  useEffect(() => {
    // Refresh the prefill (e.g. once tools load) until the user starts editing.
    if (open && !edited.current) setText(prettyJson(spec.prefill) || "{}");
  }, [open, spec]);

  const run = useMutation({
    mutationFn: async (input: JSONObject) => {
      if (beforeRun && !(await beforeRun())) throw new Error("Save the workflow before running it");
      return api.executeWorkflow(workflowId, input);
    },
    onSuccess: (r) => {
      toast.success("Run started");
      void qc.invalidateQueries({ queryKey: queryKeys.executionsAll });
      void qc.invalidateQueries({ queryKey: queryKeys.stats });
      onOpenChange(false);
      navigate(`/executions/${r.id}`);
    },
    onError: (e) => {
      const missingInputs = errorDetailField<string[]>(e, "missing_inputs");
      if (Array.isArray(missingInputs) && missingInputs.length) {
        setError(`Missing required input${missingInputs.length > 1 ? "s" : ""}: ${missingInputs.join(", ")}`);
        return;
      }
      if (e instanceof ApiError && e.validation) {
        setIssues(e.validation.errors);
        setError("The workflow is invalid. Fix these issues and try again.");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
  });

  const submit = () => {
    if (businessInputs) {
      const { input, missing, invalid } = coerceInputs(businessInputs, values);
      if (missing.length) return setError(`Please fill in: ${missing.join(", ")}`);
      if (invalid.length) return setError(`Please enter a number for: ${invalid.join(", ")}`);
      setError(null);
      setIssues([]);
      run.mutate(input);
      return;
    }
    const r = parseJson(text.trim() || "{}");
    if (!r.ok) return setError(`Invalid JSON: ${r.error}`);
    if (!isPlainObject(r.value)) return setError("Input must be a JSON object");
    const missing = missingRequired(spec, r.value as JSONObject);
    if (missing.length > 0) {
      return setError(`Missing required input${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
    }
    setError(null);
    setIssues([]);
    run.mutate(r.value as JSONObject);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Run “{workflowName}”</DialogTitle>
          <DialogDescription>
            {businessInputs ? (
              "Fill in the information this workflow needs."
            ) : (
              <>
                Provide the execution input. It is available to nodes as <code className="font-mono">input.*</code>.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {businessInputs && (
          <div className="space-y-3">
            <PlanInputsForm inputs={businessInputs} values={values} department={department} onChange={setValues} />
            {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          </div>
        )}
        {!businessInputs && fileInputs.length > 0 && (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-3" aria-label="Files">
            <p className="text-xs font-medium">Files</p>
            {fileInputs.map((fi) => {
              const value = currentObject()?.[fi.key];
              return (
                <div key={fi.key} className="space-y-1">
                  <Label htmlFor={`run-file-${fi.key}`}>
                    {fi.label}
                    {fi.required && <span className="text-destructive"> *</span>}
                  </Label>
                  <FileUploadField
                    id={`run-file-${fi.key}`}
                    label={fi.label}
                    value={typeof value === "string" ? value : ""}
                    department={department}
                    onChange={(fileId) => setFileId(fi.key, fileId)}
                  />
                </div>
              );
            })}
          </div>
        )}
        {!businessInputs && (
        <div className="space-y-1.5">
          <Label htmlFor="run-input">Input (JSON)</Label>
          <Textarea
            id="run-input"
            rows={12}
            spellCheck={false}
            className="font-mono text-xs"
            value={text}
            aria-invalid={!!error}
            onChange={(e) => {
              edited.current = true;
              setText(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
          {(spec.required.length > 0 || spec.optional.length > 0) && (
            <div className="space-y-0.5 text-xs text-muted-foreground" data-testid="run-input-hints">
              {spec.required.length > 0 && (
                <p>
                  Required:{" "}
                  {spec.required.map((k, i) => (
                    <span key={k}>
                      {i > 0 && ", "}
                      <code className="font-mono text-foreground">{k}</code>
                    </span>
                  ))}
                </p>
              )}
              {spec.optional.length > 0 && (
                <p>
                  Optional:{" "}
                  {spec.optional.map((k, i) => (
                    <span key={k}>
                      {i > 0 && ", "}
                      <code className="font-mono">{k}</code>
                    </span>
                  ))}
                </p>
              )}
            </div>
          )}
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          {issues.length > 0 && (
            <ul className="max-h-40 list-disc space-y-0.5 overflow-auto pl-5 text-xs text-destructive">
              {issues.map((i, k) => (
                <li key={k}>
                  {i.node_id && <code className="font-mono">{i.node_id}: </code>}
                  {i.message}
                </li>
              ))}
            </ul>
          )}
        </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={run.isPending}>
            {run.isPending ? <Spinner className="text-primary-foreground" /> : <Play />} Run workflow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
