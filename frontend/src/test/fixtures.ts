import type { BusinessPlan, Explanation, Proposal, Workflow, WorkflowDefinition } from "@/types";

export const invoicePlan: BusinessPlan = {
  schema: "bp/1",
  title: "Invoice processing",
  summary: "Check invoices and notify accounts payable.",
  department: "finance",
  trigger: { type: "manual", timezone: "UTC" },
  inputs: [
    { key: "invoice", label: "Invoice file", type: "file", required: true, description: "" },
    { key: "amount", label: "Amount", type: "number", required: true, description: "" },
    { key: "note", label: "Note", type: "string", required: false, description: "" },
  ],
  steps: [
    { id: "check_fields", kind: "action", title: "Check invoice fields", description: "", capability: "doc.check_fields", params: { required_fields: ["invoice number", "IBAN"], document: { from: "input.invoice" } } },
    { id: "manager_approval", kind: "approval", title: "Finance manager approval", description: "", approver: { role: "approver", department: "finance" }, instructions: "Check the amount", on_reject: { fail: "Rejected" }, separation_of_duties: true, policy_inserted: true },
    { id: "notify_ap", kind: "action", title: "Email accounts payable", description: "", capability: "email.send", params: { to: "ap@example.com" } },
  ],
  settings: {},
  ui: {},
};

export const invoiceExplanation: Explanation = {
  title: "Invoice processing",
  summary: "Check invoices and notify accounts payable.",
  department: "finance",
  trigger: "Started manually by a person.",
  inputs: [
    { key: "invoice", label: "Invoice file", type: "file", required: true },
    { key: "amount", label: "Amount", type: "number", required: true },
  ],
  steps: [
    { step_id: "check_fields", title: "Check invoice fields", kind: "action", policy_inserted: false, what: "Checks that required fields are present.", app: "Documents (built-in)", needs: ["Document"], produces: ["Missing fields"], status: "available", side_effect: "none" },
    { step_id: "manager_approval", title: "Finance manager approval", kind: "approval", policy_inserted: true, what: "Waits for a decision by an approver in finance.", requires_action: true, separation_of_duties: true, note: "The approver must be a different person from whoever started the run." },
    { step_id: "notify_ap", title: "Email accounts payable", kind: "action", policy_inserted: false, what: "Sends an email.", app: "Email", needs: ["Recipient"], produces: ["Delivery status"], status: "requires_connection", side_effect: "communication" },
  ],
  integrations: [{ connector: "smtp", label: "Email", status: "requires_connection", steps: ["Email accounts payable"] }],
  permissions: [{ step: "Email accounts payable", capability: "Send email", side_effect: "communication", needs_authorization: true }],
  approvals: [{ title: "Finance manager approval", policy_inserted: true, separation_of_duties: true }],
  outcomes: ["The workflow finishes when it reaches 'Done'."],
  findings: [{ severity: "setup", code: "connection_missing", message: "Connect an email server (SMTP) for Finance.", connector: "smtp" }],
  ready_to_enable: false,
};

export const invoiceDefinition: WorkflowDefinition = {
  nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 }, data: { label: "Start", config: { default_input: {} }, business: { title: "Start", kind: "start", description: "Started manually by a person.", needs: [], produces: [], requires_action: true } } },
    { id: "check_fields", type: "tool", position: { x: 300, y: 0 }, data: { label: "Check invoice fields", config: { tool: "doc_check_fields", args: {} }, business: { title: "Check invoice fields", kind: "action", app: "Documents (built-in)", needs: [{ label: "Document", value: "'invoice' from the request" }], produces: ["Missing fields"], requires_action: false, side_effect: "none" } } },
    { id: "manager_approval", type: "approval", position: { x: 600, y: 0 }, data: { label: "Finance manager approval", config: { title: "Finance manager approval" }, business: { title: "Finance manager approval", kind: "approval", policy_inserted: true, requires_action: true, app: "Approvals (built-in)", needs: [], produces: ["Approved / rejected"] } } },
    { id: "end", type: "end", position: { x: 900, y: 0 }, data: { label: "Done", config: {}, business: { title: "Done", kind: "end", needs: [], produces: [], requires_action: false } } },
  ],
  edges: [
    { id: "e_start_out_check_fields", source: "start", target: "check_fields", sourceHandle: "out", targetHandle: "in" },
    { id: "e_check_fields_out_manager_approval", source: "check_fields", target: "manager_approval", sourceHandle: "out", targetHandle: "in" },
    { id: "e_manager_approval_approved_end", source: "manager_approval", target: "end", sourceHandle: "approved", targetHandle: "in", label: "Approved" },
  ],
  settings: { max_loop_iterations: 5, max_total_steps: 100, max_duration_seconds: 3600 },
  meta: { plan_schema: "bp/1", compiler_version: "1", registry_version: "1", policy_version: "1", plan_hash: "abc" },
};

export function makeProposal(over: Partial<Proposal> = {}): Proposal {
  return {
    kind: "create",
    plan: invoicePlan,
    definition: invoiceDefinition,
    explanation: invoiceExplanation,
    diff: null,
    operations: null,
    findings: invoiceExplanation.findings,
    unmet_needs: [{ need: "Look up the employee's manager", reason: "No connected HR system provides this yet." }],
    summary: "Here is a workflow that checks the invoice, asks the finance manager and notifies accounts payable.",
    ...over,
  };
}

export const planWorkflow: Workflow = {
  id: "wf-1",
  name: "Invoice processing",
  description: null,
  version: 3,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  node_count: 4,
  last_run_status: null,
  is_example: false,
  department: "finance",
  status: "draft",
  enabled_version: null,
  has_plan: true,
  plan_meta: { compiler_version: "1", registry_version: "1", policy_version: "1", plan_hash: "abc" },
  definition: invoiceDefinition,
  plan: invoicePlan,
  explanation: invoiceExplanation,
};
