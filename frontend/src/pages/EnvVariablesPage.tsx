import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Field } from "@/components/Field";
import { EmptyState, ErrorState, PageHeader, TableSkeleton } from "@/components/States";
import { api, errorMessage, queryKeys } from "@/services/api";
import { useEnvVariables } from "@/services/queries";
import type { EnvVariable } from "@/types";

export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,99}$/;

/** Secret value input with a show/hide toggle. */
function SecretInput({ id, value, onChange, placeholder }: { id: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? "text" : "password"}
        autoComplete="new-password"
        spellCheck={false}
        className="pr-10 font-mono"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute top-1/2 right-1 -translate-y-1/2"
        aria-label={visible ? "Hide value" : "Show value"}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  );
}

/** Create a variable, or (with `variable`) set a new value / description for it. */
export function EnvVariableDialog({
  variable,
  open,
  onOpenChange,
  onSaved,
  suggestedName,
}: {
  variable?: EnvVariable;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved?: (v: EnvVariable) => void;
  suggestedName?: string;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (open) {
      setName(variable?.name ?? suggestedName ?? "");
      setValue("");
      setDescription(variable?.description ?? "");
    }
  }, [open, variable, suggestedName]);
  const nameErr = !variable && name && !ENV_NAME_RE.test(name) ? "Use capital letters, digits and _ (e.g. OPENAI_API_KEY)." : null;
  const save = useMutation({
    mutationFn: () =>
      variable
        ? api.updateEnvVariable(variable.id, { ...(value ? { value } : {}), description })
        : api.createEnvVariable({ name, value, description }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: queryKeys.envVariables });
      void qc.invalidateQueries({ queryKey: queryKeys.providers });
      toast.success(variable ? `Updated ${v.name}` : `Created ${v.name}`);
      onSaved?.(v);
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const valid = variable ? true : Boolean(name && !nameErr && value);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation(); // may be opened from inside another form (Model Settings)
            if (valid) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{variable ? `Edit ${variable.name}` : "New environment variable"}</DialogTitle>
            <DialogDescription>
              The value is encrypted on the server and only used there (for example to call a model provider). It is never
              included in workflows or run records.
            </DialogDescription>
          </DialogHeader>
          <Field label="Name" error={nameErr} hint={variable ? "Names cannot be changed." : undefined}>
            {(id) => (
              <Input
                id={id}
                required
                disabled={!!variable}
                className="font-mono"
                autoComplete="off"
                value={name}
                placeholder="OPENAI_API_KEY"
                onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
              />
            )}
          </Field>
          <Field label={variable ? "New value" : "Value"} hint={variable ? "Leave empty to keep the current value." : undefined}>
            {(id) => <SecretInput id={id} value={value} onChange={setValue} placeholder={variable ? "••••••••" : "sk-…"} />}
          </Field>
          <Field label="Description (optional)">
            {(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Key for the AI designer model" />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending && <Spinner className="text-primary-foreground" />} {variable ? "Save" : "Create variable"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RevealDialog({ variable, onClose }: { variable: EnvVariable | null; onClose: () => void }) {
  const [value, setValue] = useState<string | null>(null);
  const reveal = useMutation({
    mutationFn: (id: string) => api.revealEnvVariable(id),
    onSuccess: (r) => setValue(r.value),
    onError: (e) => toast.error(errorMessage(e)),
  });
  useEffect(() => {
    setValue(null);
    if (variable) reveal.mutate(variable.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variable]);
  return (
    <Dialog open={!!variable} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{variable?.name}</DialogTitle>
          <DialogDescription>Revealing a value is recorded in the audit log. Close this dialog when you are done.</DialogDescription>
        </DialogHeader>
        {value === null ? (
          <Spinner />
        ) : (
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs" data-testid="revealed-value">
              {value}
            </code>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Copy value"
              onClick={() => {
                void navigator.clipboard?.writeText(value);
                toast.success("Copied");
              }}
            >
              <Copy />
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function EnvVariablesPage() {
  const vars = useEnvVariables();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<EnvVariable | undefined>();
  const [open, setOpen] = useState(false);
  const [revealing, setRevealing] = useState<EnvVariable | null>(null);
  const [toDelete, setToDelete] = useState<EnvVariable | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteEnvVariable(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.envVariables });
      void qc.invalidateQueries({ queryKey: queryKeys.providers });
      toast.success("Variable deleted");
      setToDelete(null);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const create = () => {
    setEditing(undefined);
    setOpen(true);
  };
  return (
    <div>
      <PageHeader
        title="Environment variables"
        description="API keys and other values the platform uses on the server, referenced by name (for example in Model Settings)."
        actions={
          <Button size="sm" onClick={create}>
            <Plus /> New variable
          </Button>
        }
      />
      <div className="mb-4 flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
        <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          Values are encrypted at rest and only decrypted on the server when they are used. Administrators can reveal a value;
          every reveal, change and deletion is audited. Variables defined here take precedence over the server&apos;s
          <code className="mx-1 font-mono">.env</code> file.
        </p>
      </div>
      <Card className="overflow-hidden">
        {vars.isLoading ? (
          <TableSkeleton rows={3} cols={4} />
        ) : vars.isError ? (
          <ErrorState className="m-4" error={vars.error} onRetry={() => void vars.refetch()} />
        ) : vars.data!.length === 0 ? (
          <EmptyState
            className="m-4"
            icon={KeyRound}
            title="No environment variables yet"
            description="Create one for your model provider's API key, then choose it in Model Settings."
            action={
              <Button size="sm" onClick={create}>
                <Plus /> New variable
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Used by</TableHead>
                <TableHead>Last changed</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vars.data!.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="pl-4">
                    <p className="font-mono text-sm font-medium">{v.name}</p>
                    {v.description && <p className="text-[11px] text-muted-foreground">{v.description}</p>}
                  </TableCell>
                  <TableCell>
                    {v.used_by.length ? (
                      <div className="flex flex-wrap gap-1">
                        {v.used_by.map((u) => (
                          <Badge key={u} variant="secondary">
                            {u}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">Not used</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(v.updated_at).toLocaleString()}
                    {v.updated_by && <span className="block">{v.updated_by}</span>}
                  </TableCell>
                  <TableCell className="pr-4">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label={`Reveal ${v.name}`} onClick={() => setRevealing(v)}>
                        <Eye />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${v.name}`}
                        onClick={() => {
                          setEditing(v);
                          setOpen(true);
                        }}
                      >
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${v.name}`} onClick={() => setToDelete(v)}>
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
      <EnvVariableDialog variable={editing} open={open} onOpenChange={setOpen} />
      <RevealDialog variable={revealing} onClose={() => setRevealing(null)} />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`Delete “${toDelete?.name}”?`}
        description={
          toDelete?.used_by.length
            ? `Still used by: ${toDelete.used_by.join(", ")}. Those providers will stop working unless the server's .env defines it.`
            : "This cannot be undone."
        }
        confirmLabel="Delete variable"
        destructive
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </div>
  );
}
