import type { Tone } from "@/lib/status";
import type {
  BusinessPlan,
  CapabilityStatus,
  Department,
  DepartmentRole,
  Explanation,
  ExplanationPermission,
  FindingSeverity,
  SideEffect,
  User,
  WorkflowStatus,
  WorkflowSummary,
} from "@/types";

// ---------------------------------------------------------------------------
// Capability / integration status
// ---------------------------------------------------------------------------

export const CAPABILITY_STATUS: Record<CapabilityStatus, { label: string; tone: Tone; description: string }> = {
  available: { label: "Available", tone: "success", description: "Ready to use." },
  requires_connection: {
    label: "Needs connection",
    tone: "warning",
    description: "An administrator must connect this app before the workflow can be enabled.",
  },
  restricted: { label: "Restricted", tone: "destructive", description: "Not allowed for this department." },
  unavailable: { label: "Not available", tone: "muted", description: "This app is not available on this platform." },
};

export function capabilityStatus(status: CapabilityStatus | string | null | undefined) {
  return CAPABILITY_STATUS[(status ?? "available") as CapabilityStatus] ?? CAPABILITY_STATUS.unavailable;
}

// ---------------------------------------------------------------------------
// Side effects / authorization
// ---------------------------------------------------------------------------

export const SENSITIVE_EFFECTS: SideEffect[] = ["communication", "external_write", "financial"];

export function isSensitive(effect: SideEffect | string | null | undefined): boolean {
  return !!effect && (SENSITIVE_EFFECTS as string[]).includes(effect);
}

/** "I authorize this workflow to …" — plain language for a side-effect class. */
export function authorizationPhrase(effect: SideEffect | string | null | undefined, app?: string | null): string {
  switch (effect) {
    case "communication":
      return "send messages outside the workflow";
    case "external_write":
      return app ? `change data in ${app}` : "change data in another system";
    case "financial":
      return "perform financial actions";
    case "internal":
      return "create items inside this platform (reports, tasks, notifications)";
    default:
      return "run this step";
  }
}

export function sideEffectLabel(effect: SideEffect | string | null | undefined): string {
  switch (effect) {
    case "communication":
      return "Sends messages";
    case "external_write":
      return "Changes data in another system";
    case "financial":
      return "Financial action";
    case "internal":
      return "Creates items in this platform";
    case "none":
      return "Read-only";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export const FINDING_META: Record<FindingSeverity, { label: string; tone: Tone }> = {
  error: { label: "Must fix", tone: "destructive" },
  setup: { label: "Setup needed", tone: "warning" },
  warning: { label: "Warning", tone: "warning" },
  info: { label: "Note", tone: "info" },
};

export function isBlocking(severity: FindingSeverity | string): boolean {
  return severity === "error" || severity === "setup";
}

// ---------------------------------------------------------------------------
// Workflow status
// ---------------------------------------------------------------------------

export function workflowStatusLabel(wf: Pick<WorkflowSummary, "status" | "enabled_version">): { label: string; tone: Tone } {
  const status: WorkflowStatus = wf.status ?? "draft";
  if (status === "enabled") return { label: wf.enabled_version ? `Enabled v${wf.enabled_version}` : "Enabled", tone: "success" };
  if (status === "disabled") return { label: "Disabled", tone: "muted" };
  return { label: "Draft", tone: "secondary" };
}

// ---------------------------------------------------------------------------
// Step kinds
// ---------------------------------------------------------------------------

export function stepKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "action":
      return "Action";
    case "decision":
      return "Decision";
    case "approval":
      return "Approval";
    case "wait":
      return "Wait";
    case "start":
      return "Start";
    case "end":
      return "Finish";
    case "fail":
      return "Stop";
    default:
      return "Step";
  }
}

// ---------------------------------------------------------------------------
// Departments / roles
// ---------------------------------------------------------------------------

export function departmentName(code: string | null | undefined, departments: Department[] | undefined): string {
  if (!code) return "No department";
  return departments?.find((d) => d.code === code)?.name ?? code.toUpperCase();
}

export function isAdmin(user: User | null | undefined): boolean {
  return user?.role === "admin";
}

export function hasDeptRole(user: User | null | undefined, department: string, roles: DepartmentRole[]): boolean {
  return !!user?.memberships?.some((m) => m.department === department && m.roles.some((r) => roles.includes(r)));
}

/** Departments where the user may build workflows (builder or dept_admin, all for admins). */
export function builderDepartments(user: User | null | undefined, departments: Department[] | undefined): Department[] {
  const all = departments ?? [];
  if (!user || user.role === "viewer") return [];
  if (isAdmin(user)) return all;
  return all.filter((d) => hasDeptRole(user, d.code, ["builder", "dept_admin"]));
}

export const ROLE_LABELS: Record<DepartmentRole, string> = {
  member: "Member",
  builder: "Builder",
  approver: "Approver",
  dept_admin: "Department admin",
};

// ---------------------------------------------------------------------------
// Permissions → step ids (acknowledgements)
// ---------------------------------------------------------------------------

/**
 * Explanation permissions identify steps by title (contract). Acknowledgements must be step ids, so
 * resolve them: explicit `step_id` if the backend provides one, else match the title in the plan,
 * then in the explanation steps.
 */
export function permissionStepId(
  perm: ExplanationPermission,
  plan: BusinessPlan | null | undefined,
  explanation: Explanation | null | undefined,
): string {
  if (perm.step_id) return perm.step_id;
  const fromPlan = plan?.steps.find((s) => s.title === perm.step)?.id;
  if (fromPlan) return fromPlan;
  return explanation?.steps.find((s) => s.title === perm.step)?.step_id ?? perm.step;
}

export function sensitivePermissions(explanation: Explanation | null | undefined): ExplanationPermission[] {
  return (explanation?.permissions ?? []).filter((p) => p.needs_authorization);
}

// ---------------------------------------------------------------------------
// Example prompts per department
// ---------------------------------------------------------------------------

export const EXAMPLE_PROMPTS: Record<string, string[]> = {
  hr: [
    "When an employee submits a leave request, check their manager approves it and notify HR",
    "Onboard a new hire: create their welcome tasks, ask IT for an account and send them a welcome message",
    "Check an uploaded employment document has a signature, a start date and a salary before HR files it",
  ],
  finance: [
    "Process an uploaded invoice: check it has an invoice number and IBAN; if the amount is over 10,000 the finance manager must approve; then notify accounts payable",
    "Verify an expense report CSV: flag any line over 500 and ask a finance approver to review flagged items",
    "Compare this month's budget CSV with the forecast and write a variance report for the finance team",
  ],
  operations: [
    "Every weekday at 9:00 summarize yesterday's operations CSV into a daily report and share it with the ops channel",
    "When a service ticket is marked urgent, notify the on-call manager and create a follow-up task",
  ],
  it: [
    "When someone requests access to a system, their manager approves, then IT gets a task to grant it",
    "Analyze an uploaded incident log, summarize the likely cause and notify the IT on-call channel",
  ],
  engineering: [
    "Turn a feature request into a requirements summary and a task list for the team",
    "Review a code change description, list risks and ask a tech lead to approve",
  ],
};

export const GENERIC_PROMPTS = [
  "When a request comes in, check it is complete, ask a manager to approve, then notify the team",
  "Summarize an uploaded document and send the summary to the department channel",
];

export function examplePromptsFor(department: string | null | undefined): string[] {
  return (department && EXAMPLE_PROMPTS[department]) || GENERIC_PROMPTS;
}
