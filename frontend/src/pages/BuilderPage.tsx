import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Bot,
  Check,
  Cpu,
  LayoutTemplate,
  Lightbulb,
  Redo2,
  Save,
  Send,
  Sparkles,
  Trash2,
  Undo2,
  User as UserIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { EmptyState, ErrorState, PageHeader } from "@/components/States";
import { DiffView, RequirementsPanel, StepCards } from "@/components/business/Explanation";
import { PlanDiagram } from "@/components/business/PlanDiagram";
import { builderDepartments, departmentName, examplePromptsFor, isAdmin } from "@/business/labels";
import { diffIsEmpty } from "@/business/diff";
import { api, ApiError, errorDetailField, errorMessage, queryKeys } from "@/services/api";
import { useDepartments, useDesignerStatus } from "@/services/queries";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/utils";
import type { DesignerSession, Explanation, Finding, Proposal, UnmetNeed, WorkflowDefinition } from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 409 "No AI model is configured..." from the designer endpoints. */
function isNoModelError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && /model/i.test(e.message) && /configur/i.test(e.message);
}

function useElapsed(active: boolean): number {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!active) {
      setS(0);
      return;
    }
    const t = setInterval(() => setS((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  return s;
}

function WorkingIndicator({ label }: { label: string }) {
  const elapsed = useElapsed(true);
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 text-sm">
      <Spinner className="text-primary" label="Working" />
      <div>
        <p className="font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">
          This usually takes 10–60 seconds{elapsed >= 3 ? ` · ${elapsed}s` : ""}. You can keep reading while you wait.
        </p>
      </div>
    </div>
  );
}

export function AiSetupCard({ reason }: { reason?: string | null }) {
  const user = useAuthStore((s) => s.user);
  return (
    <Card className="border-warning/50" data-testid="ai-setup-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="size-4 text-amber-600 dark:text-warning" aria-hidden /> The AI assistant isn't set up yet
        </CardTitle>
        <CardDescription>
          {reason || "No AI model is configured, so workflows can't be designed from a description right now."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {isAdmin(user) ? (
          <Button size="sm" asChild>
            <Link to="/settings/models">
              <Cpu /> Configure an AI model
            </Link>
          </Button>
        ) : (
          <p className="w-full text-xs text-muted-foreground">Ask an administrator to configure an AI model in Model Settings.</p>
        )}
        <Button size="sm" variant="outline" asChild>
          <Link to="/templates">
            <LayoutTemplate /> Start from a template instead
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// New session: department + description
// ---------------------------------------------------------------------------

function NewBuilder() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const departments = useDepartments();
  const status = useDesignerStatus();
  const options = useMemo(() => builderDepartments(user, departments.data), [user, departments.data]);
  const [department, setDepartment] = useState("");
  const [prompt, setPrompt] = useState("");
  const [noModel, setNoModel] = useState<string | null>(null);
  useEffect(() => {
    if (!department && options[0]) setDepartment(options[0].code);
  }, [options, department]);

  const create = useMutation({
    mutationFn: () => api.createSession({ prompt: prompt.trim(), department }),
    onSuccess: (s) => {
      qc.setQueryData(queryKeys.session(s.id), s);
      navigate(`/builder/${s.id}`);
    },
    onError: (e) => {
      if (isNoModelError(e)) setNoModel(errorMessage(e));
    },
  });

  const unavailable = status.data && !status.data.available;
  const examples = examplePromptsFor(department);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Create a workflow with AI"
        description="Describe the task in your own words. You'll get a suggested workflow you can review, change and test before anything is saved."
      />
      {(unavailable || noModel) && (
        <div className="mb-5">
          <AiSetupCard reason={noModel ?? status.data?.reason} />
        </div>
      )}
      {departments.isLoading ? (
        <Spinner />
      ) : options.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="You can't create workflows yet"
          description="You need the Builder role in at least one department. Ask an administrator, or browse the templates."
          action={
            <Button size="sm" variant="outline" asChild>
              <Link to="/templates">Browse templates</Link>
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="space-y-5 p-5">
            <form
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                if (prompt.trim() && department) create.mutate();
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="builder-department">Department</Label>
                <Select id="builder-department" value={department} onChange={(e) => setDepartment(e.target.value)} className="max-w-xs">
                  {options.map((d) => (
                    <option key={d.code} value={d.code}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="builder-prompt">Describe the task</Label>
                <Textarea
                  id="builder-prompt"
                  rows={6}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="What should happen, who needs to approve, and who should be told?"
                  className="text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim()) create.mutate();
                  }}
                />
              </div>
              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Lightbulb className="size-3.5" aria-hidden /> Examples — click one to use it
                </p>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {examples.map((ex) => (
                    <li key={ex}>
                      <button
                        type="button"
                        onClick={() => setPrompt(ex)}
                        className="h-full w-full rounded-lg border bg-muted/30 px-3 py-2 text-left text-xs leading-relaxed hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        {ex}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              {create.isPending && <WorkingIndicator label="Designing your workflow…" />}
              {create.isError && !noModel && (
                <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {errorMessage(create.error)}
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">Nothing is saved until you choose Save workflow.</p>
                <Button type="submit" disabled={!prompt.trim() || !department || create.isPending || !!unavailable}>
                  {create.isPending ? <Spinner className="text-primary-foreground" /> : <Sparkles />} Suggest a workflow
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit an existing plan-based workflow: open a session bound to it
// ---------------------------------------------------------------------------

function StartFromWorkflow({ workflowId }: { workflowId: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const departments = useDepartments();
  const wf = useQuery({ queryKey: queryKeys.workflow(workflowId), queryFn: () => api.getWorkflow(workflowId) });
  const started = useRef(false);
  const create = useMutation({
    mutationFn: (department: string) => api.createSession({ department, workflow_id: workflowId }),
    onSuccess: (s) => {
      qc.setQueryData(queryKeys.session(s.id), s);
      navigate(`/builder/${s.id}`, { replace: true });
    },
  });
  const fallbackDept = builderDepartments(user, departments.data)[0]?.code;
  const department = wf.data ? (wf.data.department ?? wf.data.plan?.department ?? fallbackDept) : undefined;
  useEffect(() => {
    if (!started.current && department) {
      started.current = true;
      create.mutate(department);
    }
  }, [department, create]);

  if (wf.isError) return <ErrorState className="m-6" error={wf.error} onRetry={() => void wf.refetch()} />;
  if (create.isError) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        {isNoModelError(create.error) ? (
          <AiSetupCard reason={errorMessage(create.error)} />
        ) : (
          <ErrorState error={create.error} onRetry={() => department && create.mutate(department)} />
        )}
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner /> Opening the AI assistant…
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session view: conversation + proposal
// ---------------------------------------------------------------------------

function Conversation({
  session,
  busy,
  onSend,
  disabled,
}: {
  session: DesignerSession;
  busy: boolean;
  onSend: (message: string) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [session.messages.length, busy]);
  const send = () => {
    const m = text.trim();
    if (!m || busy || disabled) return;
    onSend(m);
    setText("");
  };
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Conversation">
      <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {session.messages.length === 0 && (
          <li className="text-sm text-muted-foreground">Tell the assistant what you'd like to change, for example “Add manager approval before sending the email”.</li>
        )}
        {session.messages.map((m, i) =>
          m.role === "system" ? (
            <li key={i} className="text-center text-[11px] text-muted-foreground">
              {m.content}
            </li>
          ) : (
            <li key={i} className={cn("flex gap-2", m.role === "user" && "flex-row-reverse")}>
              <span
                className={cn(
                  "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
                  m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                )}
                aria-hidden
              >
                {m.role === "user" ? <UserIcon className="size-3.5" /> : <Bot className="size-3.5" />}
              </span>
              <div
                className={cn(
                  "max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm",
                  m.role === "user" ? "bg-primary/10" : "border bg-card",
                  m.error && "border-destructive/40 bg-destructive/5 text-destructive",
                )}
              >
                <span className="sr-only">{m.role === "user" ? "You: " : "Assistant: "}</span>
                {m.content}
              </div>
            </li>
          ),
        )}
        {busy && (
          <li>
            <WorkingIndicator label="Working on your request…" />
          </li>
        )}
        <div ref={endRef} />
      </ol>
      <form
        className="space-y-2 border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Label htmlFor="builder-message" className="sr-only">
          Ask for a change
        </Label>
        <Textarea
          id="builder-message"
          rows={3}
          value={text}
          disabled={disabled}
          placeholder="Ask for a change, e.g. “Add manager approval before sending the email”"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">Enter to send · Shift+Enter for a new line</p>
          <Button type="submit" size="sm" disabled={!text.trim() || busy || disabled}>
            {busy ? <Spinner className="text-primary-foreground" /> : <Send />} Send
          </Button>
        </div>
      </form>
    </section>
  );
}

function PlanTabs({
  explanation,
  definition,
  findings,
  unmetNeeds,
  proposal,
}: {
  explanation: Explanation;
  definition: WorkflowDefinition | null;
  findings?: Finding[];
  unmetNeeds?: UnmetNeed[];
  proposal?: Proposal | null;
}) {
  const user = useAuthStore((s) => s.user);
  const showChanges = !!proposal && proposal.kind === "modify" && !!proposal.diff;
  const [tab, setTab] = useState(showChanges ? "changes" : "steps");
  useEffect(() => setTab(showChanges ? "changes" : "steps"), [proposal, showChanges]);
  const setupCount = (unmetNeeds?.length ?? 0) + (findings ?? explanation.findings).filter((f) => f.severity === "error" || f.severity === "setup").length;
  return (
    <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 pt-3">
        <TabsList>
          {showChanges && <TabsTrigger value="changes">Changes</TabsTrigger>}
          <TabsTrigger value="steps">Steps</TabsTrigger>
          <TabsTrigger value="diagram">Diagram</TabsTrigger>
          <TabsTrigger value="requirements">
            Requirements
            {setupCount > 0 && (
              <span className="rounded-full bg-warning px-1.5 text-[10px] font-semibold text-black" aria-label={`${setupCount} to set up`}>
                {setupCount}
              </span>
            )}
          </TabsTrigger>
        </TabsList>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 pt-0">
        {showChanges && (
          <TabsContent value="changes">
            <DiffView diff={proposal!.diff} empty="The assistant didn't change any steps." />
            {!diffIsEmpty(proposal!.diff) && (
              <div className="mt-4">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Result</p>
                <StepCards explanation={explanation} diff={proposal!.diff} />
              </div>
            )}
          </TabsContent>
        )}
        <TabsContent value="steps">
          <StepCards explanation={explanation} diff={proposal?.diff} />
        </TabsContent>
        <TabsContent value="diagram">
          {definition ? (
            <PlanDiagram definition={definition} className="h-[520px] rounded-lg border bg-canvas" />
          ) : (
            <p className="text-sm text-muted-foreground">No diagram available.</p>
          )}
        </TabsContent>
        <TabsContent value="requirements">
          <RequirementsPanel explanation={explanation} findings={findings} unmetNeeds={unmetNeeds} canConnect={isAdmin(user)} />
        </TabsContent>
      </div>
    </Tabs>
  );
}

function SaveDialog({
  open,
  onOpenChange,
  session,
  defaultName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  session: DesignerSession;
  defaultName: string;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState(defaultName);
  useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);
  const save = useMutation({
    mutationFn: () => api.saveSession(session.id, name.trim() || undefined),
    onSuccess: (wf) => {
      void qc.invalidateQueries({ queryKey: queryKeys.workflowsAll });
      qc.setQueryData(queryKeys.workflow(wf.id), wf);
      toast.success(session.workflow_id ? `Saved “${wf.name}” · version ${wf.version}` : `Saved “${wf.name}” as a draft`);
      onOpenChange(false);
      navigate(`/workflows/${wf.id}`);
    },
  });
  const conflict = save.error instanceof ApiError && save.error.status === 409;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Save workflow</DialogTitle>
            <DialogDescription>
              {session.workflow_id
                ? "Saves your accepted changes as a new version. The enabled version keeps running until you enable the new one."
                : "Saves the workflow as a draft. Nothing runs until you enable it."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="save-name">Name</Label>
            <Input id="save-name" value={name} onChange={(e) => setName(e.target.value)} required={!session.workflow_id} autoFocus />
          </div>
          {save.isError && (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {conflict
                ? "This workflow was changed by someone else after you started. Open it again and start a new AI editing session to work on the latest version."
                : errorMessage(save.error)}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || (!session.workflow_id && !name.trim())}>
              {save.isPending ? <Spinner className="text-primary-foreground" /> : <Save />} Save workflow
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SessionView({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const departments = useDepartments();
  const session = useQuery({ queryKey: queryKeys.session(sessionId), queryFn: () => api.getSession(sessionId) });
  const [saveOpen, setSaveOpen] = useState(false);
  const [aiError, setAiError] = useState<{ noModel: boolean; message: string; findings: Finding[] } | null>(null);

  const setSession = (s: DesignerSession) => qc.setQueryData(queryKeys.session(sessionId), s);
  const onError = (e: unknown) => {
    // The server may have recorded the failed request in the conversation.
    void qc.invalidateQueries({ queryKey: queryKeys.session(sessionId) });
    setAiError({
      noModel: isNoModelError(e),
      message: errorDetailField<string>(e, "message") ?? errorMessage(e),
      findings: errorDetailField<Finding[]>(e, "findings") ?? [],
    });
  };
  const send = useMutation({
    mutationFn: (message: string) => api.sendSessionMessage(sessionId, message),
    onMutate: () => setAiError(null),
    onSuccess: setSession,
    onError,
  });
  const action = useMutation({
    mutationFn: (kind: "accept" | "discard" | "undo" | "redo") => {
      switch (kind) {
        case "accept":
          return api.acceptProposal(sessionId);
        case "discard":
          return api.discardProposal(sessionId);
        case "undo":
          return api.undoSession(sessionId);
        case "redo":
          return api.redoSession(sessionId);
      }
    },
    onMutate: () => setAiError(null),
    onSuccess: (s, kind) => {
      setSession(s);
      if (kind === "accept") toast.success("Changes accepted — remember to save the workflow");
      if (kind === "discard") toast("Proposal discarded");
    },
    onError,
  });

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (send.isPending) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [send.isPending]);

  if (session.isError) return <ErrorState className="m-6" error={session.error} onRetry={() => void session.refetch()} />;
  const s = session.data;
  if (!s) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading…
      </div>
    );
  }

  const proposal = s.proposal;
  const title = proposal?.plan.title ?? s.plan?.title ?? "New workflow";
  const busy = send.isPending || action.isPending;
  const canSave = !!s.plan && !proposal;
  const saveHint = proposal ? "Accept or discard the proposed changes first" : !s.plan ? "Accept a proposal first" : "Save this workflow";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b bg-card px-3 py-1.5">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to={s.workflow_id ? `/workflows/${s.workflow_id}` : "/workflows"} aria-label="Back">
            <ArrowLeft />
          </Link>
        </Button>
        <Sparkles className="size-4 text-primary" aria-hidden />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{title}</p>
          <p className="text-[11px] text-muted-foreground">
            {departmentName(s.department, departments.data)} · {s.workflow_id ? "Editing a saved workflow" : "New workflow"}
          </p>
        </div>
        <Badge variant="warning" className="ml-1" data-testid="unsaved-badge">
          Not saved yet
        </Badge>
        <div className="ml-auto flex items-center gap-1">
          <Tooltip content="Undo the last accepted change">
            <Button variant="ghost" size="icon-sm" aria-label="Undo" disabled={!s.can_undo || busy} onClick={() => action.mutate("undo")}>
              <Undo2 />
            </Button>
          </Tooltip>
          <Tooltip content="Redo">
            <Button variant="ghost" size="icon-sm" aria-label="Redo" disabled={!s.can_redo || busy} onClick={() => action.mutate("redo")}>
              <Redo2 />
            </Button>
          </Tooltip>
          <Tooltip content={saveHint}>
            <span tabIndex={canSave ? -1 : 0}>
              <Button size="sm" disabled={!canSave || busy} onClick={() => setSaveOpen(true)}>
                <Save /> Save workflow
              </Button>
            </span>
          </Tooltip>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(320px,2fr)_minmax(0,3fr)] lg:grid-rows-1">
        <div className="flex min-h-0 flex-col border-b lg:border-r lg:border-b-0">
          {aiError && (
            <div className="border-b p-3">
              {aiError.noModel ? (
                <AiSetupCard reason={aiError.message} />
              ) : (
                <div role="alert" className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
                  <p className="text-destructive">{aiError.message}</p>
                  {aiError.findings.map((f, i) => (
                    <p key={i}>{f.message}</p>
                  ))}
                </div>
              )}
            </div>
          )}
          <Conversation session={s} busy={send.isPending} disabled={action.isPending} onSend={(m) => send.mutate(m)} />
        </div>

        <section className="flex min-h-0 flex-col" aria-label={proposal ? "Proposal" : "Current workflow"}>
          {proposal ? (
            <>
              <div className="space-y-2 border-b bg-primary/5 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold">{proposal.kind === "create" ? "Suggested workflow" : "Proposed changes"}</h2>
                  <Badge variant="info">Review before accepting</Badge>
                </div>
                {proposal.summary && <p className="text-sm text-muted-foreground">{proposal.summary}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => action.mutate("accept")} disabled={busy}>
                    {action.isPending && action.variables === "accept" ? <Spinner className="text-primary-foreground" /> : <Check />} Accept changes
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => action.mutate("discard")} disabled={busy}>
                    <Trash2 /> Discard
                  </Button>
                </div>
              </div>
              <PlanTabs
                explanation={proposal.explanation}
                definition={proposal.definition}
                findings={proposal.findings}
                unmetNeeds={proposal.unmet_needs}
                proposal={proposal}
              />
            </>
          ) : s.plan && s.explanation ? (
            <>
              <div className="border-b p-4">
                <h2 className="text-sm font-semibold">Current workflow</h2>
                <p className="text-xs text-muted-foreground">
                  Ask for changes in the conversation. When you're happy, choose <b>Save workflow</b>.
                </p>
              </div>
              <PlanTabs explanation={s.explanation} definition={s.definition} />
            </>
          ) : (
            <div className="p-6">
              <EmptyState icon={Sparkles} title="No workflow yet" description="Describe the task in the conversation to get a suggestion." />
            </div>
          )}
        </section>
      </div>

      <SaveDialog open={saveOpen} onOpenChange={setSaveOpen} session={s} defaultName={s.plan?.title ?? ""} />
    </div>
  );
}

export default function BuilderPage() {
  const { sessionId, id } = useParams<{ sessionId?: string; id?: string }>();
  if (sessionId) return <SessionView key={sessionId} sessionId={sessionId} />;
  if (id) return <StartFromWorkflow workflowId={id} />;
  return <NewBuilder />;
}
