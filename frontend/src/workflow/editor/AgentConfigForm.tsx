import { useEffect, useState } from "react";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field, numOrNull } from "@/components/Field";
import { JsonField } from "@/components/JsonField";
import { useAgents, useProviders, useTools } from "@/services/queries";
import { cn, isPlainObject } from "@/lib/utils";
import type { AgentNodeConfig, JSONSchema, ScriptedStep } from "@/types";
import { RefInput } from "./RefInput";

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-3 border-t pt-4 first:border-t-0 first:pt-0", className)}>
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h4>
      {children}
    </section>
  );
}

interface MappingRow {
  key: string;
  ref: string;
}

function InputMappingEditor({
  value,
  onChange,
  suggestions,
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  suggestions: string[];
}) {
  const toRows = (v: Record<string, string>) => Object.entries(v ?? {}).map(([key, ref]) => ({ key, ref }));
  const [rows, setRows] = useState<MappingRow[]>(() => toRows(value));
  useEffect(() => {
    const current = JSON.stringify(Object.fromEntries(rows.filter((r) => r.key).map((r) => [r.key, r.ref])));
    if (current !== JSON.stringify(value ?? {})) setRows(toRows(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const emit = (next: MappingRow[]) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.ref.trim()])));
  };
  const keys = rows.map((r) => r.key.trim()).filter(Boolean);
  const dupes = new Set(keys.filter((k, i) => keys.indexOf(k) !== i));

  return (
    <div className="space-y-2">
      {rows.length === 0 && <p className="text-[11px] text-muted-foreground">No mappings. Upstream outputs are still available via templates.</p>}
      {rows.map((r, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <Input
            aria-label="Mapping key"
            className={cn("h-8 w-28 shrink-0 font-mono text-xs", dupes.has(r.key.trim()) && "border-destructive")}
            placeholder="key"
            value={r.key}
            onChange={(e) => emit(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
          />
          <RefInput
            className="min-w-0 flex-1"
            aria-label="Mapping reference"
            value={r.ref}
            suggestions={suggestions}
            onChange={(ref) => emit(rows.map((x, j) => (j === i ? { ...x, ref } : x)))}
          />
          <Button variant="ghost" size="icon-sm" className="mt-0.5" aria-label="Remove mapping" onClick={() => emit(rows.filter((_, j) => j !== i))}>
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="xs" onClick={() => setRows([...rows, { key: "", ref: "" }])}>
        <Plus /> Add mapping
      </Button>
    </div>
  );
}

const validateSchema = (v: unknown) => (v === null || isPlainObject(v) ? null : "Output schema must be a JSON object");
const validateSteps = (v: unknown) => {
  if (!Array.isArray(v)) return "Steps must be a JSON array";
  for (const s of v) {
    if (!isPlainObject(s) || typeof s.tool !== "string") return 'Each step needs a "tool" string';
  }
  return null;
};

/**
 * Shared agent configuration form (workflow node config panel + agent registry page).
 * In `node` mode a registry agent can be selected; empty fields then inherit from it.
 */
export function AgentConfigForm({
  value,
  onChange,
  mode,
  suggestions = [],
}: {
  value: AgentNodeConfig;
  onChange: (v: AgentNodeConfig) => void;
  mode: "node" | "registry";
  suggestions?: string[];
}) {
  const tools = useTools();
  const providers = useProviders();
  const agents = useAgents();
  const set = <K extends keyof AgentNodeConfig>(k: K, v: AgentNodeConfig[K]) => onChange({ ...value, [k]: v });

  const registryAgent = mode === "node" && value.agent_id ? agents.data?.find((a) => a.id === value.agent_id) : undefined;
  const inherits = !!registryAgent;
  const inheritPh = (v: unknown) => (inherits ? `Inherit${v !== undefined && v !== null ? ` (${String(v)})` : ""}` : "");
  const scripted = value.kind === "scripted";
  const provider = providers.data?.find((p) => p.id === value.model_provider_id);
  const toolsInherited = inherits && value.tools === undefined;
  const effectiveTools = value.tools ?? registryAgent?.config.tools ?? [];

  return (
    <div className="space-y-5">
      <Section title="Agent">
        <Field label="Kind" hint={scripted ? "Runs the scripted tool steps below deterministically. No model is called." : "Calls the selected model in a tool-use loop."}>
          {(id) => (
            <Select id={id} value={value.kind} onChange={(e) => set("kind", e.target.value as AgentNodeConfig["kind"])}>
              <option value="llm">LLM agent</option>
              <option value="scripted">Scripted (deterministic, no LLM)</option>
            </Select>
          )}
        </Field>
        {mode === "node" && (
          <Field
            label="Registry agent"
            hint={inherits ? "Empty fields below inherit from this agent; filled fields override it." : "Optional — reuse a configured agent from the registry."}
          >
            {(id) => (
              <Select
                id={id}
                value={value.agent_id ?? ""}
                onChange={(e) => {
                  const agentId = e.target.value || null;
                  const a = agents.data?.find((x) => x.id === agentId);
                  onChange({ ...value, agent_id: agentId, kind: a?.kind ?? value.kind });
                }}
              >
                <option value="">None</option>
                {agents.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {value.preset && (
          <p className="text-[11px] text-muted-foreground">
            Preset: <Badge variant="secondary">{String(value.preset).replace(/_/g, " ")}</Badge>
          </p>
        )}
      </Section>

      {!scripted && (
        <Section title="Prompts">
          <Field label="System prompt">
            {(id) => (
              <Textarea
                id={id}
                rows={5}
                className="text-xs"
                value={value.system_prompt ?? ""}
                placeholder={inherits ? "Inherit from registry agent" : "You are a senior software engineer..."}
                onChange={(e) => set("system_prompt", e.target.value)}
              />
            )}
          </Field>
          <Field label="User prompt" hint={<>Supports templates such as <code className="font-mono">{"{{input.requirement}}"}</code> or <code className="font-mono">{"{{planning_agent.output.tasks}}"}</code>.</>}>
            {(id) => (
              <Textarea
                id={id}
                rows={4}
                className="text-xs"
                value={value.user_prompt ?? ""}
                onChange={(e) => set("user_prompt", e.target.value)}
              />
            )}
          </Field>
        </Section>
      )}

      {!scripted && (
        <Section title="Model">
          <Field label="Model provider" hint={providers.data?.length === 0 ? "No providers configured yet — add one in Model Settings." : undefined}>
            {(id) => (
              <Select
                id={id}
                value={value.model_provider_id ?? ""}
                onChange={(e) => set("model_provider_id", e.target.value || null)}
              >
                <option value="">{inherits ? "Inherit" : "Platform default"}</option>
                {providers.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.api_key_configured ? "" : " (no key)"}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Model">
            {(id) => (
              <Input
                id={id}
                className="font-mono text-xs"
                value={value.model ?? ""}
                placeholder={provider?.default_model ?? (inherits ? "Inherit" : "Provider default")}
                onChange={(e) => set("model", e.target.value || null)}
              />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Temperature">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  step="0.1"
                  min={0}
                  max={2}
                  value={value.temperature ?? ""}
                  placeholder={inheritPh(registryAgent?.config.temperature)}
                  onChange={(e) => set("temperature", numOrNull(e.target.value))}
                />
              )}
            </Field>
            <Field label="Max tokens">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  value={value.max_tokens ?? ""}
                  placeholder={inheritPh(registryAgent?.config.max_tokens)}
                  onChange={(e) => set("max_tokens", numOrNull(e.target.value))}
                />
              )}
            </Field>
          </div>
        </Section>
      )}

      <Section title="Tool permissions">
        <p className="text-[11px] text-muted-foreground">Least privilege: the agent can only call the tools checked here.</p>
        {toolsInherited ? (
          <div className="flex items-center justify-between gap-2 rounded-md border border-dashed p-2 text-[11px]">
            <span className="text-muted-foreground">Inherited: {effectiveTools.join(", ") || "none"}</span>
            <Button variant="outline" size="xs" onClick={() => set("tools", [...effectiveTools])}>
              Override
            </Button>
          </div>
        ) : tools.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading tools…</p>
        ) : (
          <div className="max-h-56 space-y-1 overflow-auto rounded-md border p-1.5">
            {tools.data?.length === 0 && <p className="p-1 text-xs text-muted-foreground">No tools available.</p>}
            {tools.data?.map((t) => {
              const checked = (value.tools ?? []).includes(t.name);
              const cid = `tool-${t.name}`;
              return (
                <label key={t.name} htmlFor={cid} className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 hover:bg-accent/50">
                  <Checkbox
                    id={cid}
                    className="mt-0.5"
                    checked={checked}
                    onCheckedChange={(c) => {
                      const cur = new Set(value.tools ?? []);
                      if (c === true) cur.add(t.name);
                      else cur.delete(t.name);
                      set("tools", [...cur]);
                    }}
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1 font-mono text-xs">
                      {t.name}
                      {t.dangerous && (
                        <Badge variant="warning" title="Potentially dangerous tool">
                          <AlertTriangle /> dangerous
                        </Badge>
                      )}
                    </span>
                    <span className="line-clamp-2 text-[11px] text-muted-foreground">{t.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Execution">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Timeout (s)">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                value={value.timeout_seconds ?? ""}
                placeholder={inheritPh(registryAgent?.config.timeout_seconds)}
                onChange={(e) => set("timeout_seconds", numOrNull(e.target.value))}
              />
            )}
          </Field>
          <Field label="Max steps" hint="LLM ↔ tool iterations">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                value={value.max_steps ?? ""}
                placeholder={inheritPh(registryAgent?.config.max_steps)}
                onChange={(e) => set("max_steps", numOrNull(e.target.value))}
              />
            )}
          </Field>
          <Field label="Retry: max attempts">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                value={value.retry?.max_attempts ?? ""}
                placeholder={inheritPh(registryAgent?.config.retry?.max_attempts)}
                onChange={(e) => {
                  const n = numOrNull(e.target.value);
                  if (n === null && (value.retry?.backoff_seconds ?? null) === null) set("retry", null);
                  else set("retry", { max_attempts: n ?? 1, backoff_seconds: value.retry?.backoff_seconds ?? 2 });
                }}
              />
            )}
          </Field>
          <Field label="Retry: backoff (s)">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                step="0.5"
                value={value.retry?.backoff_seconds ?? ""}
                placeholder={inheritPh(registryAgent?.config.retry?.backoff_seconds)}
                onChange={(e) => {
                  const n = numOrNull(e.target.value);
                  set("retry", { max_attempts: value.retry?.max_attempts ?? 1, backoff_seconds: n ?? 0 });
                }}
              />
            )}
          </Field>
        </div>
      </Section>

      <Section title="Data">
        <div className="space-y-1.5">
          <Label>Input mapping</Label>
          <InputMappingEditor
            value={value.input_mapping ?? {}}
            suggestions={suggestions}
            onChange={(m) => set("input_mapping", m)}
          />
        </div>
        <JsonField<JSONSchema | null>
          label="Output schema (JSON Schema)"
          value={value.output_schema ?? null}
          emptyValue={null}
          validate={validateSchema}
          rows={6}
          placeholder={'{\n  "type": "object",\n  "properties": { "tests_passed": { "type": "boolean" } }\n}'}
          hint="Structured output the agent must return; its properties become condition references."
          onChange={(v) => set("output_schema", v)}
        />
        {scripted && (
          <JsonField<ScriptedStep[]>
            label="Scripted steps"
            value={value.steps ?? []}
            emptyValue={[]}
            validate={validateSteps}
            rows={8}
            placeholder={'[\n  { "tool": "write_file", "args": { "path": "README.md", "content": "..." } }\n]'}
            hint="Executed in order with no LLM involved."
            onChange={(v) => set("steps", v)}
          />
        )}
      </Section>
    </div>
  );
}
