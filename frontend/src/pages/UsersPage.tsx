import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, UserX, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Field } from "@/components/Field";
import { EmptyState, ErrorState, PageHeader, TableSkeleton } from "@/components/States";
import { departmentName, ROLE_LABELS } from "@/business/labels";
import { api, errorMessage, queryKeys } from "@/services/api";
import { useDepartments } from "@/services/queries";
import { DEPARTMENT_ROLES, type DepartmentRole, type GlobalRole, type Membership, type User, type UserUpdate } from "@/types";

const GLOBAL_ROLES: { value: GlobalRole; label: string; hint: string }[] = [
  { value: "admin", label: "Administrator", hint: "Manages users, connections and settings; sees everything." },
  { value: "editor", label: "Editor", hint: "Can build and run workflows in their departments." },
  { value: "viewer", label: "Viewer", hint: "Can view workflows and runs they have access to." },
];

function MembershipMatrix({ value, onChange }: { value: Membership[]; onChange: (m: Membership[]) => void }) {
  const departments = useDepartments();
  const has = (dept: string, role: DepartmentRole) => !!value.find((m) => m.department === dept)?.roles.includes(role);
  const toggle = (dept: string, role: DepartmentRole, on: boolean) => {
    const existing = value.find((m) => m.department === dept);
    const roles = new Set(existing?.roles ?? []);
    if (on) roles.add(role);
    else roles.delete(role);
    const others = value.filter((m) => m.department !== dept);
    onChange(roles.size ? [...others, { department: dept, roles: DEPARTMENT_ROLES.filter((r) => roles.has(r)) }] : others);
  };
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium">Department roles</legend>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="px-3 py-2 text-left font-medium">Department</th>
              {DEPARTMENT_ROLES.map((r) => (
                <th key={r} className="px-2 py-2 text-center font-medium">
                  {ROLE_LABELS[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(departments.data ?? []).map((d) => (
              <tr key={d.code} className="border-b last:border-0">
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  {d.name}
                </th>
                {DEPARTMENT_ROLES.map((r) => (
                  <td key={r} className="px-2 py-2 text-center">
                    <Checkbox
                      checked={has(d.code, r)}
                      aria-label={`${ROLE_LABELS[r]} in ${d.name}`}
                      onCheckedChange={(c) => toggle(d.code, r, c === true)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Members can run workflows, builders create and edit them, approvers decide approvals, department admins manage the department.
      </p>
    </fieldset>
  );
}

function UserDialog({ user, open, onOpenChange }: { user?: User; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<GlobalRole>("editor");
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [active, setActive] = useState(true);
  useEffect(() => {
    if (!open) return;
    setEmail(user?.email ?? "");
    setName(user?.name ?? "");
    setPassword("");
    setRole(user?.role ?? "editor");
    setMemberships(user?.memberships ?? []);
    setActive(user?.is_active ?? true);
  }, [open, user]);

  const save = useMutation({
    mutationFn: () => {
      if (user) {
        const body: UserUpdate = { name: name.trim(), role, memberships, is_active: active };
        if (password) body.password = password;
        return api.updateUser(user.id, body);
      }
      return api.createUser({ email: email.trim(), name: name.trim(), password, role, memberships });
    },
    onSuccess: (u) => {
      void qc.invalidateQueries({ queryKey: queryKeys.users });
      toast.success(user ? `Saved ${u.name}` : `Added ${u.name}`);
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const valid = !!name.trim() && (user ? true : !!email.trim() && password.length >= 10);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{user ? `Edit ${user.name}` : "Add user"}</DialogTitle>
            <DialogDescription>Global role plus roles per department.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Email">
              {(id) => <Input id={id} type="email" required value={email} disabled={!!user} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />}
            </Field>
            <Field label="Name">{(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label={user ? "New password (optional)" : "Password"} hint="At least 10 characters.">
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  required={!user}
                  minLength={user && !password ? undefined : 10}
                  value={password}
                  placeholder={user ? "Leave empty to keep" : ""}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
            </Field>
            <Field label="Global role" hint={GLOBAL_ROLES.find((r) => r.value === role)?.hint}>
              {(id) => (
                <Select id={id} value={role} onChange={(e) => setRole(e.target.value as GlobalRole)}>
                  {GLOBAL_ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <MembershipMatrix value={memberships} onChange={setMemberships} />
          {user && (
            <div className="flex items-center gap-2">
              <Switch id="user-active" checked={active} onCheckedChange={setActive} />
              <label htmlFor="user-active" className="text-sm">
                Active (can sign in)
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending && <Spinner className="text-primary-foreground" />} {user ? "Save" : "Add user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function UsersPage() {
  const qc = useQueryClient();
  const departments = useDepartments();
  const list = useQuery({ queryKey: queryKeys.users, queryFn: api.listUsers });
  const [editing, setEditing] = useState<{ user?: User } | null>(null);
  const [toDeactivate, setToDeactivate] = useState<User | null>(null);
  const deactivate = useMutation({
    mutationFn: (u: User) => api.updateUser(u.id, { is_active: false }),
    onSuccess: (u) => {
      void qc.invalidateQueries({ queryKey: queryKeys.users });
      toast.success(`${u.name} can no longer sign in`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div>
      <PageHeader
        title="Users"
        description="Who can sign in, and what they can do in each department."
        actions={
          <Button size="sm" onClick={() => setEditing({})}>
            <Plus /> Add user
          </Button>
        }
      />
      <Card className="overflow-hidden">
        {list.isLoading ? (
          <TableSkeleton rows={4} cols={4} />
        ) : list.isError ? (
          <ErrorState className="m-4" error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data!.length === 0 ? (
          <EmptyState className="m-4" icon={Users} title="No users yet" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Departments</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data!.map((u) => (
                <TableRow key={u.id} className={u.is_active === false ? "opacity-60" : undefined}>
                  <TableCell className="pl-4">
                    <p className="font-medium">{u.name}</p>
                    <p className="text-xs text-muted-foreground">{u.email}</p>
                  </TableCell>
                  <TableCell className="capitalize">{u.role}</TableCell>
                  <TableCell className="max-w-sm">
                    <div className="flex flex-wrap gap-1">
                      {(u.memberships ?? []).length === 0 ? (
                        <span className="text-xs text-muted-foreground">None</span>
                      ) : (
                        (u.memberships ?? []).map((m) => (
                          <Badge key={m.department} variant="outline" title={m.roles.map((r) => ROLE_LABELS[r]).join(", ")}>
                            {departmentName(m.department, departments.data)}: {m.roles.map((r) => ROLE_LABELS[r]).join(", ")}
                          </Badge>
                        ))
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{u.is_active === false ? <Badge variant="muted">Deactivated</Badge> : <Badge variant="success">Active</Badge>}</TableCell>
                  <TableCell className="pr-4">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${u.name}`} onClick={() => setEditing({ user: u })}>
                        <Pencil />
                      </Button>
                      {u.is_active !== false && (
                        <Button variant="ghost" size="icon-sm" aria-label={`Deactivate ${u.name}`} onClick={() => setToDeactivate(u)}>
                          <UserX />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      {editing && <UserDialog open user={editing.user} onOpenChange={(o) => !o && setEditing(null)} />}
      <ConfirmDialog
        open={!!toDeactivate}
        onOpenChange={(o) => !o && setToDeactivate(null)}
        title={`Deactivate ${toDeactivate?.name}?`}
        description="They can no longer sign in. Their workflows and history are kept. You can reactivate them later."
        confirmLabel="Deactivate"
        destructive
        onConfirm={() => toDeactivate && deactivate.mutate(toDeactivate)}
      />
    </div>
  );
}
