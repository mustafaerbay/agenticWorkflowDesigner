import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Cpu, KeyRound, Pencil, PlugZap, Plus, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Field, numOrNull } from "@/components/Field";
import { EmptyState, ErrorState, PageHeader, TableSkeleton } from "@/components/States";
import { api, errorMessage, queryKeys } from "@/services/api";
import { useProviders } from "@/services/queries";
import type { Provider, ProviderIn, ProviderTestResult } from "@/types";

const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;

function emptyProvider(): ProviderIn {
  return { name: "", base_url: "", default_model: "", api_key_ref: "", timeout_seconds: null, temperature: null, max_tokens: null };
}

function ProviderDialog({ provider, open, onOpenChange }: { provider?: Provider; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [form, setForm] = useState<ProviderIn>(emptyProvider());
  const qc = useQueryClient();
  useEffect(() => {
    if (open) {
      setForm(
        provider
          ? {
              name: provider.name,
              base_url: provider.base_url,
              default_model: provider.default_model,
              api_key_ref: provider.api_key_ref ?? "",
              timeout_seconds: provider.timeout_seconds ?? null,
              temperature: provider.temperature ?? null,
              max_tokens: provider.max_tokens ?? null,
            }
          : emptyProvider(),
      );
    }
  }, [open, provider]);
  const envErr = form.api_key_ref && !ENV_RE.test(form.api_key_ref) ? "Must be an environment variable NAME like OPENAI_API_KEY — never the key itself." : null;
  let urlErr: string | null = null;
  if (form.base_url) {
    try {
      const u = new URL(form.base_url);
      if (!/^https?:$/.test(u.protocol)) urlErr = "Use an http(s) URL";
    } catch {
      urlErr = "Enter a valid URL";
    }
  }

  const save = useMutation({
    mutationFn: () => {
      const body: ProviderIn = { ...form, name: form.name.trim(), base_url: form.base_url.trim(), default_model: form.default_model.trim(), api_key_ref: form.api_key_ref?.trim() || null };
      return provider ? api.updateProvider(provider.id, body) : api.createProvider(body);
    },
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: queryKeys.providers });
      toast.success(provider ? `Saved ${p.name}` : `Added ${p.name}`);
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const valid = form.name.trim() && form.base_url.trim() && form.default_model.trim() && !envErr && !urlErr;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{provider ? `Edit ${provider.name}` : "Add model provider"}</DialogTitle>
            <DialogDescription>Any OpenAI-compatible endpoint (OpenAI, Azure, vLLM, Ollama, LM Studio…).</DialogDescription>
          </DialogHeader>
          <Field label="Name">{(id) => <Input id={id} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="OpenAI" />}</Field>
          <Field label="Base URL" error={urlErr}>
            {(id) => <Input id={id} required value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.openai.com/v1" />}
          </Field>
          <Field label="Default model">
            {(id) => <Input id={id} required className="font-mono" value={form.default_model} onChange={(e) => setForm({ ...form, default_model: e.target.value })} placeholder="gpt-4o-mini" />}
          </Field>
          <Field
            label="API key environment variable"
            error={envErr}
            hint="The NAME of an environment variable set on the API/worker servers. Keys stay server-side and are never sent to or shown in the browser."
          >
            {(id) => (
              <Input
                id={id}
                className="font-mono"
                autoComplete="off"
                value={form.api_key_ref ?? ""}
                onChange={(e) => setForm({ ...form, api_key_ref: e.target.value.toUpperCase() })}
                placeholder="OPENAI_API_KEY"
              />
            )}
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Timeout (s)">
              {(id) => <Input id={id} type="number" min={1} value={form.timeout_seconds ?? ""} onChange={(e) => setForm({ ...form, timeout_seconds: numOrNull(e.target.value) })} />}
            </Field>
            <Field label="Temperature">
              {(id) => <Input id={id} type="number" step="0.1" min={0} max={2} value={form.temperature ?? ""} onChange={(e) => setForm({ ...form, temperature: numOrNull(e.target.value) })} />}
            </Field>
            <Field label="Max tokens">
              {(id) => <Input id={id} type="number" min={1} value={form.max_tokens ?? ""} onChange={(e) => setForm({ ...form, max_tokens: numOrNull(e.target.value) })} />}
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending && <Spinner className="text-primary-foreground" />} {provider ? "Save" : "Add provider"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TestButton({ provider }: { provider: Provider }) {
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const test = useMutation({
    mutationFn: () => api.testProvider(provider.id),
    onSuccess: (r) => {
      setResult(r);
      if (r.ok) toast.success(`${provider.name}: connection OK${r.models.length ? ` · ${r.models.length} models` : ""}`);
      else toast.error(`${provider.name}: ${r.detail}`);
    },
    onError: (e) => {
      setResult({ ok: false, detail: errorMessage(e), models: [] });
      toast.error(errorMessage(e));
    },
  });
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="xs" onClick={() => test.mutate()} disabled={test.isPending}>
        {test.isPending ? <Spinner /> : <PlugZap />} Test connection
      </Button>
      {result &&
        (result.ok ? (
          <CheckCircle2 className="size-4 text-success" aria-label="Connection OK" />
        ) : (
          <span title={result.detail}>
            <XCircle className="size-4 text-destructive" aria-label={`Connection failed: ${result.detail}`} />
          </span>
        ))}
    </div>
  );
}

export default function ModelSettingsPage() {
  const providers = useProviders();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Provider | undefined>();
  const [open, setOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Provider | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProvider(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.providers });
      toast.success("Provider deleted");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div>
      <PageHeader
        title="Model settings"
        description="Configure LLM providers, base URLs and model IDs."
        actions={
          <Button
            size="sm"
            onClick={() => {
              setEditing(undefined);
              setOpen(true);
            }}
          >
            <Plus /> Add provider
          </Button>
        }
      />
      <div className="mb-4 flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
        <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          API keys are never stored in the browser or the database. Each provider references the <b>name</b> of an
          environment variable available to the backend (e.g. <code className="font-mono">OPENAI_API_KEY</code>).
        </p>
      </div>
      <Card className="overflow-hidden">
        {providers.isLoading ? (
          <TableSkeleton rows={3} cols={5} />
        ) : providers.isError ? (
          <ErrorState className="m-4" error={providers.error} onRetry={() => void providers.refetch()} />
        ) : providers.data!.length === 0 ? (
          <EmptyState
            className="m-4"
            icon={Cpu}
            title="No model providers"
            description="Add an OpenAI-compatible provider so LLM agents can run. Scripted agents work without one."
            action={
              <Button size="sm" onClick={() => setOpen(true)}>
                <Plus /> Add provider
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Provider</TableHead>
                <TableHead>Default model</TableHead>
                <TableHead>API key</TableHead>
                <TableHead>Connection</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.data!.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="pl-4">
                    <p className="font-medium">{p.name}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">{p.base_url}</p>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{p.default_model}</TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-0.5">
                      {p.api_key_configured ? <Badge variant="success">configured</Badge> : <Badge variant="warning">not configured</Badge>}
                      {p.api_key_ref && <code className="font-mono text-[10px] text-muted-foreground">${p.api_key_ref}</code>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <TestButton provider={p} />
                  </TableCell>
                  <TableCell className="pr-4">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${p.name}`}
                        onClick={() => {
                          setEditing(p);
                          setOpen(true);
                        }}
                      >
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${p.name}`} onClick={() => setToDelete(p)}>
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <ProviderDialog provider={editing} open={open} onOpenChange={setOpen} />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`Delete “${toDelete?.name}”?`}
        description="Agents using this provider will fall back to the platform default or fail validation."
        confirmLabel="Delete provider"
        destructive
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </div>
  );
}
