import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, KeyRound, Lock, Pencil, Plug, PlugZap, Plus, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Field } from "@/components/Field";
import { EmptyState, ErrorState, PageHeader, TableSkeleton } from "@/components/States";
import { ChipsInput } from "@/components/business/ChipsInput";
import { departmentName } from "@/business/labels";
import { api, errorMessage, queryKeys } from "@/services/api";
import { useConnectors, useDepartments } from "@/services/queries";
import { cn, formatRelative } from "@/lib/utils";
import type { Connection, ConnectionIn, ConnectionTestResult, ConnectorField, ConnectorType, JSONObject, JSONValue } from "@/types";

type FieldValue = string | string[] | boolean;

function initialValue(f: ConnectorField, existing: JSONValue | undefined): FieldValue {
  const v = existing !== undefined ? existing : f.default;
  if (f.type === "list") return Array.isArray(v) ? v.map(String) : [];
  if (f.type === "boolean") return v === true;
  return v === undefined || v === null ? "" : String(v);
}

/** Non-secret connector config from the form (never contains the secret). */
export function buildConnectionConfig(fields: ConnectorField[], values: Record<string, FieldValue>): JSONObject {
  const config: JSONObject = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.type === "list") config[f.key] = Array.isArray(v) ? v : [];
    else if (f.type === "boolean") config[f.key] = v === true;
    else if (f.type === "number") {
      const t = typeof v === "string" ? v.trim() : "";
      if (t) config[f.key] = Number(t);
    } else {
      const t = typeof v === "string" ? v.trim() : "";
      if (t || f.required) config[f.key] = t;
    }
  }
  return config;
}

function TestResult({ result }: { result: ConnectionTestResult | null }) {
  if (!result) return null;
  return (
    <p role="status" className={cn("flex items-start gap-1.5 text-xs", result.ok ? "text-success" : "text-destructive")}>
      {result.ok ? <CheckCircle2 className="mt-px size-3.5 shrink-0" aria-hidden /> : <XCircle className="mt-px size-3.5 shrink-0" aria-hidden />}
      {result.ok ? "Connection works" : "Connection failed"}
      {result.detail ? ` — ${result.detail}` : ""}
    </p>
  );
}

function ConnectionWizard({
  open,
  onOpenChange,
  connection,
  connectors,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  connection?: Connection;
  connectors: ConnectorType[];
}) {
  const qc = useQueryClient();
  const departments = useDepartments();
  const [step, setStep] = useState<"type" | "details" | "done">("type");
  const [type, setType] = useState<string>("");
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  // Write-only: never prefilled, never displayed after saving.
  const [secret, setSecret] = useState("");
  const [depts, setDepts] = useState<string[]>([]);
  const [saved, setSaved] = useState<Connection | null>(null);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const spec = connectors.find((c) => c.type === type);

  useEffect(() => {
    if (!open) return;
    setSecret("");
    setSaved(null);
    setTestResult(null);
    if (connection) {
      const s = connectors.find((c) => c.type === connection.connector);
      setType(connection.connector);
      setName(connection.name);
      setDepts(connection.departments);
      setValues(Object.fromEntries((s?.fields ?? []).map((f) => [f.key, initialValue(f, connection.config[f.key])])));
      setStep("details");
    } else {
      setType("");
      setName("");
      setDepts([]);
      setValues({});
      setStep("type");
    }
  }, [open, connection, connectors]);

  const chooseType = (c: ConnectorType) => {
    setType(c.type);
    setName((n) => n || c.label);
    setValues(Object.fromEntries(c.fields.map((f) => [f.key, initialValue(f, undefined)])));
    setStep("details");
  };

  const save = useMutation({
    mutationFn: () => {
      const body: ConnectionIn = {
        name: name.trim(),
        connector: type,
        config: buildConnectionConfig(spec?.fields ?? [], values),
        departments: depts,
      };
      if (secret) body.secret = secret;
      return connection ? api.updateConnection(connection.id, body) : api.createConnection(body);
    },
    onSuccess: (c) => {
      setSecret("");
      setSaved(c);
      setStep("done");
      void qc.invalidateQueries({ queryKey: queryKeys.connections });
      void qc.invalidateQueries({ queryKey: ["capabilities"] });
      toast.success(connection ? `Saved ${c.name}` : `Added ${c.name}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const test = useMutation({
    mutationFn: (id: string) => api.testConnection(id),
    onSuccess: (r) => {
      setTestResult(r);
      void qc.invalidateQueries({ queryKey: queryKeys.connections });
    },
    onError: (e) => setTestResult({ ok: false, detail: errorMessage(e) }),
  });

  const missingRequired = (spec?.fields ?? []).filter((f) => {
    if (!f.required) return false;
    const v = values[f.key];
    return Array.isArray(v) ? v.length === 0 : typeof v === "string" ? !v.trim() : false;
  });
  const secretMissing = !!spec?.secret.required && !secret && !connection?.has_secret;
  const valid = !!spec && !!name.trim() && missingRequired.length === 0 && !secretMissing;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {step === "type" && (
          <>
            <DialogHeader>
              <DialogTitle>Add a connection</DialogTitle>
              <DialogDescription>Choose what kind of app to connect. Workflows use connections to send email, post messages or update other systems.</DialogDescription>
            </DialogHeader>
            <ul className="grid gap-3 sm:grid-cols-2">
              {connectors.map((c) => (
                <li key={c.type}>
                  <button
                    type="button"
                    onClick={() => chooseType(c)}
                    className="flex h-full w-full flex-col gap-1 rounded-lg border p-4 text-left hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      <Plug className="size-4 text-primary" aria-hidden /> {c.label}
                    </span>
                    <span className="text-xs text-muted-foreground">{c.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {step === "details" && spec && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) save.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>{connection ? `Edit ${connection.name}` : `Connect ${spec.label}`}</DialogTitle>
              <DialogDescription>{spec.description}</DialogDescription>
            </DialogHeader>
            <Field label="Connection name" hint="Shown to workflow builders, e.g. “HR mailbox”.">
              {(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              {spec.fields.map((f) => {
                const v = values[f.key];
                const label = (
                  <>
                    {f.label}
                    {f.required && <span className="text-destructive"> *</span>}
                  </>
                );
                const setV = (x: FieldValue) => setValues((all) => ({ ...all, [f.key]: x }));
                return (
                  <Field key={f.key} label={label} className={f.type === "list" ? "sm:col-span-2" : undefined} hint={f.type === "list" ? "Separate with commas or press Enter." : undefined}>
                    {(id) =>
                      f.type === "list" ? (
                        <ChipsInput id={id} value={Array.isArray(v) ? v : []} onChange={setV} placeholder={f.placeholder} />
                      ) : f.type === "select" ? (
                        <Select id={id} value={typeof v === "string" ? v : ""} onChange={(e) => setV(e.target.value)}>
                          {(f.options ?? []).map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </Select>
                      ) : f.type === "boolean" ? (
                        <Switch id={id} checked={v === true} onCheckedChange={(c) => setV(c)} />
                      ) : (
                        <Input
                          id={id}
                          type={f.type === "number" ? "number" : "text"}
                          value={typeof v === "string" ? v : ""}
                          placeholder={f.placeholder}
                          onChange={(e) => setV(e.target.value)}
                        />
                      )
                    }
                  </Field>
                );
              })}
            </div>

            <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
              <Field
                label={
                  <span className="flex items-center gap-1.5">
                    <KeyRound className="size-3.5" aria-hidden /> {spec.secret.label}
                    {spec.secret.required && !connection?.has_secret && <span className="text-destructive"> *</span>}
                  </span>
                }
                hint={
                  connection?.has_secret
                    ? "A secret is stored. Leave this empty to keep it, or type a new one to replace it."
                    : "Stored encrypted. It is never shown again — not even to administrators."
                }
              >
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="new-password"
                    value={secret}
                    placeholder={connection?.has_secret ? "Secret stored — leave empty to keep" : ""}
                    onChange={(e) => setSecret(e.target.value)}
                    data-testid="connection-secret"
                  />
                )}
              </Field>
              <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                <Lock className="mt-px size-3 shrink-0" aria-hidden />
                Secrets are encrypted on the server, never returned to the browser and never included in workflows or sent to the AI.
              </p>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-xs font-medium">Which departments may use it?</legend>
              <p className="text-[11px] text-muted-foreground">Leave all unchecked to allow every department.</p>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {(departments.data ?? []).map((d) => {
                  const id = `conn-dept-${d.code}`;
                  return (
                    <div key={d.code} className="flex items-center gap-1.5">
                      <Checkbox
                        id={id}
                        checked={depts.includes(d.code)}
                        onCheckedChange={(c) => setDepts((all) => (c === true ? [...all, d.code] : all.filter((x) => x !== d.code)))}
                      />
                      <Label htmlFor={id} className="cursor-pointer font-normal">
                        {d.name}
                      </Label>
                    </div>
                  );
                })}
              </div>
            </fieldset>

            <DialogFooter>
              {!connection && (
                <Button variant="ghost" className="sm:mr-auto" onClick={() => setStep("type")}>
                  <ArrowLeft /> Change type
                </Button>
              )}
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!valid || save.isPending}>
                {save.isPending && <Spinner className="text-primary-foreground" />} Save connection
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === "done" && saved && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="size-5 text-success" aria-hidden /> {saved.name} is saved
              </DialogTitle>
              <DialogDescription>Check that it works. Testing never sends a message.</DialogDescription>
            </DialogHeader>
            <TestResult result={testResult} />
            <DialogFooter>
              <Button variant="outline" onClick={() => test.mutate(saved.id)} disabled={test.isPending}>
                {test.isPending ? <Spinner /> : <PlugZap />} Test connection
              </Button>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RowTest({ connection }: { connection: Connection }) {
  const qc = useQueryClient();
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const test = useMutation({
    mutationFn: () => api.testConnection(connection.id),
    onSuccess: (r) => {
      setResult(r);
      if (r.ok) toast.success(`${connection.name}: connection works`);
      else toast.error(`${connection.name}: ${r.detail}`);
      void qc.invalidateQueries({ queryKey: queryKeys.connections });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Button variant="outline" size="xs" onClick={() => test.mutate()} disabled={test.isPending} title={result?.detail}>
      {test.isPending ? <Spinner /> : <PlugZap />} Test
    </Button>
  );
}

export default function ConnectionsPage() {
  const qc = useQueryClient();
  const connectors = useConnectors();
  const departments = useDepartments();
  const list = useQuery({ queryKey: queryKeys.connections, queryFn: api.listConnections });
  const [wizard, setWizard] = useState<{ connection?: Connection } | null>(null);
  const [toDelete, setToDelete] = useState<Connection | null>(null);
  const labels = useMemo(() => new Map((connectors.data ?? []).map((c) => [c.type, c.label])), [connectors.data]);
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.connections });
      toast.success("Connection deleted");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div>
      <PageHeader
        title="Connections"
        description="Connect the apps workflows may use: email, business systems and chat. Secrets are encrypted and never shown again."
        actions={
          <Button size="sm" onClick={() => setWizard({})} disabled={!connectors.data}>
            <Plus /> Add connection
          </Button>
        }
      />
      <Card className="overflow-hidden">
        {list.isLoading ? (
          <TableSkeleton rows={3} cols={5} />
        ) : list.isError ? (
          <ErrorState className="m-4" error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data!.length === 0 ? (
          <EmptyState
            className="m-4"
            icon={Plug}
            title="No connections yet"
            description="Workflows that send email, post to chat or update other systems need a connection first."
            action={
              <Button size="sm" onClick={() => setWizard({})} disabled={!connectors.data}>
                <Plus /> Add connection
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Departments</TableHead>
                <TableHead>Last test</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data!.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="pl-4 font-medium">{c.name}</TableCell>
                  <TableCell className="text-muted-foreground">{labels.get(c.connector) ?? c.connector}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {c.enabled ? <Badge variant="success">Enabled</Badge> : <Badge variant="muted">Disabled</Badge>}
                      {c.has_secret && (
                        <Badge variant="secondary">
                          <Lock aria-hidden /> Secret stored
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {c.departments.length === 0 ? "All departments" : c.departments.map((d) => departmentName(d, departments.data)).join(", ")}
                  </TableCell>
                  <TableCell className="text-xs">
                    {c.last_test_at == null ? (
                      <span className="text-muted-foreground">Never tested</span>
                    ) : c.last_test_ok ? (
                      <span className="text-success">Worked {formatRelative(c.last_test_at)}</span>
                    ) : (
                      <span className="text-destructive">Failed {formatRelative(c.last_test_at)}</span>
                    )}
                  </TableCell>
                  <TableCell className="pr-4">
                    <div className="flex items-center justify-end gap-1">
                      <RowTest connection={c} />
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${c.name}`} onClick={() => setWizard({ connection: c })} disabled={!connectors.data}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${c.name}`} onClick={() => setToDelete(c)}>
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
      {wizard && connectors.data && (
        <ConnectionWizard open onOpenChange={(o) => !o && setWizard(null)} connection={wizard.connection} connectors={connectors.data} />
      )}
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`Delete “${toDelete?.name}”?`}
        description="Workflows that use this app can't be enabled or run until another connection is added. The stored secret is destroyed."
        confirmLabel="Delete connection"
        destructive
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </div>
  );
}
