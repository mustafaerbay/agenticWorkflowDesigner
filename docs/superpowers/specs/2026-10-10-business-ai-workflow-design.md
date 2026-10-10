# Business-Friendly AI Workflow Creation — Design

Status: approved approach (Option B, "Business Plan + Deterministic Compiler"), 2026-10-10.
Scope: the enhancement request plus its ten follow-up requirements. Docker Compose remains the
only deployment method (`/opt/agentic-sdlc` on `178.105.26.247`).

## 1. Goals and decisions

Non-technical users (HR, Finance, Operations, IT, Software Development) should be able to
describe a task, get a workflow they understand, refine it in conversation, simulate it safely,
enable it with explicit authorization, run it, and monitor it.

| Decision | Choice |
|---|---|
| Canonical representation | **Business Plan (BP)**: typed, versioned JSON. The React Flow definition is *compiled* from it. |
| Designer model | The existing OpenAI-compatible provider mechanism (any provider, configured in the UI or `.env`). |
| Planner | `Planner` interface. v1 is the `LlmPlanner` (structured JSON with a repair loop). An agentic planner can be added later without changing the compiler or policy. |
| Real connectors in v1 | Built-in local tools, SMTP email, HTTP/webhook endpoints, Slack/Teams incoming webhooks |
| Identity | In-app user admin: global role plus per-department roles |
| Extra triggers and inputs | Scheduled (cron) trigger; file upload as a run input |

Out of scope for v1: SSO, MCP servers, OAuth connectors (e.g. Google/Microsoft 365), parallel
branches inside Business Plans, and an agentic planning mode.

## 2. Business Plan schema (`bp/1`)

```jsonc
{
  "schema": "bp/1",
  "title": "Invoice processing",
  "summary": "…business description…",
  "department": "finance",
  "trigger": { "type": "manual" }            // | {"type":"schedule","cron":"0 9 * * FRI","timezone":"UTC"} | {"type":"api"}
  ,"inputs": [ { "key": "invoice", "label": "Invoice file", "type": "file", "required": true, "description": "" } ],
  "steps": [ Step, ... ],                    // ordered; default flow is list order
  "settings": { "max_loop_iterations": 5, "max_total_steps": 100, "max_duration_seconds": 3600 },
  "ui": { "positions": { "<node id>": {"x": 0, "y": 0} } }   // visual-only metadata
}
```

`Step` is a tagged union on `kind`. `id` is a stable slug (`^[a-z][a-z0-9_]{0,63}$`) that is
assigned once and never changes. It is also the compiled node id.

| kind | fields |
|---|---|
| `action` | `capability` (registry id), `params` {name: literal \| `{"from": "input.x"}` \| `{"from": "steps.<id>.<field>"}`}, `retry`?, `on_failure`: `"stop"` \| `{"goto": id}` |
| `decision` | `branches`: [{`id`, `label`, `when`: Condition, `goto`: target}], `otherwise`: target |
| `approval` | `approver`: {`role`: "approver", `department`?}, `instructions`, `on_reject`: target, `separation_of_duties`: bool |
| `wait` | `seconds` |

Common step fields: `id`, `kind`, `title`, `description`, `next` (target, default = next step or
`end`), `policy_inserted` (bool, set only by the policy engine).

A target is a step id, `"end"`, or `{"fail": "message"}`.

A Condition is the existing rule grammar (`and/or/not`, comparisons), with refs written as
`input.<key>` or `steps.<id>.<field>`, plus `steps.<id>.attempts`.

## 3. Registries

**Capability registry** (code-defined, `REGISTRY_VERSION`). A capability is what the LLM
chooses. Each one declares:
- id, name, business description, category, departments allowed
- inputs and outputs (key, label, type, required)
- side-effect class: `none | internal | communication | external_write | financial`
- sensitivity
- connector type (if any)
- implementation: `tool` (+ tool name and argument mapping) or `agent` (+ registry agent key)
- a simulation sample output

Status is computed per department and per user:
`available | requires_connection | restricted | unavailable`.

**Agent registry**: the `agents` table gains capabilities, departments, business description,
input/output schemas, required tools, configuration requirements, constraints, and availability.
Built-in agents are seeded: Document Analysis, Communication, Data Analysis and Development.
The Development agent reuses the existing presets.

**Tool and connector registry**: tool specs gain capability, connector type, auth requirements,
scopes, department restrictions, side-effect class, approval requirement, and availability.

**Connections** are admin-created instances of a connector type. Non-secret config is stored in
plain JSON. Secrets are encrypted with Fernet (`CONNECTION_ENCRYPTION_KEY`), written only, and
never returned or included in workflow JSON or LLM prompts. Each connection lists the
departments allowed to use it.

## 4. Compiler (`COMPILER_VERSION`)

`compile(plan, registry) -> definition` is a pure, deterministic function:
- **Nodes:**
  - `start`
  - one node per step, with `node.id = step.id`
  - `end`
  - one `fail_<hash>` node per distinct failure message
- **Edges:** ids are `e_<src>_<handle>_<tgt>`.
- **Positions** come from `plan.ui.positions`. Otherwise a deterministic layered layout is used.
- **Node types by step kind:**
  - action with a tool implementation → `tool` node, with args mapped from params
  - action with an agent implementation → `agent` node, with the registry agent and an explicit
    `input_mapping` (data minimization: only the declared params are passed)
  - decision → `condition` node
  - approval → `approval` node
  - wait → `delay` node
- **Node data:** every node carries `data.business` = {title, description, needs[], produces[],
  app, requires_action, capability, side_effect}.
- **Metadata:** `definition.meta` = {`plan_schema`, `compiler_version`, `registry_version`,
  `policy_version`, `plan_hash`}.

Compiling the same plan twice gives byte-identical output, and unchanged steps keep their ids.

## 5. Policy engine (`POLICY_VERSION`), independent of the LLM

Pure functions over the plan, the registry, the department and the user:
1. A capability must be allowed for the workflow's department, otherwise **restricted** (error).
2. A capability that needs a connector with no usable connection for the department becomes a
   **setup requirement**. This does not block saving a draft; it blocks enabling.
3. A side effect of `communication | external_write | financial` needs an approval step before
   it on every path. If one is missing, the policy engine inserts
   `approval_before_<step>` (`policy_inserted: true`) and explains why.
4. `financial` steps make preceding approvals `separation_of_duties: true`. At runtime the
   approver must differ from the run's initiator; this is enforced by the API, not the designer.
5. An unknown capability means an unmet need, shown as a setup requirement. Nothing is ever
   substituted.

Runtime enforcement happens in the worker and the API, whatever the plan says:
- the connection must exist and allow the workflow's department
- tool permissions are checked
- separation of duties is checked on approval decisions
- runs execute only the **enabled** version

## 6. Editing: typed operations

Supported operations:
- `add_step` {step, after?|before?}
- `remove_step` {step_id}
- `update_step` {step_id, title?, description?, params?}
- `set_condition` {step_id, branches, otherwise}
- `add_approval_before` {step_id, approver?, title?, separation_of_duties?}
- `set_retry` {step_id, max_attempts, backoff_seconds}
- `set_next` {step_id, next}
- `set_on_failure` {step_id, on_failure}
- `set_trigger` {trigger}
- `add_input` {input}
- `remove_input` {key}
- `rename` {title}

They are applied **transactionally** to a copy of the plan, then policy, compile and validate
run. On any error nothing is applied. The diff is computed at step level (added, removed,
changed fields, re-routed flow) plus requirement changes.

**Natural language → operations.** The LLM returns `{operations: [...]}`, which is validated
against the operation schema. Errors are fed back once.

**Visual → operations.** `graph_to_operations(old_plan, old_definition, new_definition)`
supports these edits:
- label or description changes
- moving nodes (positions)
- tool args and retry
- condition rules and branch targets
- deleting a step node
- rewiring an edge between step nodes
- adding a node whose kind maps to a step (approval, delay, condition, or a tool backed by a
  capability)

Anything else (parallel/join nodes, custom LLM agent tooling, scripted agents, multiple
incoming edges that can't be expressed as targets) is reported as **unsupported**, with a reason
per change. The save is rejected with HTTP 422 and nothing is discarded. The user can also
choose **Detach from business plan**, which turns it into a classic advanced-only workflow.

Every accepted change creates a new workflow version. The designer session keeps an undo/redo
stack of accepted plans, and nothing is saved until the user clicks Save.

## 7. Designer service (`app/designer/`)

- `Planner` interface: `propose(request, context) -> PlanDraft` and
  `modify(plan, request, context) -> list[Operation]`. `LlmPlanner` uses the configured provider
  in JSON mode. Its prompt holds the *business capability catalog* (ids, descriptions, I/O,
  status) and never secrets.
- Pipeline:
  1. planner output
  2. pydantic validation, plus capability ids checked against the registry
  3. repair loop (max 2)
  4. normalize ids
  5. policy
  6. compile
  7. graph validation
  8. deterministic explanation
- The **explanation** is generated from the plan and registry, not by the LLM: business steps,
  inputs, outputs, integrations needed and their status, permissions and side effects,
  conditions in plain words, approvals, and expected outcomes.
- **Sessions** (`designer_sessions`, persisted) hold the conversation, the current proposal, and
  the undo/redo stacks of accepted plans.

## 8. Lifecycle, execution and simulation

- A workflow has `department`, `status` (`draft | enabled | disabled`) and `enabled_version`.
  Each version stores `plan` (nullable for advanced-only workflows) and the compiled
  `definition`.
- **Enabling** requires: a valid compile, no restricted capabilities, all connections present,
  and an explicit acknowledgement of every sensitive capability (communication, external write,
  financial). This is audited. Manual runs, API runs and schedules execute the
  `enabled_version` snapshot.
- Runs keep snapshotting the definition (with `meta`) as today, so editing never affects running
  executions. Legacy workflows (no plan) are treated as enabled at their current version for
  compatibility.
- **Simulation**: `POST /workflows/{id}/simulate` creates a run with `mode="simulation"` on the
  draft (latest) version, using the same engine.
  - Tools with any side effect return the capability's labelled sample output instead of
    executing.
  - Approvals are decided automatically from the simulation input (approve by default).
  - Waits are shortened to 0 s.
  - LLM agents execute normally when a provider is configured, and are otherwise stubbed with
    labelled samples.
  - Simulation runs are visually distinct and never count as real executions.
- **Schedules**: the orchestrator sweeper fires enabled scheduled workflows (croniter), with an
  idempotency key per slot.

## 9. Identity and governance

- Users have a global `role` (`admin | user`) and `memberships` [{department, roles: member |
  builder | approver | dept_admin}].
- Departments are seeded: hr, finance, operations, it, engineering.
- A workflow is visible to its owner, members of its department, and admins. Members of the
  department can run it; builders and the owner can edit it; approvers can decide its approvals.
- Run inputs and outputs of hr and finance workflows are visible only to those groups.
- Approval decisions require the approver role in the approval's department, and the approver
  must differ from the initiator when separation of duties applies.
- The existing audit log is extended to cover connections, enable/disable, designer accepts and
  approvals.

## 10. Connectors (tools)

| Tool | Connector | Side effect | Notes |
|---|---|---|---|
| `doc_extract_text` | builtin | none | txt, md, csv, pdf (pypdf) from uploaded files; parsed in the sandbox |
| `doc_check_fields` | builtin | none | deterministic: required fields/labels present in a document |
| `data_summarize_csv` | builtin | none | row counts, column stats, totals |
| `data_compare` | builtin | none | numeric thresholds / discrepancy checks |
| `report_create` | builtin | internal | Markdown report artifact |
| `notify_user` / `task_create` | builtin | internal | in-app inbox items for users/roles |
| `email_send` | smtp | communication | needs an SMTP connection; always behind an approval |
| `http_request` | http | external_write | base URL from the connection; allow-listed path prefix |
| `chat_post` | slack / teams | communication | incoming webhook URL is the secret |

LLM-backed capabilities (extract fields, draft text, classify, summarize, the code agents) use
the registry agents and need a model provider. Without one they are **requires_connection**
("AI model").

## 11. UI

- **Create workflow**: AI-Assisted (default) / Template / Advanced.
- **AI builder page**:
  - chat on the left
  - proposal on the right: business step list, a read-only React Flow preview, and a
    requirements card
  - diff view for edits, with Accept/Discard and Undo/Redo
  - Save
- **Template gallery** by department, with "Runs locally" or "Needs: Email, …" badges.
- **Editor**:
  - business mode by default (business labels; the node panel explains what the step does,
    needs, produces, which app it uses, and whether action or authorization is required)
  - an "Advanced" toggle for technical config
  - edits to plan-based workflows go through translation, and unsupported edits are explained
- **Simulate panel**: sample input, approval choices, the branch path, missing integrations,
  outputs. Clearly marked "Simulation".
- **Enable dialog**: lists sensitive actions and integrations, with acknowledgement checkboxes.
- **Connections page**: guided form per connector type, Test button, write-only secrets.
- **Users page** (admin). **Inbox** (notifications and tasks).

## 12. Templates

The 14 templates are Business Plans that use registry capabilities:

| Department | Templates |
|---|---|
| HR | onboarding, leave approval, document verification |
| Finance | invoice processing, expense verification, budget variance |
| Operations | daily report, service escalation |
| IT | access request, incident analysis |
| Engineering | requirement analysis, code generation, testing and review, plus the existing pipelines |

Each one is badged "runs locally" or with the connectors it needs.

## 13. Testing

Backend:
- compiler determinism and stable ids
- every operation, transactional rollback, and diffs
- graph↔plan round trip and unsupported-edit reporting
- policy: approval insertion, separation of duties, restricted capabilities, setup requirements
- capability resolution rejecting invented capabilities
- designer pipeline with a mock OpenAI-compatible model (proposal, repair, edit)
- simulation without side effects
- enable gating
- department access
- connector tools against local fakes (SMTP debug server, HTTP echo)
- end to end: template → simulate → enable → run → approve → complete

Frontend: unit and integration tests for the AI builder flow, the diff view and the business node
panel. Real-model verification runs on the server once a provider is configured.

## 14. Delivery phases

1. Registries, identity, connections
2. BP schema, compiler, policy, operations
3. Designer service and API
4. AI builder UI and conversational editing
5. Templates
6. Simulation, enable gating, end-to-end tests, then deploy

Each phase lands with tests passing.
