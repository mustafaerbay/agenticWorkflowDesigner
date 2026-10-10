import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bell, Check, ClipboardList, ExternalLink, Inbox } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, ErrorState, PageHeader, TableSkeleton } from "@/components/States";
import { api, errorMessage, queryKeys } from "@/services/api";
import { unreadCount, useInbox } from "@/services/queries";
import { formatDate, formatRelative } from "@/lib/utils";
import type { InboxItem } from "@/types";

export default function InboxPage() {
  const [tab, setTab] = useState<"open" | "done">("open");
  const qc = useQueryClient();
  const list = useInbox();
  const done = useMutation({
    mutationFn: (id: string) => api.markInboxDone(id),
    onSuccess: (item) => {
      qc.setQueryData<InboxItem[]>(queryKeys.inbox, (all) => all?.map((x) => (x.id === item.id ? item : x)));
      void qc.invalidateQueries({ queryKey: queryKeys.inbox });
      toast.success(item.kind === "task" ? "Task completed" : "Marked as read");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const items = (list.data ?? [])
    .filter((i) => (tab === "open" ? !i.done_at : !!i.done_at))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <div>
      <PageHeader title="Inbox" description="Notifications and tasks that workflows send to you." />
      <Tabs value={tab} onValueChange={(v) => setTab(v as "open" | "done")} className="mb-4">
        <TabsList>
          <TabsTrigger value="open">
            Open {unreadCount(list.data) > 0 && <span className="text-muted-foreground">{unreadCount(list.data)}</span>}
          </TabsTrigger>
          <TabsTrigger value="done">Done</TabsTrigger>
        </TabsList>
      </Tabs>
      {list.isLoading ? (
        <Card>
          <TableSkeleton rows={3} cols={2} />
        </Card>
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={Inbox} title={tab === "open" ? "You're all caught up" : "Nothing done yet"} />
      ) : (
        <ul className="space-y-3">
          {items.map((i) => {
            const Icon = i.kind === "task" ? ClipboardList : Bell;
            const overdue = i.due_at && !i.done_at && new Date(i.due_at).getTime() < Date.now();
            return (
              <li key={i.id}>
                <Card>
                  <CardContent className="flex flex-wrap items-start gap-3 p-4">
                    <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{i.title}</p>
                        <Badge variant={i.kind === "task" ? "info" : "muted"}>{i.kind === "task" ? "Task" : "Notification"}</Badge>
                        {overdue && <Badge variant="destructive">Overdue</Badge>}
                      </div>
                      {i.body && <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{i.body}</p>}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatRelative(i.created_at)}
                        {i.due_at && <> · due {formatDate(i.due_at)}</>}
                        {i.done_at && <> · done {formatRelative(i.done_at)}</>}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {i.run_id && (
                        <Button variant="ghost" size="sm" asChild>
                          <Link to={`/executions/${i.run_id}`}>
                            <ExternalLink /> View run
                          </Link>
                        </Button>
                      )}
                      {!i.done_at && (
                        <Button size="sm" variant="outline" onClick={() => done.mutate(i.id)} disabled={done.isPending && done.variables === i.id}>
                          {done.isPending && done.variables === i.id ? <Spinner /> : <Check />} {i.kind === "task" ? "Mark done" : "Mark read"}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
