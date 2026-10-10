// Types mirroring docs/contracts-business.md exactly. Keep in sync with the backend.

import type { JSONObject, JSONValue, WorkflowDefinition } from "./index";

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export interface Department {
  code: string;
  name: string;
  sensitive: boolean;
}

export const DEPARTMENT_ROLES = ["member", "builder", "approver", "dept_admin"] as const;
export type DepartmentRole = (typeof DEPARTMENT_ROLES)[number];

export interface Membership {
  department: string;
  roles: DepartmentRole[];
}

export type GlobalRole = "admin" | "editor" | "viewer";

export interface UserCreate {
  email: string;
  name: string;
  password: string;
  role: GlobalRole;
  memberships: Membership[];
}

export interface UserUpdate {
  name?: string;
  password?: string;
  role?: GlobalRole;
  memberships?: Membership[];
  is_active?: boolean;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type CapabilityStatus = "available" | "requires_connection" | "restricted" | "unavailable";
export type SideEffect = "none" | "internal" | "communication" | "external_write" | "financial";

export interface CapabilityField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface Capability {
  id: string;
  name: string;
  description: string;
  category: string;
  app: string;
  inputs: CapabilityField[];
  outputs: CapabilityField[];
  side_effect: SideEffect;
  sensitivity: "low" | "medium" | "high";
  departments: string[];
  connector: "llm" | "smtp" | "http" | "chat" | string | null;
  connector_label: string | null;
  needs_approval: boolean;
  implementation: { kind: "tool" | "agent"; name: string };
  status: CapabilityStatus;
  status_reason: string | null;
}

// ---------------------------------------------------------------------------
// Business Plan (bp/1)
// ---------------------------------------------------------------------------

export type PlanTarget = string | "end" | { fail: string };

export type PlanInputType = "string" | "number" | "boolean" | "file" | "email" | "date" | "list";

export interface PlanInput {
  key: string;
  label: string;
  type: PlanInputType;
  required: boolean;
  description: string;
  example?: JSONValue;
}

export interface PlanTrigger {
  type: "manual" | "schedule" | "api";
  cron?: string | null;
  timezone: string;
}

export interface PlanRetry {
  max_attempts: number;
  backoff_seconds: number;
}

interface StepBase {
  id: string;
  title: string;
  description: string;
  next?: PlanTarget | null;
  policy_inserted?: boolean;
}

export interface ActionStep extends StepBase {
  kind: "action";
  capability: string;
  params: Record<string, JSONValue>;
  retry?: PlanRetry | null;
  on_failure?: "stop" | { goto: PlanTarget };
}

export interface DecisionBranch {
  id: string;
  label: string;
  when: JSONObject;
  goto: PlanTarget;
}

export interface DecisionStep extends StepBase {
  kind: "decision";
  branches: DecisionBranch[];
  otherwise: PlanTarget;
}

export interface ApprovalStep extends StepBase {
  kind: "approval";
  approver: { role: "approver" | "dept_admin"; department?: string | null };
  instructions: string;
  on_reject: PlanTarget;
  separation_of_duties: boolean;
}

export interface WaitStep extends StepBase {
  kind: "wait";
  seconds: number;
}

export type PlanStep = ActionStep | DecisionStep | ApprovalStep | WaitStep;
export type StepKind = PlanStep["kind"];

export interface BusinessPlan {
  schema: "bp/1";
  title: string;
  summary: string;
  department: string | null;
  trigger: PlanTrigger;
  inputs: PlanInput[];
  steps: PlanStep[];
  settings: Record<string, JSONValue>;
  ui: { positions?: Record<string, { x: number; y: number }> };
}

// ---------------------------------------------------------------------------
// Explanation / findings / diff / proposal
// ---------------------------------------------------------------------------

export type FindingSeverity = "error" | "setup" | "warning" | "info";

export interface Finding {
  severity: FindingSeverity;
  code: string;
  message: string;
  step_id?: string | null;
  capability?: string | null;
  connector?: string | null;
}

export interface ExplanationStep {
  step_id: string;
  title: string;
  kind: StepKind | string;
  policy_inserted: boolean;
  what?: string;
  app?: string | null;
  capability?: string;
  needs?: string[];
  produces?: string[];
  status?: CapabilityStatus;
  side_effect?: SideEffect;
  retry?: string;
  rules?: string[];
  requires_action?: boolean;
  on_reject?: string;
  separation_of_duties?: boolean;
  note?: string;
  then?: string | null;
}

export interface ExplanationIntegration {
  connector: string;
  label: string;
  status: CapabilityStatus;
  steps: string[];
}

export interface ExplanationPermission {
  /** Step title (contract). */
  step: string;
  /** Not in the contract yet: used when the backend provides it, otherwise resolved from the title. */
  step_id?: string;
  capability: string;
  side_effect: SideEffect;
  needs_authorization: boolean;
}

export interface Explanation {
  title: string;
  summary: string;
  department: string | null;
  trigger: string;
  inputs: { key: string; label: string; type: PlanInputType | string; required: boolean }[];
  steps: ExplanationStep[];
  integrations: ExplanationIntegration[];
  permissions: ExplanationPermission[];
  approvals: { title: string; policy_inserted: boolean; separation_of_duties: boolean }[];
  outcomes: string[];
  findings: Finding[];
  ready_to_enable: boolean;
}

export interface PlanDiff {
  added: { step_id: string; title: string; kind: string; policy_inserted: boolean }[];
  removed: { step_id: string; title: string; kind: string }[];
  changed: { step_id: string; title: string; fields: { field: string; before: JSONValue; after: JSONValue }[] }[];
  reordered: boolean;
  trigger_changed: boolean;
  inputs_added: string[];
  inputs_removed: string[];
  title_changed: boolean;
  settings_changed: boolean;
  layout_only: boolean;
}

export interface UnmetNeed {
  need: string;
  reason: string;
}

export interface Proposal {
  kind: "create" | "modify";
  plan: BusinessPlan;
  definition: WorkflowDefinition;
  explanation: Explanation;
  diff: PlanDiff | null;
  operations: JSONObject[] | null;
  findings: Finding[];
  unmet_needs: UnmetNeed[];
  summary: string;
}

/** `data.business` on compiled definition nodes. */
export interface BusinessNodeInfo {
  title: string;
  description?: string;
  kind: string;
  policy_inserted?: boolean;
  capability?: string;
  capability_name?: string;
  app?: string | null;
  side_effect?: SideEffect;
  needs?: { label: string; value: string }[];
  produces?: string[];
  connector?: string | null;
  connector_label?: string | null;
  requires_action?: boolean;
  separation_of_duties?: boolean;
}

export interface DefinitionMeta {
  plan_schema?: string;
  compiler_version?: string;
  registry_version?: string;
  policy_version?: string;
  plan_hash?: string;
  department?: string | null;
  trigger?: JSONValue;
  [key: string]: JSONValue | undefined;
}

export interface PlanMeta {
  compiler_version: string;
  registry_version: string;
  policy_version: string;
  plan_hash: string;
}

export type WorkflowStatus = "draft" | "enabled" | "disabled";

// ---------------------------------------------------------------------------
// Workflow lifecycle requests
// ---------------------------------------------------------------------------

export type PlanOperation = JSONObject & { op: string };

export interface PlanApplyRequest {
  operations: PlanOperation[];
  base_version: number;
  summary?: string;
}

export interface SimulateRequest {
  input: JSONObject;
  approvals?: Record<string, "approve" | "reject">;
  step_outputs?: Record<string, JSONObject>;
  version?: number;
}

export interface EnableRequest {
  version?: number;
  acknowledgements: string[];
}

export interface UnsupportedEdit {
  message: string;
  node_id?: string | null;
  edge_id?: string | null;
}

// ---------------------------------------------------------------------------
// Designer
// ---------------------------------------------------------------------------

export interface DesignerMessage {
  role: "user" | "assistant" | "system";
  content: string;
  at: string;
  proposal_kind?: string;
  /** Set by the backend when the assistant could not complete the request. */
  error?: boolean;
}

export interface DesignerSession {
  id: string;
  department: string;
  workflow_id: string | null;
  base_version: number | null;
  messages: DesignerMessage[];
  plan: BusinessPlan | null;
  definition: WorkflowDefinition | null;
  explanation: Explanation | null;
  proposal: Proposal | null;
  can_undo: boolean;
  can_redo: boolean;
}

export interface DesignerStatus {
  available: boolean;
  provider: string | null;
  model: string | null;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface TemplateNeed {
  connector: string;
  label: string;
  status: CapabilityStatus;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  department: string;
  description: string;
  runs_locally: boolean;
  needs: TemplateNeed[];
  step_count: number;
  plan: BusinessPlan;
  explanation: Explanation;
}

// ---------------------------------------------------------------------------
// Connectors / connections / files / inbox
// ---------------------------------------------------------------------------

export interface ConnectorField {
  key: string;
  label: string;
  type: "string" | "number" | "select" | "list" | "boolean" | string;
  required: boolean;
  options?: string[];
  default?: JSONValue;
  placeholder?: string;
}

export interface ConnectorType {
  type: string;
  label: string;
  description: string;
  capability_connector: string;
  fields: ConnectorField[];
  secret: { key: string; label: string; required: boolean };
}

export interface Connection {
  id: string;
  name: string;
  connector: string;
  config: JSONObject;
  departments: string[];
  enabled: boolean;
  has_secret: boolean;
  last_test_ok: boolean | null;
  last_test_at: string | null;
  created_at: string;
}

export interface ConnectionIn {
  name: string;
  connector: string;
  config: JSONObject;
  /** Write-only. Omit to keep the stored secret. */
  secret?: string;
  departments: string[];
}

export interface ConnectionTestResult {
  ok: boolean;
  detail: string;
}

export interface UploadedFile {
  id: string;
  name: string;
  content_type: string;
  size_bytes: number;
  department: string | null;
}

export interface InboxItem {
  id: string;
  kind: "notification" | "task";
  title: string;
  body: string | null;
  run_id: string | null;
  due_at: string | null;
  done_at: string | null;
  created_at: string;
}
