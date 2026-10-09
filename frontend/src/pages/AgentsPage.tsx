import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Pencil, Plus, Trash2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Field } from "@/components/Field";
import { EmptyState, ErrorState, PageHeader } from "@/components/States";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, queryKeys } from "@/services/api";
import { useAgents, usePresets } from "@/services/queries";
import { formatRelative } from "@/lib/utils";
import type { Agent, AgentIn, AgentNodeConfig } from "@/types";
import { AgentConfigForm } from "@/workflow/editor/AgentConfigForm";
import { defaultAgentConfig } from "@/workflow/nodeMeta";

interface Draft {
  name: string;
  description: string;
  preset: string;
  config: AgentNodeConfig;
}

function toDraft(a?: Agent): Draft {
  if (!a) return { name: "", description: "", preset: "", config: defaultAgentConfig() };
  return {
    name: a.name,
    description: a.description ?? "",
    preset: a.preset ?? "",
    config: { ...defaultAgentConfig(), ...a.config, kind: a.kind, preset: a.preset ?? null },
  };
}

function toAgentIn(d: Draft): AgentIn {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { agent_id: _ignored, ...config } = d.config;
  return {
    name: d.name.trim(),
    description: d.description.trim() || null,
    kind: d.config.kind,
    preset: d.preset || null,
    config: { ...config, preset: d.preset || null },
  };
}

function AgentDialog({ agent, open, onOpenChange }: { agent?: Agent; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(agent));
  const presets = usePresets();
  const qc = useQueryClient();
  useEffect(() => {
    if (open) setDraft(toDraft(agent));
  }, [open, agent]);

  const save = useMutation({
    mutationFn: () => (agent ? api.updateAgent(agent.id, toAgentIn(draft)) : api.createAgent(toAgentIn(draft))),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: queryKeys.agents });
      toast.success(agent ? `Saved “${a.name}” (v${a.version})` : `Created “${a.name}”`);
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.name.trim()) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{agent ? `Edit ${agent.name}` : "New agent"}</DialogTitle>
            <DialogDescription>Registry agents can be dropped into any workflow; node settings override these defaults.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              {(id) => <Input id={id} required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}
            </Field>
            <Field label="Preset" hint="Selecting a preset fills prompts, tools and settings.">
              {(id) => (
                <Select
                  id={id}
                  value={draft.preset}
                  onChange={(e) => {
                    const key = e.target.value;
                    const p = presets.data?.find((x) => x.key === key);
                    setDraft({
                      ...draft,
                      preset: key,
                      config: p ? { ...defaultAgentConfig(), ...p.config, preset: key } : { ...draft.config, preset: null },
                    });
                  }}
                >
                  <option value="">Custom</option>
                  {presets.data?.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Description">
            {(id) => <Textarea id={id} rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />}
          </Field>
          <div className="rounded-xl border p-4">
            <AgentConfigForm mode="registry" value={draft.config} onChange={(config) => setDraft({ ...draft, config })} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!draft.name.trim() || save.isPending}>
              {save.isPending && <Spinner className="text-primary-foreground" />} {agent ? "Save agent" : "Create agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AgentsPage() {
  const agents = useAgents();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Agent | undefined>();
  const [open, setOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Agent | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.agents });
      toast.success("Agent deleted");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div>
      <PageHeader
        title="Agents"
        description="Reusable agent configurations with least-privilege tool permissions."
        actions={
          <Button
            size="sm"
            onClick={() => {
              setEditing(undefined);
              setOpen(true);
            }}
          >
            <Plus /> New agent
          </Button>
        }
      />
      {agents.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : agents.isError ? (
        <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
      ) : agents.data!.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No registry agents yet"
          description="Create an agent from a preset (Planning, Developer, Testing…) and reuse it across workflows."
          action={
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus /> New agent
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.data!.map((a) => (
            <Card key={a.id} className="flex flex-col">
              <CardContent className="flex flex-1 flex-col gap-3 p-5">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-600 dark:text-indigo-400">
                    <Bot className="size-4" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{a.name}</p>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {a.kind === "scripted" ? <Badge variant="secondary">Scripted · no LLM</Badge> : <Badge>LLM</Badge>}
                      {a.preset && <Badge variant="outline">{a.preset.replace(/_/g, " ")}</Badge>}
                      <Badge variant="muted">v{a.version}</Badge>
                    </div>
                  </div>
                </div>
                {a.description && <p className="line-clamp-2 text-xs text-muted-foreground">{a.description}</p>}
                <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                  <Wrench className="size-3" aria-hidden />
                  {(a.config.tools ?? []).length === 0 ? "No tools" : (a.config.tools ?? []).map((t) => <code key={t} className="rounded bg-muted px-1 font-mono">{t}</code>)}
                </div>
                <div className="mt-auto flex items-center justify-between pt-2">
                  <span className="text-[11px] text-muted-foreground">Updated {formatRelative(a.updated_at)}</span>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${a.name}`}
                      onClick={() => {
                        setEditing(a);
                        setOpen(true);
                      }}
                    >
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${a.name}`} onClick={() => setToDelete(a)}>
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <AgentDialog agent={editing} open={open} onOpenChange={setOpen} />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`Delete “${toDelete?.name}”?`}
        description="Workflow nodes referencing this agent will fail validation until updated."
        confirmLabel="Delete agent"
        destructive
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </div>
  );
}
