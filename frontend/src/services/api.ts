import { useAuthStore } from "@/stores/auth";
import type {
  Capability,
  Connection,
  ConnectionIn,
  ConnectionTestResult,
  ConnectorType,
  Department,
  DesignerSession,
  DesignerStatus,
  EnableRequest,
  InboxItem,
  PlanApplyRequest,
  PlanOperation,
  Proposal,
  SimulateRequest,
  UploadedFile,
  UserCreate,
  UserUpdate,
  WorkflowTemplate,
  Agent,
  AgentIn,
  AgentPreset,
  Approval,
  ApprovalDecision,
  ApprovalStatus,
  JSONObject,
  LoginResponse,
  Provider,
  ProviderIn,
  ProviderTestResult,
  Run,
  RunEvent,
  RunSummary,
  Stats,
  ToolInfo,
  User,
  ValidationResult,
  Workflow,
  WorkflowCreate,
  WorkflowDefinition,
  WorkflowExport,
  WorkflowSummary,
  WorkflowUpdate,
  WorkflowVersion,
} from "@/types";

export const API_BASE = "/api";

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, message: string, detail: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }

  /** A ValidationResult if the server returned one in `detail` (422 on execute). */
  get validation(): ValidationResult | null {
    const d = this.detail as Partial<ValidationResult> | null;
    if (d && typeof d === "object" && !Array.isArray(d) && Array.isArray(d.errors)) {
      return { valid: false, errors: d.errors, warnings: d.warnings ?? [] };
    }
    return null;
  }
}

/** A field of an object-shaped error `detail` (e.g. 422 `{detail: {message, findings}}`), or null. */
export function errorDetailField<T = unknown>(e: unknown, key: string): T | null {
  if (!(e instanceof ApiError)) return null;
  const d = e.detail;
  if (d && typeof d === "object" && !Array.isArray(d) && key in d) return (d as Record<string, unknown>)[key] as T;
  return null;
}

function detailToMessage(detail: unknown, fallback: string): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((d) => {
        if (d && typeof d === "object") {
          const o = d as { msg?: unknown; message?: unknown; loc?: unknown };
          const msg = typeof o.msg === "string" ? o.msg : typeof o.message === "string" ? o.message : null;
          const loc = Array.isArray(o.loc) ? o.loc.join(".") : null;
          if (msg) return loc ? `${loc}: ${msg}` : msg;
        }
        return null;
      })
      .filter(Boolean);
    if (parts.length) return parts.join("; ");
  }
  if (detail && typeof detail === "object") {
    const v = detail as Partial<ValidationResult> & { message?: unknown };
    if (Array.isArray(v.errors) && v.errors.length) {
      return v.errors.map((e) => e.message).join("; ");
    }
    if (typeof v.message === "string") return v.message;
  }
  return fallback;
}

let onUnauthorized: () => void = () => {
  useAuthStore.getState().logout();
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.assign(`/login?next=${next}`);
  }
};

/** Override the 401 handler (used by the router to avoid full page reloads, and by tests). */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
  auth?: boolean;
}

export function buildUrl(path: string, query?: RequestOptions["query"]): string {
  let url = `${API_BASE}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  return url;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = useAuthStore.getState().token;
  if (opts.auth !== false && token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (typeof FormData !== "undefined" && opts.body instanceof FormData) {
    // Let the browser set multipart/form-data with its boundary.
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? "GET",
      headers,
      body,
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "Network error — is the API reachable?", null);
  }

  if (res.status === 401 && opts.auth !== false) {
    onUnauthorized();
    throw new ApiError(401, "Session expired. Please sign in again.", null);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : data;
    throw new ApiError(res.status, detailToMessage(detail, `Request failed (${res.status})`), detail);
  }
  return data as T;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  // auth
  login: (email: string, password: string) =>
    request<LoginResponse>("/auth/login", { method: "POST", body: { email, password }, auth: false }),
  me: () => request<User>("/auth/me"),

  // workflows
  listWorkflows: (search?: string) => request<WorkflowSummary[]>("/workflows", { query: { search } }),
  getWorkflow: (id: string) => request<Workflow>(`/workflows/${id}`),
  createWorkflow: (body: WorkflowCreate) => request<Workflow>("/workflows", { method: "POST", body }),
  updateWorkflow: (id: string, body: WorkflowUpdate) => request<Workflow>(`/workflows/${id}`, { method: "PUT", body }),
  deleteWorkflow: (id: string) => request<void>(`/workflows/${id}`, { method: "DELETE" }),
  validateWorkflow: (id: string) => request<ValidationResult>(`/workflows/${id}/validate`, { method: "POST" }),
  validateDefinition: (definition: WorkflowDefinition) =>
    request<ValidationResult>("/workflows/validate", { method: "POST", body: { definition } }),
  duplicateWorkflow: (id: string) => request<Workflow>(`/workflows/${id}/duplicate`, { method: "POST" }),
  exportWorkflow: (id: string) => request<WorkflowExport>(`/workflows/${id}/export`),
  importWorkflow: (doc: WorkflowExport) => request<Workflow>("/workflows/import", { method: "POST", body: doc }),
  listVersions: (id: string) => request<WorkflowVersion[]>(`/workflows/${id}/versions`),
  executeWorkflow: (id: string, input?: JSONObject) =>
    request<Run>(`/workflows/${id}/execute`, { method: "POST", body: input === undefined ? {} : { input } }),

  // executions
  listExecutions: (params: { workflow_id?: string; status?: string; search?: string; limit?: number } = {}) =>
    request<RunSummary[]>("/executions", { query: { limit: 50, ...params } }),
  getExecution: (id: string) => request<Run>(`/executions/${id}`),
  pauseExecution: (id: string) => request<Run>(`/executions/${id}/pause`, { method: "POST" }),
  resumeExecution: (id: string) => request<Run>(`/executions/${id}/resume`, { method: "POST" }),
  cancelExecution: (id: string) => request<Run>(`/executions/${id}/cancel`, { method: "POST" }),
  retryExecution: (id: string) => request<Run>(`/executions/${id}/retry`, { method: "POST" }),
  listEvents: (id: string, after = 0) => request<RunEvent[]>(`/executions/${id}/events`, { query: { after } }),

  // agents
  listAgents: () => request<Agent[]>("/agents"),
  getAgent: (id: string) => request<Agent>(`/agents/${id}`),
  createAgent: (body: AgentIn) => request<Agent>("/agents", { method: "POST", body }),
  updateAgent: (id: string, body: AgentIn) => request<Agent>(`/agents/${id}`, { method: "PUT", body }),
  deleteAgent: (id: string) => request<void>(`/agents/${id}`, { method: "DELETE" }),
  listPresets: () => request<AgentPreset[]>("/agents/presets"),

  // model providers
  listProviders: () => request<Provider[]>("/model-providers"),
  createProvider: (body: ProviderIn) => request<Provider>("/model-providers", { method: "POST", body }),
  updateProvider: (id: string, body: ProviderIn) => request<Provider>(`/model-providers/${id}`, { method: "PUT", body }),
  deleteProvider: (id: string) => request<void>(`/model-providers/${id}`, { method: "DELETE" }),
  testProvider: (id: string) => request<ProviderTestResult>(`/model-providers/${id}/test`, { method: "POST" }),

  // tools
  listTools: () => request<ToolInfo[]>("/tools"),

  // approvals
  listApprovals: (status?: ApprovalStatus) => request<Approval[]>("/approvals", { query: { status } }),
  decideApproval: (id: string, body: ApprovalDecision) =>
    request<Approval>(`/approvals/${id}/decision`, { method: "POST", body }),

  // stats
  stats: () => request<Stats>("/stats"),

  // --- business workflows (docs/contracts-business.md) ----------------------
  previewPlan: (id: string, operations: PlanOperation[]) =>
    request<Proposal>(`/workflows/${id}/plan/preview`, { method: "POST", body: { operations } }),
  applyPlan: (id: string, body: PlanApplyRequest) => request<Workflow>(`/workflows/${id}/plan/apply`, { method: "POST", body }),
  detachWorkflow: (id: string) => request<Workflow>(`/workflows/${id}/detach`, { method: "POST" }),
  simulateWorkflow: (id: string, body: SimulateRequest) => request<Run>(`/workflows/${id}/simulate`, { method: "POST", body }),
  enableWorkflow: (id: string, body: EnableRequest) => request<Workflow>(`/workflows/${id}/enable`, { method: "POST", body }),
  disableWorkflow: (id: string) => request<Workflow>(`/workflows/${id}/disable`, { method: "POST" }),

  // designer
  designerStatus: () => request<DesignerStatus>("/designer/status"),
  createSession: (body: { prompt?: string; department: string; workflow_id?: string }) =>
    request<DesignerSession>("/designer/sessions", { method: "POST", body }),
  getSession: (id: string) => request<DesignerSession>(`/designer/sessions/${id}`),
  sendSessionMessage: (id: string, message: string) =>
    request<DesignerSession>(`/designer/sessions/${id}/messages`, { method: "POST", body: { message } }),
  acceptProposal: (id: string) => request<DesignerSession>(`/designer/sessions/${id}/accept`, { method: "POST" }),
  discardProposal: (id: string) => request<DesignerSession>(`/designer/sessions/${id}/discard`, { method: "POST" }),
  undoSession: (id: string) => request<DesignerSession>(`/designer/sessions/${id}/undo`, { method: "POST" }),
  redoSession: (id: string) => request<DesignerSession>(`/designer/sessions/${id}/redo`, { method: "POST" }),
  saveSession: (id: string, name?: string) =>
    request<Workflow>(`/designer/sessions/${id}/save`, { method: "POST", body: name ? { name } : {} }),

  // templates
  listTemplates: (department?: string) => request<WorkflowTemplate[]>("/templates", { query: { department } }),
  useTemplate: (id: string, body: { name?: string; department?: string } = {}) =>
    request<Workflow>(`/templates/${id}/use`, { method: "POST", body }),

  // registry
  listCapabilities: (department?: string) => request<Capability[]>("/capabilities", { query: { department } }),

  // organization
  listDepartments: () => request<Department[]>("/departments"),
  listUsers: () => request<User[]>("/users"),
  createUser: (body: UserCreate) => request<User>("/users", { method: "POST", body }),
  updateUser: (id: string, body: UserUpdate) => request<User>(`/users/${id}`, { method: "PUT", body }),

  // connectors / connections
  listConnectors: () => request<ConnectorType[]>("/connectors"),
  listConnections: () => request<Connection[]>("/connections"),
  createConnection: (body: ConnectionIn) => request<Connection>("/connections", { method: "POST", body }),
  updateConnection: (id: string, body: ConnectionIn) => request<Connection>(`/connections/${id}`, { method: "PUT", body }),
  deleteConnection: (id: string) => request<void>(`/connections/${id}`, { method: "DELETE" }),
  testConnection: (id: string) => request<ConnectionTestResult>(`/connections/${id}/test`, { method: "POST" }),

  // files
  uploadFile: (file: File, department?: string | null) => {
    const form = new FormData();
    form.append("file", file);
    if (department) form.append("department", department);
    return request<UploadedFile>("/files", { method: "POST", body: form });
  },

  // inbox
  listInbox: () => request<InboxItem[]>("/inbox"),
  markInboxDone: (id: string) => request<InboxItem>(`/inbox/${id}/done`, { method: "POST" }),
};

export const queryKeys = {
  me: ["me"] as const,
  workflows: (search?: string) => ["workflows", search ?? ""] as const,
  workflowsAll: ["workflows"] as const,
  workflow: (id: string) => ["workflow", id] as const,
  versions: (id: string) => ["workflow", id, "versions"] as const,
  executions: (params: Record<string, unknown>) => ["executions", params] as const,
  executionsAll: ["executions"] as const,
  execution: (id: string) => ["execution", id] as const,
  agents: ["agents"] as const,
  presets: ["agent-presets"] as const,
  providers: ["model-providers"] as const,
  tools: ["tools"] as const,
  approvals: (status?: string) => ["approvals", status ?? "all"] as const,
  approvalsAll: ["approvals"] as const,
  stats: ["stats"] as const,
  departments: ["departments"] as const,
  capabilities: (department?: string | null) => ["capabilities", department ?? "all"] as const,
  designerStatus: ["designer-status"] as const,
  session: (id: string) => ["designer-session", id] as const,
  templates: (department?: string) => ["templates", department ?? "all"] as const,
  connectors: ["connectors"] as const,
  connections: ["connections"] as const,
  users: ["users"] as const,
  inbox: ["inbox"] as const,
};
