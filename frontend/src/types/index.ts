// Types mirroring docs/contracts.md exactly. Keep in sync with the backend.
// Business-workflow additions (docs/contracts-business.md) live in ./business.

import type {
  BusinessNodeInfo,
  BusinessPlan,
  DefinitionMeta,
  Explanation,
  GlobalRole,
  Membership,
  PlanMeta,
  WorkflowStatus,
} from "./business";

export * from "./business";

export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };
export type JSONObject = { [key: string]: JSONValue };
export type JSONSchema = JSONObject;

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export const NODE_TYPES = [
  "start",
  "agent",
  "condition",
  "tool",
  "parallel",
  "join",
  "approval",
  "delay",
  "end",
  "fail",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const NODE_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export interface Position {
  x: number;
  y: number;
}

export type Operand = { ref: string } | { value: JSONValue };

export type LogicalOp = "and" | "or";
export type CompareOp = "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains";
export type UnaryOp = "exists" | "is_true" | "is_false";

export type Rule =
  | { op: LogicalOp; rules: Rule[] }
  | { op: "not"; rule: Rule }
  | { op: CompareOp; left: Operand; right: Operand }
  | { op: UnaryOp; left: Operand };

export interface RetryPolicy {
  max_attempts: number;
  backoff_seconds: number;
}

export type AgentPresetKey =
  | "planning"
  | "developer"
  | "testing"
  | "code_review"
  | "devops"
  | "documentation"
  | "repo_fetch";

export interface ScriptedStep {
  tool: string;
  args: JSONObject;
  [key: string]: JSONValue;
}

export interface AgentNodeConfig {
  agent_id?: string | null;
  kind: "llm" | "scripted";
  preset?: AgentPresetKey | string | null;
  system_prompt?: string;
  user_prompt?: string;
  model_provider_id?: string | null;
  model?: string | null;
  temperature?: number | null;
  max_tokens?: number | null;
  tools?: string[];
  timeout_seconds?: number | null;
  max_steps?: number | null;
  retry?: RetryPolicy | null;
  input_mapping?: Record<string, string>;
  output_schema?: JSONSchema | null;
  steps?: ScriptedStep[];
}

export interface StartNodeConfig {
  input_schema?: JSONSchema;
  default_input?: JSONObject;
}

export interface ConditionBranch {
  handle: string;
  label: string;
  rule: Rule;
}

export interface ConditionNodeConfig {
  branches: ConditionBranch[];
  default_handle: string;
}

export interface ToolNodeConfig {
  tool: string;
  args: Record<string, JSONValue>;
  timeout_seconds?: number;
  retry?: RetryPolicy;
}

export type ParallelNodeConfig = Record<string, never>;
export interface JoinNodeConfig {
  mode: "all" | "any";
}
export interface ApprovalNodeConfig {
  title: string;
  description?: string;
}
export interface DelayNodeConfig {
  seconds: number;
}
export type EndNodeConfig = Record<string, never>;
export interface FailNodeConfig {
  message?: string;
}

export interface NodeConfigByType {
  start: StartNodeConfig;
  agent: AgentNodeConfig;
  condition: ConditionNodeConfig;
  tool: ToolNodeConfig;
  parallel: ParallelNodeConfig;
  join: JoinNodeConfig;
  approval: ApprovalNodeConfig;
  delay: DelayNodeConfig;
  end: EndNodeConfig;
  fail: FailNodeConfig;
}

export type AnyNodeConfig = NodeConfigByType[NodeType];

export interface WorkflowNodeData {
  label: string;
  config: AnyNodeConfig;
  description?: string;
  /** Business-language description (compiled plan-based workflows). */
  business?: BusinessNodeInfo;
}

export interface WorkflowNode {
  id: string;
  type: NodeType;
  position: Position;
  data: WorkflowNodeData;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: "in";
  label?: string;
}

export interface WorkflowSettings {
  max_loop_iterations: number;
  max_total_steps: number;
  max_duration_seconds: number;
}

export interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  settings: WorkflowSettings;
  /** Compiler metadata (plan-based workflows). */
  meta?: DefinitionMeta;
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  name: string;
  role: GlobalRole;
  memberships?: Membership[];
  is_active?: boolean;
}

export interface LoginResponse {
  access_token: string;
  token_type: "bearer";
  user: User;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  version: number;
  updated_at: string;
  created_at: string;
  node_count: number;
  last_run_status: string | null;
  is_example: boolean;
  // business additions (optional so legacy payloads still type-check)
  department?: string | null;
  status?: WorkflowStatus;
  enabled_version?: number | null;
  has_plan?: boolean;
  plan_meta?: PlanMeta | null;
  /** Not in the contract: permissions of the current user, when the backend provides them. */
  can_edit?: boolean | null;
  can_enable?: boolean | null;
}

export interface Workflow extends WorkflowSummary {
  definition: WorkflowDefinition;
  plan?: BusinessPlan | null;
  explanation?: Explanation | null;
}

export interface WorkflowCreate {
  name: string;
  description?: string;
  definition: WorkflowDefinition;
}

export interface WorkflowUpdate {
  name?: string;
  description?: string;
  definition?: WorkflowDefinition;
}

export interface Issue {
  code: string;
  message: string;
  node_id?: string | null;
  edge_id?: string | null;
}

export interface ValidationResult {
  valid: boolean;
  errors: Issue[];
  warnings: Issue[];
}

export interface WorkflowExport {
  format: "agentic-sdlc/workflow@1";
  name: string;
  description: string | null;
  definition: WorkflowDefinition;
}

export interface WorkflowVersion {
  version: number;
  created_at: string;
  created_by: string | null;
}

export const RUN_STATUSES = [
  "PENDING",
  "RUNNING",
  "PAUSED",
  "WAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const NODE_RUN_STATUSES = [
  "PENDING",
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "SKIPPED",
  "WAITING",
  "CANCELLED",
] as const;
export type NodeRunStatus = (typeof NODE_RUN_STATUSES)[number];

export interface RunSummary {
  id: string;
  workflow_id: string;
  workflow_name: string;
  workflow_version: number;
  status: RunStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  steps: number;
  error: string | null;
  mode?: "real" | "simulation";
  triggered_by?: "manual" | "schedule" | "api";
  department?: string | null;
}

export interface NodeRunLog {
  ts: string;
  level: string;
  message: string;
}

export interface ToolCall {
  tool: string;
  args: JSONValue;
  result: JSONValue;
  error: string | null;
  duration_ms: number | null;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface NodeRun {
  id: string;
  node_id: string;
  node_type: NodeType;
  label: string;
  iteration: number;
  attempt: number;
  status: NodeRunStatus;
  input: JSONValue;
  output: JSONValue;
  error: string | null;
  selected_handle: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  logs: NodeRunLog[];
  tool_calls: ToolCall[];
  usage: TokenUsage | null;
  agent_kind: "llm" | "scripted" | null;
  model: string | null;
}

export interface Run extends RunSummary {
  input: JSONValue;
  output: JSONValue;
  definition: WorkflowDefinition;
  node_runs: NodeRun[];
  last_event_seq: number;
}

export const EVENT_TYPES = [
  "workflow.started",
  "workflow.paused",
  "workflow.resumed",
  "workflow.waiting_approval",
  "workflow.completed",
  "workflow.failed",
  "workflow.cancelled",
  "node.queued",
  "node.started",
  "node.progress",
  "node.completed",
  "node.failed",
  "node.skipped",
  "node.waiting",
  "node.cancelled",
  "edge.traversed",
  "approval.requested",
  "approval.resolved",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface RunEvent {
  seq: number;
  run_id: string;
  type: EventType | string;
  node_id: string | null;
  node_run_id: string | null;
  data: Record<string, JSONValue> | null;
  created_at: string;
}

export type WsServerMessage = { type: "event"; event: RunEvent } | { type: "ping" };

// Agents ---------------------------------------------------------------------

export type AgentConfig = Omit<AgentNodeConfig, "agent_id">;

export interface AgentIn {
  name: string;
  description?: string | null;
  kind: "llm" | "scripted";
  preset?: string | null;
  config: AgentConfig;
}

export interface Agent extends AgentIn {
  id: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface AgentPreset {
  key: AgentPresetKey | string;
  name: string;
  description: string;
  config: AgentConfig;
}

// Model providers -------------------------------------------------------------

export interface ProviderIn {
  name: string;
  base_url: string;
  default_model: string;
  api_key_ref?: string | null;
  timeout_seconds?: number | null;
  temperature?: number | null;
  max_tokens?: number | null;
}

export interface Provider extends ProviderIn {
  id: string;
  api_key_configured: boolean;
  created_at: string;
}

export interface ProviderTestResult {
  ok: boolean;
  detail: string;
  models: string[];
}

// Tools -----------------------------------------------------------------------

export interface ToolInfo {
  name: string;
  description: string;
  parameters: JSONSchema;
  dangerous: boolean;
}

// Approvals -------------------------------------------------------------------

export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface Approval {
  id: string;
  run_id: string;
  node_id: string;
  workflow_name: string;
  title: string;
  description: string | null;
  status: ApprovalStatus;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  comment: string | null;
  department?: string | null;
  required_role?: string | null;
  separation_of_duties?: boolean;
  can_decide?: boolean;
  reason_cannot_decide?: string | null;
}

export interface ApprovalDecision {
  decision: "approve" | "reject";
  comment?: string;
}

// Stats -----------------------------------------------------------------------

export interface Stats {
  workflows: number;
  runs_total: number;
  runs_by_status: Partial<Record<RunStatus, number>>;
  active_runs: number;
  pending_approvals: number;
  recent_runs: RunSummary[];
}

export interface ApiErrorBody {
  detail: string | Array<Record<string, unknown>> | ValidationResult | Record<string, unknown>;
}
