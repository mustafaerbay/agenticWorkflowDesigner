import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiError, queryKeys } from "@/services/api";
import { isPlainObject, parseJson, prettyJson } from "@/lib/utils";
import type { Issue, JSONObject } from "@/types";

export function RunWorkflowDialog({
  open,
  onOpenChange,
  workflowId,
  workflowName,
  defaultInput,
  beforeRun,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workflowId: string;
  workflowName: string;
  /** Prefill (start node default_input). */
  defaultInput: unknown;
  /** e.g. save unsaved editor changes first; return false to abort */
  beforeRun?: () => Promise<boolean>;
}) {
  const [text, setText] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const navigate = useNavigate();
  const qc = useQueryClient();

  useEffect(() => {
    if (open) {
      setText(prettyJson(defaultInput ?? {}) || "{}");
      setError(null);
      setIssues([]);
    }
  }, [open, defaultInput]);

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
      if (e instanceof ApiError && e.validation) {
        setIssues(e.validation.errors);
        setError("The workflow is invalid. Fix these issues and try again.");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
  });

  const submit = () => {
    const r = parseJson(text.trim() || "{}");
    if (!r.ok) return setError(`Invalid JSON: ${r.error}`);
    if (!isPlainObject(r.value)) return setError("Input must be a JSON object");
    setError(null);
    setIssues([]);
    run.mutate(r.value as JSONObject);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Run “{workflowName}”</DialogTitle>
          <DialogDescription>Provide the execution input. It is available to nodes as <code className="font-mono">input.*</code>.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="run-input">Input (JSON)</Label>
          <Textarea
            id="run-input"
            rows={12}
            spellCheck={false}
            className="font-mono text-xs"
            value={text}
            aria-invalid={!!error}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
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
