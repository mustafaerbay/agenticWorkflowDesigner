import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Check, ExternalLink, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, ErrorState, PageHeader, TableSkeleton } from "@/components/States";
import { StatusBadge } from "@/components/StatusBadge";
import { api, errorMessage, queryKeys } from "@/services/api";
import { formatDate, formatRelative } from "@/lib/utils";
import type { Approval } from "@/types";

type Decision = { approval: Approval; decision: "approve" | "reject" };

export default function ApprovalsPage() {
  const [tab, setTab] = useState<"pending" | "decided">("pending");
  const [pendingDecision, setPendingDecision] = useState<Decision | null>(null);
  const [comment, setComment] = useState("");
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: queryKeys.approvals(tab === "pending" ? "pending" : undefined),
    queryFn: () => api.listApprovals(tab === "pending" ? "pending" : undefined),
    refetchInterval: 15_000,
  });
  const items = (list.data ?? []).filter((a) => (tab === "pending" ? a.status === "pending" : a.status !== "pending"));

  const decide = useMutation({
    mutationFn: (d: Decision) => api.decideApproval(d.approval.id, { decision: d.decision, comment: comment.trim() || undefined }),
    onSuccess: (a) => {
      toast.success(`${a.title}: ${a.status}`);
      setPendingDecision(null);
      setComment("");
      void qc.invalidateQueries({ queryKey: queryKeys.approvalsAll });
      void qc.invalidateQueries({ queryKey: queryKeys.stats });
      void qc.invalidateQueries({ queryKey: queryKeys.execution(a.run_id) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div>
      <PageHeader title="Approvals" description="Review and decide on human-in-the-loop checkpoints." />
      <Tabs value={tab} onValueChange={(v) => setTab(v as "pending" | "decided")} className="mb-4">
        <TabsList>
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="decided">Decided</TabsTrigger>
        </TabsList>
      </Tabs>
      {list.isLoading ? (
        <Card>
          <TableSkeleton rows={4} cols={3} />
        </Card>
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={tab === "pending" ? "Nothing waiting for you" : "No decided approvals yet"}
          description={tab === "pending" ? "Approval nodes in running workflows will show up here." : undefined}
        />
      ) : (
        <ul className="space-y-3">
          {items.map((a) => (
            <li key={a.id}>
              <Card>
                <CardContent className="flex flex-wrap items-start gap-4 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{a.title}</p>
                      <StatusBadge status={a.status} />
                    </div>
                    {a.description && <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{a.description}</p>}
                    <p className="mt-2 text-xs text-muted-foreground">
                      {a.workflow_name} · node <code className="font-mono">{a.node_id}</code> · requested {formatRelative(a.requested_at)}
                    </p>
                    {a.status !== "pending" && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {a.status === "cancelled" ? "Cancelled" : `Decided by ${a.decided_by ?? "unknown"}`} · {formatDate(a.decided_at)}
                        {a.comment && <> — “{a.comment}”</>}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" asChild>
                      <Link to={`/executions/${a.run_id}`}>
                        <ExternalLink /> View run
                      </Link>
                    </Button>
                    {a.status === "pending" && (
                      <>
                        <Button size="sm" variant="success" onClick={() => setPendingDecision({ approval: a, decision: "approve" })}>
                          <Check /> Approve
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => setPendingDecision({ approval: a, decision: "reject" })}>
                          <X /> Reject
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!pendingDecision} onOpenChange={(o) => !o && setPendingDecision(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pendingDecision?.decision === "approve" ? "Approve" : "Reject"} “{pendingDecision?.approval.title}”</DialogTitle>
            <DialogDescription>
              The workflow continues along the <b>{pendingDecision?.decision === "approve" ? "approved" : "rejected"}</b> branch.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="approval-comment">Comment (optional)</Label>
            <Textarea id="approval-comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDecision(null)}>
              Cancel
            </Button>
            <Button
              variant={pendingDecision?.decision === "approve" ? "success" : "destructive"}
              disabled={decide.isPending}
              onClick={() => pendingDecision && decide.mutate(pendingDecision)}
            >
              {decide.isPending && <Spinner className="text-white" />}
              {pendingDecision?.decision === "approve" ? "Approve" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
