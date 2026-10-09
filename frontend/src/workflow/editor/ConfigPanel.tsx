import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Settings2, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field, numOrNull } from "@/components/Field";
import { JsonField } from "@/components/JsonField";
import { useTools } from "@/services/queries";
import { isPlainObject } from "@/lib/utils";
import type {
  AgentNodeConfig,
  ApprovalNodeConfig,
  ConditionNodeConfig,
  DelayNodeConfig,
  FailNodeConfig,
  JoinNodeConfig,
  JSONObject,
  JSONSchema,
  StartNodeConfig,
  ToolNodeConfig,
} from "@/types";
import { NODE_META } from "../nodeMeta";
import type { FlowNode } from "../types";
import { AgentConfigForm } from "./AgentConfigForm";
import { ConditionBuilder } from "./ConditionBuilder";
import { buildRefSuggestions } from "./refSuggestions";
import { useEditorStore } from "./store";

const objOnly = (v: unknown) => (isPlainObject(v) ? null : "Must be a JSON object");

function NodeKeyField({ nodeId }: { nodeId: string }) {
  const rename = useEditorStore((s) => s.renameNode);
  const [draft, setDraft] = useState(nodeId);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(nodeId);
    setError(null);
  }, [nodeId]);
  const commit = () => {
    if (draft === nodeId) return setError(null);
    const r = rename(nodeId, draft);
    if (!r.ok) setError(r.error);
    else setError(null);
  };
  return (
    <Field label="Key" hint="Unique id used in references, e.g. key.output.field" error={error}>
      {(id) => (
        <Input
          id={id}
          className="font-mono text-xs"
          value={draft}
          aria-invalid={!!error}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              setDraft(nodeId);
              setError(null);
            }
          }}
        />
      )}
    </Field>
  );
}

function ToolConfigForm({ value, onChange }: { value: ToolNodeConfig; onChange: (c: ToolNodeConfig) => void }) {
  const tools = useTools();
  const selected = tools.data?.find((t) => t.name === value.tool);
  return (
    <div className="space-y-4">
      <Field label="Tool" hint={selected?.description}>
        {(id) => (
          <Select id={id} value={value.tool} onChange={(e) => onChange({ ...value, tool: e.target.value })}>
            <option value="">Select a tool…</option>
            {tools.data?.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
                {t.dangerous ? " ⚠" : ""}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <JsonField<Record<string, JSONObject[string]>>
        label="Arguments (JSON)"
        value={value.args ?? {}}
        emptyValue={{}}
        validate={objOnly}
        rows={8}
        hint={
          <>
            Literal values, or operands like <code className="font-mono">{'{"ref": "agent.output.path"}'}</code>.
          </>
        }
        onChange={(args) => onChange({ ...value, args })}
      />
      {selected && (
        <details className="rounded-md border p-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Parameter schema</summary>
          <pre className="mt-2 overflow-auto font-mono text-[10px]">{JSON.stringify(selected.parameters, null, 2)}</pre>
        </details>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Timeout (s)">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              value={value.timeout_seconds ?? ""}
              onChange={(e) => {
                const n = numOrNull(e.target.value);
                const next = { ...value };
                if (n === null) delete next.timeout_seconds;
                else next.timeout_seconds = n;
                onChange(next);
              }}
            />
          )}
        </Field>
        <Field label="Retry attempts">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              value={value.retry?.max_attempts ?? ""}
              onChange={(e) => {
                const n = numOrNull(e.target.value);
                const next = { ...value };
                if (n === null) delete next.retry;
                else next.retry = { max_attempts: n, backoff_seconds: value.retry?.backoff_seconds ?? 2 };
                onChange(next);
              }}
            />
          )}
        </Field>
      </div>
    </div>
  );
}

function NodeConfigBody({ node, suggestions }: { node: SelectedNode; suggestions: string[] }) {
  const updateConfig = useEditorStore((s) => s.updateNodeConfig);
  const onChange = (c: unknown) => updateConfig(node.id, c as FlowNode["data"]["config"]);
  const config = node.data.config;

  switch (node.type) {
    case "agent":
      return (
        <AgentConfigForm mode="node" value={config as AgentNodeConfig} onChange={onChange} suggestions={suggestions} />
      );
    case "condition":
      return (
        <ConditionBuilder
          key={node.id}
          value={config as ConditionNodeConfig}
          onChange={onChange}
          suggestions={suggestions}
        />
      );
    case "tool":
      return <ToolConfigForm value={config as ToolNodeConfig} onChange={onChange} />;
    case "join": {
      const c = config as JoinNodeConfig;
      return (
        <Field
          label="Mode"
          hint={c.mode === "any" ? "Continue on the first incoming branch; later arrivals are ignored." : "Wait until every incoming branch has completed or been skipped."}
        >
          {(id) => (
            <Select id={id} value={c.mode} onChange={(e) => onChange({ mode: e.target.value })}>
              <option value="all">All — wait for every branch</option>
              <option value="any">Any — first branch wins</option>
            </Select>
          )}
        </Field>
      );
    }
    case "approval": {
      const c = config as ApprovalNodeConfig;
      return (
        <div className="space-y-4">
          <Field label="Title">
            {(id) => <Input id={id} value={c.title} onChange={(e) => onChange({ ...c, title: e.target.value })} />}
          </Field>
          <Field label="Description" hint="Shown to the approver.">
            {(id) => (
              <Textarea id={id} rows={4} value={c.description ?? ""} onChange={(e) => onChange({ ...c, description: e.target.value })} />
            )}
          </Field>
          <p className="text-[11px] text-muted-foreground">Outputs: <b>approved</b> and <b>rejected</b> handles.</p>
        </div>
      );
    }
    case "delay": {
      const c = config as DelayNodeConfig;
      return (
        <Field label="Delay (seconds)">
          {(id) => (
            <Input id={id} type="number" min={0} step="1" value={c.seconds ?? ""} onChange={(e) => onChange({ seconds: numOrNull(e.target.value) ?? 0 })} />
          )}
        </Field>
      );
    }
    case "fail": {
      const c = config as FailNodeConfig;
      return (
        <Field label="Failure message">
          {(id) => <Textarea id={id} rows={3} value={c.message ?? ""} onChange={(e) => onChange({ message: e.target.value })} />}
        </Field>
      );
    }
    case "start": {
      const c = config as StartNodeConfig;
      return (
        <div className="space-y-4">
          <JsonField<JSONObject>
            label="Default input"
            value={c.default_input ?? {}}
            emptyValue={{}}
            validate={objOnly}
            rows={8}
            hint="Prefills the run dialog. Referenced as input.<field>."
            onChange={(v) => onChange({ ...c, default_input: v })}
          />
          <JsonField<JSONSchema | null>
            label="Input schema (optional)"
            value={c.input_schema ?? null}
            emptyValue={null}
            validate={(v) => (v === null || isPlainObject(v) ? null : "Must be a JSON object")}
            rows={5}
            onChange={(v) => {
              const next = { ...c };
              if (v === null) delete next.input_schema;
              else next.input_schema = v;
              onChange(next);
            }}
          />
        </div>
      );
    }
    case "parallel":
      return <p className="text-xs text-muted-foreground">All outgoing edges fire concurrently. Use a Join node to synchronize the branches.</p>;
    case "end":
      return <p className="text-xs text-muted-foreground">The run completes once an End node finishes and nothing else is in flight.</p>;
    default:
      return null;
  }
}

function SettingsPanel() {
  const { settings, setSettings, name, description, setDescription } = useEditorStore(
    useShallow((s) => ({
      settings: s.settings,
      setSettings: s.setSettings,
      name: s.name,
      description: s.description,
      setDescription: s.setDescription,
    })),
  );
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Settings2 className="size-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold">Workflow settings</h3>
      </div>
      <p className="text-xs text-muted-foreground">Select a node or edge to configure it. These limits apply to every run of <b>{name || "this workflow"}</b>.</p>
      <Field label="Description">
        {(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <Field label="Max loop iterations" hint="Max runs of any single node per execution.">
        {(id) => (
          <Input id={id} type="number" min={1} value={settings.max_loop_iterations} onChange={(e) => setSettings({ max_loop_iterations: numOrNull(e.target.value) ?? 1 })} />
        )}
      </Field>
      <Field label="Max total steps" hint="Max node runs per execution.">
        {(id) => (
          <Input id={id} type="number" min={1} value={settings.max_total_steps} onChange={(e) => setSettings({ max_total_steps: numOrNull(e.target.value) ?? 1 })} />
        )}
      </Field>
      <Field label="Max duration (seconds)">
        {(id) => (
          <Input id={id} type="number" min={1} value={settings.max_duration_seconds} onChange={(e) => setSettings({ max_duration_seconds: numOrNull(e.target.value) ?? 1 })} />
        )}
      </Field>
      <div className="rounded-lg border bg-muted/30 p-3 text-[11px] text-muted-foreground">
        <p className="mb-1 font-medium text-foreground">Shortcuts</p>
        <ul className="space-y-0.5">
          <li><kbd>⌘/Ctrl S</kbd> save · <kbd>⌘/Ctrl Z</kbd> undo · <kbd>⇧⌘/Ctrl Z</kbd> redo</li>
          <li><kbd>⌘/Ctrl C</kbd>/<kbd>V</kbd> copy/paste · <kbd>Del</kbd> delete</li>
          <li>Shift + drag to box-select · ⌘/Ctrl-click to multi-select</li>
        </ul>
      </div>
    </div>
  );
}

interface SelectedNode {
  id: string;
  type: FlowNode["type"];
  data: FlowNode["data"];
}

export function ConfigPanel() {
  // Primitive / stable selectors so dragging nodes doesn't re-render the panel.
  const selNodeKey = useEditorStore((s) => s.nodes.filter((n) => n.selected).map((n) => n.id).join("\n"));
  const selEdgeKey = useEditorStore((s) => s.edges.filter((e) => e.selected).map((e) => e.id).join("\n"));
  const nodeIdsKey = useEditorStore((s) => s.nodes.map((n) => `${n.id}:${n.type}`).join(","));
  const selectedNodeIds = selNodeKey ? selNodeKey.split("\n") : [];
  const selectedEdgeIds = selEdgeKey ? selEdgeKey.split("\n") : [];
  const singleId = selectedNodeIds.length === 1 && selectedEdgeIds.length === 0 ? selectedNodeIds[0] : undefined;
  const nodeData = useEditorStore((s) => (singleId ? s.nodes.find((n) => n.id === singleId)?.data : undefined));
  const nodeType = useEditorStore((s) => (singleId ? s.nodes.find((n) => n.id === singleId)?.type : undefined));
  const edgeId = selectedNodeIds.length === 0 && selectedEdgeIds.length === 1 ? selectedEdgeIds[0] : undefined;
  const edge = useEditorStore((s) => (edgeId ? s.edges.find((e) => e.id === edgeId) : undefined));
  const { invalidNodes, invalidEdges } = useEditorStore(
    useShallow((s) => ({ invalidNodes: s.invalidNodes, invalidEdges: s.invalidEdges })),
  );
  const updateNodeData = useEditorStore((s) => s.updateNodeData);
  const updateEdgeLabel = useEditorStore((s) => s.updateEdgeLabel);
  const deleteElements = useEditorStore((s) => s.deleteElements);

  const suggestions = useMemo(
    () => buildRefSuggestions(useEditorStore.getState().nodes, singleId),
    // recompute when ids/types/config change or the selection changes, not on every drag
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeIdsKey, singleId, nodeData],
  );

  if (selectedNodeIds.length > 1 || (selectedNodeIds.length >= 1 && selectedEdgeIds.length >= 1) || selectedEdgeIds.length > 1) {
    return (
      <div className="space-y-3 p-4">
        <h3 className="text-sm font-semibold">
          {selectedNodeIds.length} nodes, {selectedEdgeIds.length} edges selected
        </h3>
        <p className="text-xs text-muted-foreground">Copy with ⌘/Ctrl C, or delete them all.</p>
        <Button variant="destructive" size="sm" onClick={() => deleteElements(selectedNodeIds, selectedEdgeIds)}>
          <Trash2 /> Delete selection
        </Button>
      </div>
    );
  }

  if (edge) {
    const errs = invalidEdges[edge.id];
    return (
      <div className="space-y-4 p-4">
        <h3 className="text-sm font-semibold">Edge</h3>
        <p className="font-mono text-xs text-muted-foreground">
          {edge.source}
          {edge.sourceHandle && edge.sourceHandle !== "out" ? `:${edge.sourceHandle}` : ""} → {edge.target}
        </p>
        {errs && <IssueList messages={errs} />}
        <Field label="Label (optional)">
          {(id) => <Input id={id} value={edge.data?.label ?? ""} onChange={(e) => updateEdgeLabel(edge.id, e.target.value)} />}
        </Field>
        <Button variant="outline" size="sm" className="text-destructive" onClick={() => deleteElements([], [edge.id])}>
          <Trash2 /> Delete edge
        </Button>
      </div>
    );
  }

  if (!singleId || !nodeData || !nodeType) {
    return (
      <div className="p-4">
        <SettingsPanel />
      </div>
    );
  }

  const node: SelectedNode = { id: singleId, type: nodeType, data: nodeData };
  const meta = NODE_META[node.type];
  const Icon = meta.icon;
  const errs = invalidNodes[node.id];

  return (
    <div className="space-y-5 p-4" aria-label={`${meta.title} configuration`}>
      <div className="flex items-start gap-2.5">
        <div className={`flex size-8 shrink-0 items-center justify-center rounded-md ${meta.accent}`}>
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{meta.title}</h3>
          <p className="text-[11px] text-muted-foreground">{meta.description}</p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Delete node" onClick={() => deleteElements([node.id], [])}>
          <Trash2 />
        </Button>
      </div>
      {errs && <IssueList messages={errs} />}
      <div className="space-y-3">
        <Field label={node.type === "agent" ? "Name" : "Label"}>
          {(id) => <Input id={id} value={node.data.label} onChange={(e) => updateNodeData(node.id, { label: e.target.value })} />}
        </Field>
        <NodeKeyField nodeId={node.id} />
        {node.type === "agent" && (
          <Field label="Description">
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={node.data.description ?? ""}
                onChange={(e) => updateNodeData(node.id, { description: e.target.value || undefined })}
              />
            )}
          </Field>
        )}
      </div>
      <div className="border-t pt-4">
        <NodeConfigBody node={node} suggestions={suggestions} />
      </div>
    </div>
  );
}

function IssueList({ messages }: { messages: string[] }) {
  return (
    <div role="alert" className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2">
      {messages.map((m, i) => (
        <p key={i} className="flex items-start gap-1.5 text-[11px] text-destructive">
          <AlertCircle className="mt-px size-3 shrink-0" aria-hidden /> {m}
        </p>
      ))}
    </div>
  );
}
