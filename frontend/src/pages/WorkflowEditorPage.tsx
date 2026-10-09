import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useParams } from "react-router-dom";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Maximize,
  Network,
  Play,
  Redo2,
  Save,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RunWorkflowDialog } from "@/components/RunWorkflowDialog";
import { ErrorState } from "@/components/States";
import { api, ApiError, errorMessage, queryKeys } from "@/services/api";
import { useUiStore } from "@/stores/ui";
import { cn } from "@/lib/utils";
import type { ValidationResult } from "@/types";
import { ConfigPanel } from "@/workflow/editor/ConfigPanel";
import { addNodeChecked, EditorCanvas } from "@/workflow/editor/EditorCanvas";
import { Palette } from "@/workflow/editor/Palette";
import { useEditorStore, type NewNodeSpec } from "@/workflow/editor/store";
import { defaultInputOf } from "@/workflow/serialization";

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

function ValidationPanel({ result, onClose, onFocusNode }: { result: ValidationResult; onClose: () => void; onFocusNode: (id: string) => void }) {
  const all = [
    ...result.errors.map((i) => ({ ...i, level: "error" as const })),
    ...result.warnings.map((i) => ({ ...i, level: "warning" as const })),
  ];
  return (
    <div
      className="absolute left-3 top-3 z-10 w-[360px] max-w-[calc(100%-1.5rem)] rounded-xl border bg-popover shadow-xl animate-fade-in"
      role="region"
      aria-label="Validation results"
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {result.valid ? (
          <CheckCircle2 className="size-4 text-success" aria-hidden />
        ) : (
          <AlertCircle className="size-4 text-destructive" aria-hidden />
        )}
        <p className="text-sm font-medium">
          {result.valid ? "Workflow is valid" : `${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`}
          {result.warnings.length > 0 && <span className="text-muted-foreground"> · {result.warnings.length} warning(s)</span>}
        </p>
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={onClose} aria-label="Close validation results">
          <X />
        </Button>
      </div>
      {all.length > 0 && (
        <ul className="max-h-72 space-y-1 overflow-auto p-2">
          {all.map((i, k) => (
            <li key={k}>
              <button
                type="button"
                disabled={!i.node_id}
                onClick={() => i.node_id && onFocusNode(i.node_id)}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", i.level === "error" ? "bg-destructive" : "bg-warning")} />
                <span className="min-w-0">
                  {(i.node_id || i.edge_id) && (
                    <code className="mr-1 font-mono text-[10px] text-muted-foreground">{i.node_id ?? i.edge_id}</code>
                  )}
                  {i.message}
                  <span className="ml-1 font-mono text-[10px] text-muted-foreground">({i.code})</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EditorInner({ workflowId }: { workflowId: string }) {
  const qc = useQueryClient();
  const { fitView, setCenter, getNode, screenToFlowPosition } = useReactFlow();
  const paletteCollapsed = useUiStore((s) => s.paletteCollapsed);
  const togglePalette = useUiStore((s) => s.togglePalette);
  const [showValidation, setShowValidation] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);

  const wfQuery = useQuery({ queryKey: queryKeys.workflow(workflowId), queryFn: () => api.getWorkflow(workflowId) });
  const { name, version, dirty, validation, canUndo, canRedo, loadedId } = useEditorStore(
    useShallow((s) => ({
      name: s.name,
      version: s.version,
      dirty: s.dirty,
      validation: s.validation,
      canUndo: s.past.length > 0,
      canRedo: s.future.length > 0,
      loadedId: s.workflowId,
    })),
  );
  const store = useEditorStore;

  // Load once per workflow id (don't clobber local edits on background refetch).
  useEffect(() => {
    if (wfQuery.data && store.getState().workflowId !== wfQuery.data.id) {
      store.getState().load(wfQuery.data);
      requestAnimationFrame(() => void fitView({ padding: 0.2, maxZoom: 1.2 }));
    }
  }, [wfQuery.data, fitView, store]);
  useEffect(() => () => store.getState().reset(), [store]);

  const save = useMutation({
    mutationFn: () => {
      const s = store.getState();
      return api.updateWorkflow(workflowId, {
        name: s.name.trim() || "Untitled workflow",
        description: s.description,
        definition: s.getDefinition(),
      });
    },
    onSuccess: (wf) => {
      store.getState().markSaved(wf);
      qc.setQueryData(queryKeys.workflow(workflowId), wf);
      void qc.invalidateQueries({ queryKey: queryKeys.workflowsAll });
      toast.success(`Saved · version ${wf.version}`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.validation) {
        store.getState().setValidation(e.validation);
        setShowValidation(true);
      }
      toast.error(`Save failed: ${errorMessage(e)}`);
    },
  });

  const validate = useMutation({
    mutationFn: () => api.validateDefinition(store.getState().getDefinition()),
    onSuccess: (r) => {
      store.getState().setValidation(r);
      setShowValidation(true);
      if (r.valid) toast.success("Workflow is valid");
    },
    onError: (e) => toast.error(`Validation failed: ${errorMessage(e)}`),
  });

  const doSave = useCallback(() => {
    if (!save.isPending) save.mutate();
  }, [save]);

  const focusNode = useCallback(
    (id: string) => {
      const n = getNode(id);
      if (!n) return;
      store.getState().selectOnly([id]);
      void setCenter(n.position.x + 120, n.position.y + 40, { zoom: 1.1, duration: 300 });
    },
    [getNode, setCenter, store],
  );

  const addAtCenter = useCallback(
    (spec: NewNodeSpec) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const jitter = (store.getState().nodes.length % 5) * 24;
      const pos = rect
        ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
        : { x: 0, y: 0 };
      addNodeChecked(spec, { x: pos.x - 120 + jitter, y: pos.y - 40 + jitter });
    },
    [screenToFlowPosition, store],
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "s") {
        e.preventDefault();
        doSave();
        return;
      }
      if (isEditableTarget(e.target)) return;
      // ignore when a dialog is open
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const st = store.getState();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        st.redo();
      } else if (mod && key === "c") {
        const n = st.copySelection();
        if (n) toast(`Copied ${n} node${n === 1 ? "" : "s"}`);
      } else if (mod && key === "v") {
        e.preventDefault();
        st.paste();
      } else if (mod && key === "a") {
        e.preventDefault();
        st.selectOnly(st.nodes.map((n) => n.id), st.edges.map((x) => x.id));
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        st.deleteSelected();
      } else if (e.key === "Escape") {
        st.selectOnly([]);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [doSave, store]);

  // Warn on unload with unsaved changes
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (store.getState().dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [store]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  if (wfQuery.isError) {
    return (
      <div className="p-8">
        <ErrorState error={wfQuery.error} onRetry={() => void wfQuery.refetch()} />
      </div>
    );
  }
  if (!wfQuery.data || loadedId !== workflowId) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading workflow…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-card px-2 sm:px-3">
        <Tooltip content="Back to workflows">
          <Button variant="ghost" size="icon-sm" asChild>
            <Link to="/workflows" aria-label="Back to workflows">
              <ArrowLeft />
            </Link>
          </Button>
        </Tooltip>
        <Input
          aria-label="Workflow name"
          value={name}
          onChange={(e) => store.getState().setName(e.target.value)}
          className="h-8 w-40 border-transparent bg-transparent text-sm font-semibold shadow-none hover:border-input focus-visible:border-input sm:w-64"
        />
        {version != null && (
          <Badge variant="secondary" title="Saved version">
            v{version}
          </Badge>
        )}
        {dirty ? (
          <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-warning" role="status">
            <span className="size-1.5 rounded-full bg-current" aria-hidden /> Unsaved changes
          </span>
        ) : (
          <span className="hidden text-[11px] text-muted-foreground sm:inline" role="status">
            All changes saved
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Tooltip content="Undo (⌘Z)">
            <Button variant="ghost" size="icon-sm" aria-label="Undo" disabled={!canUndo} onClick={() => store.getState().undo()}>
              <Undo2 />
            </Button>
          </Tooltip>
          <Tooltip content="Redo (⇧⌘Z)">
            <Button variant="ghost" size="icon-sm" aria-label="Redo" disabled={!canRedo} onClick={() => store.getState().redo()}>
              <Redo2 />
            </Button>
          </Tooltip>
          <Tooltip content="Auto-layout (left to right)">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Auto-layout"
              onClick={() => {
                store.getState().layout();
                requestAnimationFrame(() => void fitView({ padding: 0.2, duration: 300 }));
              }}
            >
              <Network />
            </Button>
          </Tooltip>
          <Tooltip content="Fit view">
            <Button variant="ghost" size="icon-sm" aria-label="Fit view" onClick={() => void fitView({ padding: 0.2, duration: 300 })}>
              <Maximize />
            </Button>
          </Tooltip>
          <div className="mx-1 h-5 w-px bg-border" />
          <Button variant="outline" size="sm" onClick={() => validate.mutate()} disabled={validate.isPending}>
            {validate.isPending ? <Spinner /> : <ShieldCheck />}
            <span className="hidden sm:inline">Validate</span>
          </Button>
          <Button variant="outline" size="sm" onClick={doSave} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : <Save />}
            Save
          </Button>
          <Button size="sm" onClick={() => setRunOpen(true)}>
            <Play /> Run
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <Palette collapsed={paletteCollapsed} onToggle={togglePalette} onAdd={addAtCenter} />
        <div ref={canvasRef} className="relative min-w-0 flex-1">
          <EditorCanvas />
          {showValidation && validation && (
            <ValidationPanel
              result={validation}
              onFocusNode={focusNode}
              onClose={() => {
                setShowValidation(false);
                store.getState().setValidation(null);
              }}
            />
          )}
        </div>
        <aside className="hidden w-[380px] shrink-0 overflow-y-auto border-l bg-card md:block" aria-label="Configuration panel">
          <ConfigPanel />
        </aside>
      </div>

      <RunWorkflowDialog
        open={runOpen}
        onOpenChange={setRunOpen}
        workflowId={workflowId}
        workflowName={name}
        defaultInput={defaultInputOf(store.getState().getDefinition())}
        beforeRun={async () => {
          if (!store.getState().dirty) return true;
          try {
            await save.mutateAsync();
            return true;
          } catch {
            return false;
          }
        }}
      />
      <ConfirmDialog
        open={blocker.state === "blocked"}
        onOpenChange={(o) => {
          if (!o && blocker.state === "blocked") blocker.reset();
        }}
        title="Discard unsaved changes?"
        description="You have unsaved changes to this workflow. Leaving will discard them."
        confirmLabel="Discard & leave"
        destructive
        onConfirm={() => blocker.state === "blocked" && blocker.proceed()}
      />
    </div>
  );
}

export default function WorkflowEditorPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return (
    <ReactFlowProvider>
      <EditorInner workflowId={id} />
    </ReactFlowProvider>
  );
}
