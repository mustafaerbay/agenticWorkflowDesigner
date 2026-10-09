import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  Copy,
  Download,
  FileUp,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RunWorkflowDialog } from "@/components/RunWorkflowDialog";
import { EmptyState, ErrorState, PageHeader, TableSkeleton } from "@/components/States";
import { StatusBadge } from "@/components/StatusBadge";
import { api, errorMessage, queryKeys } from "@/services/api";
import { downloadJson, formatRelative, isPlainObject, slugify } from "@/lib/utils";
import type { WorkflowExport, WorkflowSummary } from "@/types";
import { defaultInputOf, emptyDefinition } from "@/workflow/serialization";

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function CreateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const qc = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
    }
  }, [open]);
  const create = useMutation({
    mutationFn: () => api.createWorkflow({ name: name.trim(), description: description.trim() || undefined, definition: emptyDefinition() }),
    onSuccess: (wf) => {
      void qc.invalidateQueries({ queryKey: queryKeys.workflowsAll });
      toast.success("Workflow created");
      onOpenChange(false);
      navigate(`/workflows/${wf.id}/edit`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>New workflow</DialogTitle>
            <DialogDescription>Starts with a single Start node. You can design the rest in the editor.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="wf-name">Name</Label>
            <Input id="wf-name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Feature delivery pipeline" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wf-desc">Description</Label>
            <Textarea id="wf-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending ? <Spinner className="text-primary-foreground" /> : <Plus />} Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RunFromList({ wf, onClose }: { wf: WorkflowSummary; onClose: () => void }) {
  const full = useQuery({ queryKey: queryKeys.workflow(wf.id), queryFn: () => api.getWorkflow(wf.id) });
  return (
    <RunWorkflowDialog
      open
      onOpenChange={(o) => !o && onClose()}
      workflowId={wf.id}
      workflowName={wf.name}
      defaultInput={full.data ? defaultInputOf(full.data.definition) : {}}
    />
  );
}

export default function WorkflowsPage() {
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search.trim(), 250);
  const [createOpen, setCreateOpen] = useState(false);
  const [toDelete, setToDelete] = useState<WorkflowSummary | null>(null);
  const [toRun, setToRun] = useState<WorkflowSummary | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const list = useQuery({ queryKey: queryKeys.workflows(debounced), queryFn: () => api.listWorkflows(debounced || undefined) });
  const invalidate = () => void qc.invalidateQueries({ queryKey: queryKeys.workflowsAll });

  const duplicate = useMutation({
    mutationFn: (id: string) => api.duplicateWorkflow(id),
    onSuccess: (wf) => {
      invalidate();
      toast.success(`Duplicated as “${wf.name}”`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWorkflow(id),
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: queryKeys.stats });
      toast.success("Workflow deleted");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const importWf = useMutation({
    mutationFn: (doc: WorkflowExport) => api.importWorkflow(doc),
    onSuccess: (wf) => {
      invalidate();
      toast.success(`Imported “${wf.name}”`);
      navigate(`/workflows/${wf.id}/edit`);
    },
    onError: (e) => toast.error(`Import failed: ${errorMessage(e)}`),
  });

  const exportWf = async (wf: WorkflowSummary) => {
    try {
      const doc = await api.exportWorkflow(wf.id);
      downloadJson(`${slugify(wf.name)}.workflow.json`, doc);
    } catch (e) {
      toast.error(`Export failed: ${errorMessage(e)}`);
    }
  };

  const onFile = async (file: File) => {
    try {
      const doc = JSON.parse(await file.text()) as unknown;
      if (!isPlainObject(doc) || !isPlainObject(doc.definition)) {
        toast.error('Not a workflow export: expected an object with a "definition"');
        return;
      }
      importWf.mutate(doc as unknown as WorkflowExport);
    } catch {
      toast.error("Could not read file: invalid JSON");
    }
  };

  return (
    <div>
      <PageHeader
        title="Workflows"
        description="Design multi-agent SDLC workflows and run them."
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              aria-label="Import workflow file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
                e.target.value = "";
              }}
            />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={importWf.isPending}>
              {importWf.isPending ? <Spinner /> : <FileUp />} Import
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus /> New workflow
            </Button>
          </>
        }
      />

      <div className="mb-4 flex items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input className="pl-8" placeholder="Search workflows" aria-label="Search workflows" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {list.isFetching && !list.isLoading && <Spinner />}
      </div>

      <Card className="overflow-hidden">
        {list.isLoading ? (
          <TableSkeleton rows={5} cols={5} />
        ) : list.isError ? (
          <ErrorState className="m-4" error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data!.length === 0 ? (
          <EmptyState
            className="m-4"
            icon={WorkflowIcon}
            title={debounced ? "No workflows match your search" : "No workflows yet"}
            description={debounced ? "Try a different search term." : "Create your first workflow or import an exported one."}
            action={
              !debounced && (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus /> New workflow
                </Button>
              )
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Nodes</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data!.map((wf) => (
                <TableRow key={wf.id}>
                  <TableCell className="max-w-md pl-4">
                    <div className="flex items-center gap-2">
                      <Link to={`/workflows/${wf.id}/edit`} className="font-medium hover:underline">
                        {wf.name}
                      </Link>
                      {wf.is_example && <Badge variant="secondary">example</Badge>}
                    </div>
                    {wf.description && <p className="truncate text-xs text-muted-foreground">{wf.description}</p>}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{wf.node_count}</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">v{wf.version}</TableCell>
                  <TableCell>
                    <StatusBadge status={wf.last_run_status} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatRelative(wf.updated_at)}</TableCell>
                  <TableCell className="pr-4">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setToRun(wf)} aria-label={`Run ${wf.name}`}>
                        <Play /> <span className="hidden lg:inline">Run</span>
                      </Button>
                      <Button variant="ghost" size="sm" asChild>
                        <Link to={`/workflows/${wf.id}/edit`} aria-label={`Edit ${wf.name}`}>
                          <Pencil /> <span className="hidden lg:inline">Edit</span>
                        </Link>
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${wf.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => duplicate.mutate(wf.id)}>
                            <Copy /> Duplicate
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void exportWf(wf)}>
                            <Download /> Export JSON
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => navigate(`/executions?workflow_id=${wf.id}`)}>
                            <Play /> View runs
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem destructive onSelect={() => setToDelete(wf)}>
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <CreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      {toRun && <RunFromList wf={toRun} onClose={() => setToRun(null)} />}
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`Delete “${toDelete?.name}”?`}
        description="The workflow and all of its versions will be deleted. Past executions remain in history. This cannot be undone."
        confirmLabel="Delete workflow"
        destructive
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </div>
  );
}
