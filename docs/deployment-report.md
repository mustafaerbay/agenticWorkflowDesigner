# Deployment Report — Development Environment

| | |
|---|---|
| Deployment time | 2026-10-09, about 16:35–16:42 UTC (server clock is UTC) |
| Target host | `178.105.26.247` (Ubuntu 24.04-family kernel 6.8, 2 vCPU, 3.7 GiB RAM, no swap) |
| Installation path | `/opt/agentic-sdlc` (fresh `git clone`, remote `https://github.com/mustafaerbay/agenticWorkflowDesigner.git`) |
| Deployed commit | `686d602fdf5d3577ac1ad02d33c78d66ef904365` (`main`) |
| Compose project | `agentic-sdlc-dev` |
| Public URL | **http://178.105.26.247:3000** (verified from an external workstation) |
| Shared host | The existing `soyagaci-*` containers (Caddy on 80/443) were not touched |

## Services and published ports

| Service | Image | Network(s) | Published |
|---|---|---|---|
| web | `agentic-sdlc/web:dev` (nginx-unprivileged) | edge | **0.0.0.0:3000 → 8080** |
| api | `agentic-sdlc/backend:dev` | backend, edge | — |
| orchestrator | `agentic-sdlc/backend:dev` | backend | — |
| worker | `agentic-sdlc/backend:dev` | backend, sandbox | — |
| sandbox | `agentic-sdlc/backend:dev` | sandbox (internal: no Internet) | — |
| postgres | `postgres:17.6-alpine` | backend | — |
| redis | `redis:7.4.6-alpine` | backend | — |
| rabbitmq | `rabbitmq:4.1.4-alpine` (no management UI) | backend | — |
| migrate | `agentic-sdlc/backend:dev` (one-shot) | backend | — |

The whole stack used about 0.5 GiB of memory after the tests. The host had 2.6 GiB available.

## Commands executed

```bash
git clone https://github.com/mustafaerbay/agenticWorkflowDesigner.git /opt/agentic-sdlc
cp -n .env.example .env && chmod 600 .env    # secrets generated on the host with openssl rand; never printed
./scripts/deploy-dev.sh                      # exit 0
./scripts/verify-dev.sh                      # exit 0, 0 failures
./scripts/smoke-workflow.sh                  # exit 0, 21/21
# restart/recovery check (in-flight run across `docker compose restart api orchestrator worker sandbox web`)
```

## Acceptance criteria (DEPLOYMENT.md §13)

| Check | Result | Evidence |
|---|---|---|
| Repository checked out under `/opt/agentic-sdlc` | PASS | `pwd`=/opt/agentic-sdlc, remote above, SHA `686d602` |
| Docker Compose config valid | PASS | `docker compose -p agentic-sdlc-dev config --quiet` (inside deploy-dev.sh, exit 0) |
| All required images build | PASS | `docker compose build` in deploy-dev.sh, exit 0 |
| Database migrations complete | PASS | `migrate` exited 0; `alembic_version` = `0001` |
| Required services healthy | PASS | All 8 services `healthy`. `/api/ready` returned `{"database":true,"redis":true,"rabbitmq":true}` |
| Backend tests pass | PASS | `docker compose run --rm --no-deps api pytest -q`: **54 passed**, exit 0 |
| Frontend tests pass | PASS | `npm ci && npm test` in `node:24.10.0-alpine`: **7 files, 38 tests passed** |
| Workflow create/save/validate | PASS | Smoke: created through the API, `validate` returned `valid: true`, and the reopened definition was identical |
| Agent task execution | PASS | Scripted agent ran real pytest in the sandbox: `tests_passed` [False, True]. 9 node runs recorded. Agents are labelled `agent_kind=scripted` (no LLM) |
| Condition and loop routing | PASS | Branches `fix` then `pass`. The failing path ended with a controlled `FAILED` (`give_up`). A runaway loop stopped at `max_loop_iterations=3` (`limit_exceeded`) |
| Live React Flow visualization | PASS (local), PARTIAL (public URL) | In the browser against the local stack on the same commit, the canvas and timeline updated live over WebSocket (59 → 79 events), approval from the UI completed the run, and the console had no errors. On the public URL only the page load and assets were checked (200, no console errors); signing in there was left to the operator |
| Persistence across restart | PASS | A run started before restarting api/orchestrator/worker/sandbox/web was `COMPLETED` afterwards. Workflow and run counts were unchanged (3/7 before and after) |
| External URL reachable | PASS | From the workstation: `GET /` 200, `/api/ready` ready, `/api/workflows` without a token returned 401 |
| Security exposure reviewed | PASS with caveats | Only `web` publishes a port. From outside, 5432/6379/5672/15672/8000/8100 are closed. The sandbox cannot reach Postgres or the Internet. API and WebSocket require JWT. Caveats are below |

### Smoke test checks (all PASS on the server)

`web→api proxy and readiness` · `web serves SPA` · `API rejects unauthenticated requests` · `login` ·
`workflow saved and valid` · `workflow reopens with same definition` · `success path reaches COMPLETED` ·
`agent really ran pytest (fail → fix → pass)` · `condition chose branches from recorded output` ·
`agent runs labelled scripted (no LLM)` · `WebSocket delivered ordered events matching persisted log (36/36)` ·
`edge traversal events streamed` · `WebSocket replay from seq 0 after reconnect` ·
`run, node runs and events persisted in PostgreSQL` · `failing branch reaches controlled FAILED` ·
`runaway loop stopped at max_loop_iterations=3` · `pause then resume completes` · `cancel stops a running workflow` ·
`bundled deterministic SDLC example present` · `pipeline pauses for human approval` ·
`pipeline completes after approval with patch + report`

## Not verified / blocked

| Item | Status | Reason |
|---|---|---|
| LLM-driven agent execution | BLOCKED | No model endpoint is configured, by operator decision. The "Autonomous Development Pipeline" (LLM) workflow will fail at the first agent with "No model provider configured". The LLM runtime is covered only by unit tests against a mock OpenAI-compatible model. |
| Signed-in UI on the public URL | NOT RUN | It was left to the operator so that the admin password is not entered by automation on a non-local host. The same build was fully exercised locally. |
| Host reboot / Docker daemon restart | NOT RUN | Only a service restart was tested. Restart policies are `unless-stopped`, so containers should come back after a reboot, but this was not tested. |
| GitHub/GitLab/Jenkins, A2A, MCP | NOT IMPLEMENTED | Delivery produces a local patch and report. Nothing is pushed or deployed. |

## Security notes and next steps

1. **No TLS.** The login password and JWT travel over plain HTTP on port 3000. The existing Caddy on 80/443 could terminate TLS for a subdomain, or the port could be restricted with a cloud firewall or IP allow-list.
2. **The host firewall (ufw) is inactive**, so port 3000 is reachable from the whole Internet. The application requires login, but the login endpoint has no rate limiting yet.
3. **Shared sandbox.** All runs share one sandbox container, so code executed by a test can read other runs' workspaces. It has no secrets, no Internet, a read-only root filesystem, dropped capabilities, and a process/memory/CPU limit.
4. **The admin password** is the `ADMIN_PASSWORD` value in `/opt/agentic-sdlc/.env` on the server (mode 600). Rotate it after first login by setting up proper users.

## Operations

```bash
cd /opt/agentic-sdlc
docker compose -p agentic-sdlc-dev ps
docker compose -p agentic-sdlc-dev logs --tail=200 api orchestrator worker
DEPLOY_UPDATE=1 ./scripts/deploy-dev.sh      # fast-forward, rebuild, migrate, restart (refuses if tracked files changed)
docker compose -p agentic-sdlc-dev exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > /root/agentic-$(date +%F).dump
docker compose -p agentic-sdlc-dev down       # stop; keeps volumes. Never use `down -v` without an approved reset.
```

Rollback: the previous working commit can be checked out and redeployed (`git checkout <sha> && ./scripts/deploy-dev.sh`).
The schema has a single migration (`0001`), so this is only safe while no later migration has been applied. Automatic rollback is not implemented or tested.
