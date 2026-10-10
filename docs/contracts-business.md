# Business Workflow API Contract (additions to `docs/contracts.md`)

Design: `docs/superpowers/specs/2026-10-10-business-ai-workflow-design.md`. All routes are under
`/api` with Bearer auth.

## Core objects

```ts
type Department = { code: "hr"|"finance"|"operations"|"it"|"engineering"|string; name: string; sensitive: boolean }
type Membership = { department: string; roles: ("member"|"builder"|"approver"|"dept_admin")[] }
type User = { id; email; name; role: "admin"|"editor"|"viewer"; memberships: Membership[]; is_active: boolean }
// GET /api/auth/me returns User (with memberships)

type CapabilityStatus = "available" | "requires_connection" | "restricted" | "unavailable"
type Capability = {
  id; name; description; category; app;
  inputs: Field[]; outputs: Field[];            // Field = {key,label,type,required,description}
  side_effect: "none"|"internal"|"communication"|"external_write"|"financial";
  sensitivity: "low"|"medium"|"high"; departments: string[];   // ["*"] = all
  connector: "llm"|"smtp"|"http"|"chat"|null; connector_label: string|null;
  needs_approval: boolean; implementation: {kind: "tool"|"agent", name: string};
  status: CapabilityStatus; status_reason: string|null       // for ?department=
}

// Business Plan (bp/1): see spec §2. Step kinds: action | decision | approval | wait.
type Target = string /* step id */ | "end" | { fail: string }
type BusinessPlan = {
  schema: "bp/1"; title; summary; department: string|null;
  trigger: { type: "manual"|"schedule"|"api"; cron?: string; timezone: string };
  inputs: { key; label; type: "string"|"number"|"boolean"|"file"|"email"|"date"|"list"; required; description; example? }[];
  steps: Step[]; settings: {...}; ui: { positions?: Record<string,{x,y}> }
}

type Finding = { severity: "error"|"setup"|"warning"|"info"; code; message; step_id?; capability?; connector? }

type Explanation = {
  title; summary; department; trigger: string;
  inputs: {key,label,type,required}[];
  steps: { step_id; title; kind; policy_inserted; what?; app?; capability?; needs?: string[]; produces?: string[];
           status?: CapabilityStatus; side_effect?; retry?; rules?: string[]; requires_action?; on_reject?;
           separation_of_duties?; note?; then?: string|null }[];
  integrations: { connector; label; status: CapabilityStatus; steps: string[] }[];
  permissions: { step; step_id; capability; side_effect; needs_authorization: boolean }[];
  approvals: { title; policy_inserted; separation_of_duties }[];
  outcomes: string[]; findings: Finding[]; ready_to_enable: boolean
}

type Diff = { added: {step_id,title,kind,policy_inserted}[]; removed: {step_id,title,kind}[];
              changed: {step_id,title,fields:{field,before,after}[]}[]; reordered: boolean;
              trigger_changed; inputs_added: string[]; inputs_removed: string[]; title_changed;
              settings_changed; layout_only: boolean }

type Proposal = {
  kind: "create" | "modify";
  plan: BusinessPlan; definition: WorkflowDefinition /* compiled, read-only preview */;
  explanation: Explanation; diff: Diff | null; operations: object[] | null;
  findings: Finding[]; unmet_needs: { need: string; reason: string }[];
  summary: string   // planner's short, friendly description of what it did
}
```

The compiled `WorkflowDefinition` nodes carry `data.business`:

```ts
{ title, description, kind, policy_inserted, capability?, capability_name?, app?, side_effect?,
  needs: {label, value}[], produces: string[], connector?, connector_label?, requires_action: boolean,
  separation_of_duties? }
```

The editor shows these by default. The technical `data.config` appears only in Advanced mode.
`definition.meta = { plan_schema, compiler_version, registry_version, policy_version, plan_hash,
department, trigger }`.

## Workflows (extended)

`WorkflowSummary` and `Workflow` gain:

```ts
department: string|null; status: "draft"|"enabled"|"disabled"; enabled_version: number|null;
has_plan: boolean; plan_meta: { compiler_version, registry_version, policy_version, plan_hash } | null
```

`Workflow` also has `plan: BusinessPlan|null` and `explanation: Explanation|null`.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/workflows/{id}/plan/preview` | `{ operations }` | `Proposal` (kind "modify"). Nothing saved |
| POST | `/api/workflows/{id}/plan/apply` | `{ operations, base_version, summary? }` | `Workflow` (new version). 409 if `base_version` ≠ current. 422 `{detail:{message, findings}}` on errors |
| PUT | `/api/workflows/{id}` | `{ definition }` (Advanced editor) | For plan-based workflows the graph is translated into operations. 422 `{detail:{message, unsupported:[{message,node_id?,edge_id?}], operations}}` if any edit cannot be represented (nothing saved) |
| POST | `/api/workflows/{id}/detach` | | `Workflow` with `plan: null` (advanced-only from now on; audited) |
| POST | `/api/workflows/{id}/simulate` | `{ input, approvals?: {step_id: "approve"\|"reject"}, step_outputs?: {step_id: object}, version? }` | `Run` with `mode: "simulation"` (draft/latest version; no side effects) |
| POST | `/api/workflows/{id}/enable` | `{ version?, acknowledgements: string[] /* step ids of sensitive steps */ }` | `Workflow`. 422 `{detail:{message, findings, missing_acknowledgements}}` |
| POST | `/api/workflows/{id}/disable` | | `Workflow` |
| POST | `/api/workflows/{id}/execute` | `{ input }` | Plan-based workflows must be `enabled`. The run uses `enabled_version`. Required inputs are checked: 422 `{detail:{message, missing_inputs}}` |

`Run` and `RunSummary` gain `mode: "real"|"simulation"`, `triggered_by: "manual"|"schedule"|"api"`
and `department`. Simulated node outputs contain `_simulated: true` and `_simulation_note`.
`/api/stats` excludes simulation runs.

`Approval` gains `department`, `required_role`, `separation_of_duties`, and `can_decide: boolean`
for the current user, plus `reason_cannot_decide: string|null`.

## Designer (AI-assisted builder)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/designer/sessions` | `{ prompt?, department, workflow_id? }` | `Session` (with `proposal` when a prompt was given) |
| GET | `/api/designer/sessions/{id}` | | `Session` |
| POST | `/api/designer/sessions/{id}/messages` | `{ message }` | `Session` with a new `proposal` (relative to the accepted plan, or to the pending proposal if nothing is accepted yet) |
| POST | `/api/designer/sessions/{id}/accept` | | `Session` (proposal becomes the accepted plan, previous plan goes on the undo stack) |
| POST | `/api/designer/sessions/{id}/discard` | | `Session` (`proposal: null`) |
| POST | `/api/designer/sessions/{id}/undo` / `redo` | | `Session` |
| POST | `/api/designer/sessions/{id}/save` | `{ name? }` | `Workflow` (new draft workflow, or a new version of `workflow_id`). 409 if the workflow changed since the session started |
| GET | `/api/designer/status` | | `{ available: boolean, provider: string|null, model: string|null, reason: string|null }` |

```ts
type Session = { id; department; workflow_id: string|null; base_version: number|null;
  messages: { role: "user"|"assistant"|"system"; content: string; at: string; proposal_kind?: string }[];
  plan: BusinessPlan|null; definition: WorkflowDefinition|null; explanation: Explanation|null;  // accepted
  proposal: Proposal|null; can_undo: boolean; can_redo: boolean }
```

If no AI model is configured, POST /sessions and /messages return 409
`{detail: "No AI model is configured..."}`. The UI then shows the setup requirement and links to
Templates or Model Settings.

## Templates

| Method | Path | Response |
|---|---|---|
| GET | `/api/templates?department=` | `{ id, name, department, description, runs_locally: boolean, needs: {connector,label,status}[], step_count, plan, explanation }[]` |
| POST | `/api/templates/{id}/use` | body `{ name?, department? }` → `Workflow` (draft, plan-based) |

## Registry

| Method | Path | Response |
|---|---|---|
| GET | `/api/capabilities?department=` | `Capability[]` with status |
| GET | `/api/agents` | existing, plus `profile: { capabilities: string[], departments: string[], business_description, input_schema, output_schema, required_tools: string[], config_requirements: string[], constraints: object, availability: "available"\|"requires_connection", builtin: boolean }` |
| GET | `/api/tools` | existing, plus `side_effect, connector, capabilities: string[]` |

## Organization

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/departments` | | `Department[]` |
| GET | `/api/users` | (admin) | `User[]` |
| POST | `/api/users` | (admin) `{email,name,password,role,memberships}` | `User` |
| PUT | `/api/users/{id}` | (admin) `{name?,password?,role?,memberships?,is_active?}` | `User` |
| GET | `/api/connectors` | | `{ type, label, description, capability_connector, fields: {key,label,type,required,options?,default?,placeholder?}[], secret: {key,label,required} }[]` |
| GET | `/api/connections` | | `{ id, name, connector, config, departments, enabled, has_secret, last_test_ok, last_test_at, created_at }[]` (no secrets, ever) |
| POST | `/api/connections` | (admin) `{name, connector, config, secret?, departments}` | `Connection` |
| PUT | `/api/connections/{id}` | (admin) same; omit `secret` to keep it | `Connection` |
| DELETE | `/api/connections/{id}` | (admin) | 204 |
| POST | `/api/connections/{id}/test` | (admin) | `{ ok, detail }`. Never sends a message |
| POST | `/api/files` | multipart `file`, `department?` | `{ id, name, content_type, size_bytes, department }` (max 20 MB; PDF/TXT/MD/CSV) |
| GET | `/api/inbox` | | `{ id, kind: "notification"\|"task", title, body, run_id, due_at, done_at, created_at }[]` |
| POST | `/api/inbox/{id}/done` | | item |
