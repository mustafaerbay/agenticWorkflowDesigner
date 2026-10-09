# Platform Contracts

This document is the single source of truth for the workflow definition format,
the REST/WebSocket API, and execution semantics. Backend (`backend/app`) and
frontend (`frontend/src`) both implement exactly this.

All API routes are prefixed with `/api`. All bodies are JSON. Timestamps are
ISO-8601 UTC strings. IDs are UUID strings unless noted.

## 1. Workflow definition

Stored per immutable workflow version.

```jsonc
{
  "nodes": [
    {
      "id": "testing_agent",          // ^[a-z][a-z0-9_]{0,63}$ — also used in condition refs
      "type": "agent",                // see node types
      "position": { "x": 0, "y": 0 },
      "data": { "label": "Testing Agent", "config": { /* per type */ } }
    }
  ],
  "edges": [
    {
      "id": "e1",                     // any non-empty string, unique
      "source": "start",
      "target": "testing_agent",
      "sourceHandle": "out",          // default "out"; see handles per type
      "targetHandle": "in",           // always "in"
      "label": "optional"
    }
  ],
  "settings": {
    "max_loop_iterations": 5,         // max runs of any single node per execution
    "max_total_steps": 100,           // max node runs per execution
    "max_duration_seconds": 3600
  }
}
```

### Node types, config and handles

| type | config | source handles |
|---|---|---|
| `start` | `{ "input_schema"?: JSONSchema, "default_input"?: object }` | `out` |
| `agent` | AgentNodeConfig (below) | `out` |
| `condition` | `{ "branches": [{ "handle": "true", "label": "True", "rule": Rule }], "default_handle": "false" }` | each `branches[].handle` plus `default_handle` |
| `tool` | `{ "tool": "run_tests", "args": { "k": Operand-or-literal }, "timeout_seconds"?: int, "retry"?: Retry }` | `out` |
| `parallel` | `{}` | `out` (all outgoing edges fire) |
| `join` | `{ "mode": "all" \| "any" }` | `out` |
| `approval` | `{ "title": str, "description"?: str }` | `approved`, `rejected` |
| `delay` | `{ "seconds": number }` | `out` |
| `end` | `{}` | none |
| `fail` | `{ "message"?: str }` | none |

Every node except `start` has exactly one target handle `in`.

**AgentNodeConfig**

```jsonc
{
  "agent_id": "uuid | null",          // optional registry agent supplying defaults
  "kind": "llm" | "scripted",         // scripted = deterministic test agent, NO LLM
  "preset": "planning|developer|testing|code_review|devops|documentation|null",
  "system_prompt": "string",
  "user_prompt": "string",            // supports {{ref}} templates, e.g. {{input.requirement}}
  "model_provider_id": "uuid | null",
  "model": "string | null",
  "temperature": 0.2,
  "max_tokens": 2048,
  "tools": ["read_file", "run_tests"],// tool permissions (least privilege)
  "timeout_seconds": 300,
  "max_steps": 8,                     // max LLM <-> tool iterations
  "retry": { "max_attempts": 1, "backoff_seconds": 2 },
  "input_mapping": { "key": "ref string" },   // e.g. {"plan": "planning_agent.output.tasks"}
  "output_schema": JSONSchema | null,
  "steps": [ { "tool": "write_file", "args": { } } ]  // scripted only
}
```

Effective agent config = registry agent config overlaid with non-null node
fields. It is snapshotted into the run when execution starts.

### Rule (condition) grammar — declarative JSON, never eval

```jsonc
Rule =
  { "op": "and" | "or", "rules": [Rule, ...] }
| { "op": "not", "rule": Rule }
| { "op": "eq"|"neq"|"gt"|"lt"|"gte"|"lte"|"contains", "left": Operand, "right": Operand }
| { "op": "exists" | "is_true" | "is_false", "left": Operand }

Operand = { "ref": "testing_agent.output.tests_passed" } | { "value": <any JSON> }
```

Reference roots:

- `input.<path>` — execution input
- `<node_id>.output.<path>` — latest completed output of that node
- `<node_id>.status` — latest node run status
- `<node_id>.runs` — number of completed runs of that node in this execution
- `run.steps` — node runs so far

Paths use `.` separators; integer segments index arrays.
Type rules: `gt/lt/gte/lte` require numbers on both sides; `contains` works on
string⊃string and array∋value; `eq/neq` compare JSON values. A missing ref
evaluates to `null` (so `exists` is false and comparisons are false).

## 2. Execution semantics

- Run states: `PENDING RUNNING PAUSED WAITING_APPROVAL COMPLETED FAILED CANCELLED`
- Node run states: `PENDING QUEUED RUNNING COMPLETED FAILED SKIPPED WAITING CANCELLED`
- A node is **activated** when one of its incoming edges fires. Non-join nodes run
  once per activation (OR-merge). Each activation is a new node run with
  `iteration = previous runs of that node + 1`.
- `condition` fires exactly one source handle: the first branch whose rule is
  true, else `default_handle`. Unselected forward edges are marked dead
  (dead-path elimination along forward edges only).
- `join` mode `all` fires when every forward incoming edge has fired or is dead
  (at least one fired); mode `any` fires on the first incoming edge and ignores
  later ones in the same pass. If all incoming forward edges are dead the join
  is SKIPPED.
- Back edges (edges that close a cycle, computed by DFS from `start`) never
  count for join/skip bookkeeping.
- Bounded loops: validation requires every cycle to contain a `condition` node
  with a branch leaving the cycle. At runtime a node exceeding
  `max_loop_iterations` or the run exceeding `max_total_steps` /
  `max_duration_seconds` fails the run with a `limit_exceeded` error.
- Retries: a failed node run is retried as a new attempt (same iteration) up to
  `retry.max_attempts`; then the node is FAILED and the run FAILED.
- `end`: run is COMPLETED once an `end` node has completed and nothing is in
  flight. `fail`: run FAILED immediately; in-flight nodes are CANCELLED.
- `approval`: node WAITING, approval record created, run `WAITING_APPROVAL` when
  nothing else is in flight. Decision fires `approved` or `rejected`.
- Pause: no new nodes dispatched; in-flight nodes finish and are recorded.
- Idempotency: node run key `(run_id, node_id, iteration, attempt)` is unique;
  a worker claims a task with a conditional `QUEUED -> RUNNING` update and drops
  duplicates.

## 3. REST API

Auth: `Authorization: Bearer <jwt>` on everything except `/api/health`,
`/api/ready`, `/api/auth/login`. WebSocket uses `?token=<jwt>`.

Errors: `{ "detail": "message" }` or `{ "detail": [ ...validation ] }` with
4xx/5xx status.

### Health / auth
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/health` | | `{ "status": "ok" }` |
| GET | `/api/ready` | | `{ "status": "ready"\|"not_ready", "checks": { "database": bool, "redis": bool, "rabbitmq": bool } }` (503 if not ready) |
| POST | `/api/auth/login` | `{ "email", "password" }` | `{ "access_token", "token_type": "bearer", "user": User }` |
| GET | `/api/auth/me` | | `User` |

`User = { id, email, name, role: "admin"|"editor"|"viewer" }`

### Workflows
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/workflows?search=` | | `WorkflowSummary[]` |
| POST | `/api/workflows` | `{ name, description?, definition }` | `Workflow` (201) |
| GET | `/api/workflows/{id}` | | `Workflow` |
| PUT | `/api/workflows/{id}` | `{ name?, description?, definition? }` | `Workflow` (new version if definition changed) |
| DELETE | `/api/workflows/{id}` | | 204 |
| POST | `/api/workflows/{id}/validate` | | `ValidationResult` |
| POST | `/api/workflows/validate` | `{ definition }` | `ValidationResult` (unsaved) |
| POST | `/api/workflows/{id}/duplicate` | | `Workflow` (201) |
| GET | `/api/workflows/{id}/export` | | `{ format: "agentic-sdlc/workflow@1", name, description, definition }` |
| POST | `/api/workflows/import` | export document | `Workflow` (201) |
| GET | `/api/workflows/{id}/versions` | | `{ version, created_at, created_by }[]` |

```
WorkflowSummary = { id, name, description, version, updated_at, created_at,
                    node_count, last_run_status: string|null, is_example }
Workflow = WorkflowSummary + { definition }
ValidationResult = { valid: bool, errors: Issue[], warnings: Issue[] }
Issue = { code, message, node_id?: string, edge_id?: string }
```

### Executions
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/workflows/{id}/execute` | `{ input?: object }` | `Run` (201) — 422 with ValidationResult in `detail` if invalid |
| GET | `/api/executions?workflow_id=&status=&search=&limit=50` | | `RunSummary[]` |
| GET | `/api/executions/{id}` | | `Run` |
| POST | `/api/executions/{id}/pause` | | `Run` |
| POST | `/api/executions/{id}/resume` | | `Run` |
| POST | `/api/executions/{id}/cancel` | | `Run` |
| POST | `/api/executions/{id}/retry` | | `Run` (new run, same version + input) |
| GET | `/api/executions/{id}/events?after=0` | | `Event[]` |
| WS | `/api/executions/{id}/stream?token=&after=0` | | messages below |

```
RunSummary = { id, workflow_id, workflow_name, workflow_version, status,
               created_at, started_at, finished_at, steps, error }
Run = RunSummary + { input, output, definition, node_runs: NodeRun[], last_event_seq }
NodeRun = { id, node_id, node_type, label, iteration, attempt, status,
            input, output, error, selected_handle, started_at, finished_at,
            duration_ms, logs: {ts, level, message}[],
            tool_calls: {tool, args, result, error, duration_ms}[],
            usage: {prompt_tokens, completion_tokens, total_tokens} | null,
            agent_kind: "llm"|"scripted"|null, model: string|null }
Event = { seq, run_id, type, node_id, node_run_id, data, created_at }
```

Event types: `workflow.started workflow.paused workflow.resumed
workflow.waiting_approval workflow.completed workflow.failed workflow.cancelled
node.queued node.started node.progress node.completed node.failed node.skipped
node.waiting node.cancelled edge.traversed approval.requested approval.resolved`.

`edge.traversed.data = { edge_id }`. Node events carry
`data = { status, iteration, attempt, ... }`; `node.progress.data.message`.

WebSocket server messages:
- `{ "type": "event", "event": Event }` — replays every event with `seq > after`, then live.
- `{ "type": "ping" }` every 20s.
Clients track the highest `seq` seen and reconnect with `after=<seq>`.

### Agents, models, tools, approvals, stats
| Method | Path | Body | Response |
|---|---|---|---|
| GET/POST | `/api/agents` | `AgentIn` | `Agent[]` / `Agent` |
| GET/PUT/DELETE | `/api/agents/{id}` | `AgentIn` | `Agent` / 204 |
| GET | `/api/agents/presets` | | `{ key, name, description, config }[]` |
| GET/POST | `/api/model-providers` | `ProviderIn` | `Provider[]` / `Provider` |
| GET/PUT/DELETE | `/api/model-providers/{id}` | `ProviderIn` | `Provider` / 204 |
| POST | `/api/model-providers/{id}/test` | | `{ ok, detail, models: string[] }` |
| GET | `/api/tools` | | `{ name, description, parameters: JSONSchema, dangerous: bool }[]` |
| GET | `/api/approvals?status=pending` | | `Approval[]` |
| POST | `/api/approvals/{id}/decision` | `{ decision: "approve"\|"reject", comment? }` | `Approval` |
| GET | `/api/stats` | | `Stats` |

```
AgentIn = { name, description?, kind, preset?, config: AgentNodeConfig-without-agent_id }
Agent = AgentIn + { id, version, created_at, updated_at }
ProviderIn = { name, base_url, default_model, api_key_ref?: string /* env var NAME, never the key */,
               timeout_seconds?, temperature?, max_tokens? }
Provider = ProviderIn + { id, api_key_configured: bool, created_at }
Approval = { id, run_id, node_id, workflow_name, title, description, status:
             "pending"|"approved"|"rejected", requested_at, decided_at, decided_by, comment }
Stats = { workflows, runs_total, runs_by_status: {STATUS: n}, active_runs,
          pending_approvals, recent_runs: RunSummary[] }
```
