import { AlertTriangle, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { UnsupportedEdit } from "@/types";

/**
 * Shown when the Advanced editor's save of a plan-based workflow is rejected (422 `unsupported`).
 * Nothing was saved and nothing is dropped: the user keeps editing or detaches the workflow.
 */
export function UnsupportedEditDialog({
  open,
  onOpenChange,
  message,
  unsupported,
  onFocus,
  onDetach,
  detaching,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  message: string;
  unsupported: UnsupportedEdit[];
  onFocus: (nodeId: string) => void;
  onDetach: () => void;
  detaching: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" aria-describedby="unsupported-desc">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-amber-600 dark:text-warning" aria-hidden /> Some changes can't be saved to the business workflow
          </DialogTitle>
          <DialogDescription id="unsupported-desc">
            {message || "These edits can't be expressed as business steps."} Nothing was saved, and your changes are still on the canvas.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-64 space-y-1.5 overflow-auto" aria-label="Unsupported changes">
          {unsupported.map((u, i) => (
            <li key={i} className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
              <p>{u.message}</p>
              {u.node_id && (
                <Button variant="link" size="xs" className="h-auto px-0" onClick={() => onFocus(u.node_id!)}>
                  Show on canvas
                </Button>
              )}
            </li>
          ))}
        </ul>
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
          <p className="font-medium text-destructive">About detaching</p>
          <p className="mt-1 text-muted-foreground">
            Detaching turns this into an advanced-only workflow. Editing with AI, the step-by-step business view and approvals
            managed by company policy will no longer apply. This is recorded in the audit log and cannot be undone.
          </p>
        </div>
        <DialogFooter>
          <Button variant="destructive" onClick={onDetach} disabled={detaching}>
            {detaching ? <Spinner className="text-white" /> : <Unlink />} Detach from business plan
          </Button>
          <Button onClick={() => onOpenChange(false)} autoFocus>
            Keep editing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
