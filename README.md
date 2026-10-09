# Agentic SDLC Platform

A visual workflow designer and durable execution engine for AI software-development
pipelines. You build workflows on a React Flow canvas, and Python agents execute them.
Agents can be LLM-driven (any OpenAI-compatible endpoint) or deterministic scripted
test agents. They run in an isolated sandbox, with conditional branches, bounded loops,
parallel joins, human approvals and live execution visualization.

- Specification: [ARCHITECTURE.md](ARCHITECTURE.md) (application) and [DEPLOYMENT.md](DEPLOYMENT.md) (deployment and acceptance)
- API and workflow contract: [docs/contracts.md](docs/contracts.md)
- Interactive API docs (when running): `/api/docs`

## Architecture

```text
browser ──HTTP/WS──▶ web (nginx: SPA + /api proxy) ──▶ api (FastAPI)
                                                        │  REST, auth, validation, WebSocket
                                                        ▼
                     PostgreSQL ◀── orchestrator ◀── RabbitMQ ──▶ worker (agents) ──HTTP──▶ sandbox
                     (all state)    (durable engine)  (commands,     LLM / scripted        (files, git,
                         ▲                             tasks)        agents, tools          pytest; no
                         └──── Redis pub/sub (live events) ◀────────────────┘               secrets, no
                                                                                            Internet)
```

| Service | Role |
|---|---|
| `web` | nginx serving the React build. It proxies `/api` and WebSocket upgrades to `api` and is the only published port. |
| `api` | FastAPI handles JWT auth, per-workflow access control, CRUD and versioning, validation, execution control, approvals, and the event replay and stream. |
| `orchestrator` | Durable engine that consumes `orchestrator.commands`. It schedules nodes, evaluates conditions, handles joins, retries, loop limits, timers and crash recovery. |
| `worker` | Agent runtime that consumes `agent.tasks`. It claims tasks idempotently, runs LLM and scripted agents and tool nodes, records logs, tool calls and token usage, and heartbeats. |
| `sandbox` | The only process that touches workspaces. It runs allow-listed argv commands (no shell) with rlimits, has a read-only root FS, holds no secrets, and sits on an internal-only network. |
| `postgres`, `redis`, `rabbitmq`, `migrate` | State, live event fan-out, task dispatch, and Alembic migrations. |

Key properties:
- **PostgreSQL is the source of truth.** Every state change locks the run row, so per-run event sequence numbers follow commit order. WebSocket clients replay from any `seq`.
- **Idempotent task handling.** Each node run is unique on `(run, node, iteration, attempt)`. Workers claim a task with a conditional `QUEUED → RUNNING` update, and duplicate deliveries or results are dropped.
- **Bounded execution.** The validator rejects cycles that have no exiting Condition. At runtime the engine enforces `max_loop_iterations`, `max_total_steps`, `max_duration_seconds`, per-node timeouts and retry budgets.
- **Security.** The engine, not the LLM, enforces tool permissions. Conditions are declarative JSON and never go through `eval`. API keys are referenced by env-var name and never stored or returned. Tool output is treated as untrusted.

## Quick start (local)

```bash
cp .env.example .env && chmod 600 .env
# Replace every change-me value, for example with: openssl rand -hex 24
./scripts/deploy-dev.sh
```

Open `http://127.0.0.1:3000` and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Two example
workflows are seeded:

- **Autonomous Development Pipeline**: LLM agents (planning → developer → real pytest → fix
  loop → code review → human approval → patch + report). This needs a model provider: set
  `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY` in `.env`, or add one under *Model Settings*.
- **Autonomous Development Pipeline (deterministic demo, no LLM)**: the same graph with
  scripted agents. The test run fails for real, the scripted fixer applies a patch, the tests
  pass, the review condition checks the diff and coverage, you approve, and patch and report
  artifacts are produced.
- **Fetch repository (scripted, no LLM)**: the *Repository Fetch Agent* preset clones
  `input.repo_url` (optional branch or tag `input.repo_ref`) into the workspace path
  `input.work_path`. Drop the preset from the editor palette into any workflow to do the same.

The `git_clone` tool behind the Repository Fetch Agent runs in the worker, because the sandbox has
no Internet access. It accepts only public HTTPS URLs from `GIT_CLONE_ALLOWED_HOSTS` and rejects
credentials. Clones are shallow, with no hooks, submodules or LFS, and are limited in size and file
count. The files are extracted into the sandbox with a path-safe filter and committed as the
workspace baseline, so later `git_diff` and patches show only the agents' changes. Private
repositories are not supported yet.

## Verify

```bash
./scripts/verify-dev.sh       # health, readiness, isolation, exposure, backend + frontend tests
./scripts/smoke-workflow.sh   # end-to-end through nginx: branches, loops, WS, DB, approval
```

Backend tests run against an isolated `<db>_test` database migrated with Alembic:

```bash
docker compose -p agentic-sdlc-dev run --rm --no-deps api pytest -q
```

## Repository layout

```text
backend/            FastAPI app, engine, agents, tools, sandbox, workers, Alembic, tests
  app/orchestration   graph analysis, validator, condition evaluator, engine, events, bus
  app/agents          BaseAgent, LLM tool-calling runtime, scripted agent, presets
  app/tools           tool registry (permission-checked, schema-validated) + sandbox client
  app/sandbox         isolated execution service
  app/workers         orchestrator and agent worker processes, message contracts
  workspace_templates sample repository used by the demo pipeline
  scripts/            in-image smoke test
frontend/           React + Vite + React Flow + Tailwind + shadcn-style UI, Vitest tests
scripts/            deploy-dev.sh, verify-dev.sh, smoke-workflow.sh
docs/               contracts and deployment report
```

## Operations

```bash
docker compose -p agentic-sdlc-dev ps
docker compose -p agentic-sdlc-dev logs -f --tail=100 api orchestrator worker
docker compose -p agentic-sdlc-dev restart orchestrator worker   # in-flight work is recovered
docker compose -p agentic-sdlc-dev down                          # keeps volumes; never use -v casually
# Database backup:
docker compose -p agentic-sdlc-dev exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > backup.dump
# Restore into an empty database:
docker compose -p agentic-sdlc-dev exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < backup.dump
```

Scale workers horizontally with `WORKER_REPLICAS=3`. Orchestrators are safe to replicate too,
because commands are serialized by row locks and the sweeper by a Redis lock.

## Known limitations

- **No TLS or reverse proxy yet.** Put the web port behind HTTPS and an IP allow-list before handling real code or credentials.
- **Shared sandbox container.** All runs use one sandbox container, so code executed by a test can read other runs' workspaces. Production should use per-run ephemeral sandboxes (for example gVisor or Firecracker).
- **No VCS or CI integration.** GitHub, GitLab and Jenkins adapters are not implemented. Delivery produces a local patch and report, and nothing is pushed or deployed.
- **No A2A or MCP.** Agents communicate through versioned RabbitMQ task and result messages. Neither is integrated yet.
- **LangGraph is not used.** The engine is a purpose-built, PostgreSQL-backed state machine, because durability, idempotency and replay were requirements that LangGraph's in-process graph would have duplicated.
- **Joins inside loops** count forward edges only.
