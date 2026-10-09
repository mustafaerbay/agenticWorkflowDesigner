# Development Deployment and Verification Guide

**Project:** Agentic AI SDLC Platform  
**Target host:** `178.105.26.247`  
**Deployment environment:** Development / test / production  
**Deployment root:** `/opt/agentic-sdlc`  
**Deployment method:** Docker Compose **only** (no Kubernetes, Helm, Swarm, or cloud deployment)  
**Primary architecture reference:** `ARCHITECTURE.md`

> **Instructions to Claude Code:** Treat this document as the deployment and test acceptance contract for the current development environment. Read `ARCHITECTURE.md`, inspect the actual repository, then perform the work on the development server **only if SSH credentials and access are already available**. Do not claim remote actions succeeded unless commands actually ran and their outputs were checked. Never invent repository URLs, credentials, test results, or application endpoints. If access is unavailable, prepare the scripts and exact commands, describe the blocker, and leave execution unverified.

## 1. Objective and scope

Build, deploy, and validate the working platform on `178.105.26.247` from a Git checkout located under `/opt/agentic-sdlc`. Use **Docker Compose** to run all services required for the development stack: frontend, backend API, Python agent worker(s), orchestration/queue consumer, PostgreSQL, Redis, RabbitMQ, and any other services demonstrably required by the implementation. A separate LLM inference container is optional; support an externally configured OpenAI-compatible model endpoint.

Goals:

1. Obtain/update project code in `/opt/agentic-sdlc`.
2. Provide reproducible Dockerfiles, Compose configuration, and `.env.example`.
3. Build and start the entire development stack using `docker compose`.
4. Run database migrations, health checks, backend/unit/integration tests, and a real workflow smoke test.
5. Verify that the web UI can reach the API and receive workflow execution events.
6. Document commands, evidence, known limitations, and cleanup/redeploy procedures.

**Out of scope:** production hardening certification, Kubernetes manifests, production rollouts, CI/CD-based remote deployments, and invented external Git/LLM integrations.

## 2. Configuration parameters

| Parameter | Value / rule |
|---|---|
| Host | `178.105.26.247` |
| SSH user | Supply via access configuration; do not assume `root` |
| Git remote | Discover from current repository (`git remote -v`) or receive a real repository URL; never invent it |
| Git branch/ref | Current checked-out branch by default; allow explicit `DEPLOY_REF` |
| Installation path | `/opt/agentic-sdlc` |
| Compose project name | `agentic-sdlc-dev` |
| Application URL | `http://178.105.26.247:<configured-web-port>` until HTTPS is set up |
| External exposure | Frontend only, with approved firewall access; keep DB/broker/cache internal |
| Secret storage | Server-side `.env` with restrictive permissions, not Git |

Port `3000` is a **proposed** frontend development port, not a verified exposed port. Read and configure the actual project before finalizing a URL. Prefer a reverse proxy with HTTPS and authentication if the host is Internet-accessible; otherwise restrict the frontend port to trusted source IPs or a VPN. **Do not expose agent tools or shell-execution endpoints to the public Internet.**

## 3. Preconditions and remote access

Claude must check server access, disk capacity, and container runtime availability before changing anything. Do not change unrelated services on a shared host.

From an authorized workstation:

```bash
ssh <ssh-user>@178.105.26.247
```

On the host:

```bash
whoami
id
uname -a
cat /etc/os-release
df -h /opt /var/lib/docker 2>/dev/null || df -h
free -h
docker --version
docker compose version
git --version
```

Prerequisites: authorized SSH, Git, supported Docker Engine + Compose plugin, adequate disk/RAM for the chosen services, ability to fetch the repository, and access to any selected LLM endpoint. Installation of system packages or opening firewall ports needs administrator authorization. Never bypass access controls or disable security safeguards.

## 4. Directory structure

Use `/opt` **as the parent folder**, with a dedicated application directory:

```text
/opt/agentic-sdlc/
├── ARCHITECTURE.md
├── DEPLOYMENT.md
├── frontend/
├── backend/
├── infrastructure/
├── docker-compose.yml
├── docker-compose.dev.yml       # optional, if appropriate
├── .env.example                 # committed; no real secrets
├── .env                         # NOT committed
├── scripts/
│   ├── deploy-dev.sh
│   ├── verify-dev.sh
│   └── smoke-workflow.sh
└── ...
```

Do **not** place the working tree directly in `/opt` or modify unrelated `/opt` directories. Use a dedicated service account with appropriate ownership; use `sudo` only for narrowly required filesystem/system changes.

## 5. Fetch or update repository

If the project is already checked out under `/opt/agentic-sdlc`, inspect its remote and working tree first. Preserve local changes; do **not** blindly run `git reset --hard`, `git clean -fd`, or overwrite `.env`.

**Fresh checkout** (replace the placeholder with the actual remote):

```bash
sudo mkdir -p /opt/agentic-sdlc
sudo chown "$(id -u):$(id -g)" /opt/agentic-sdlc
# Use a real, authorized repository URL:
git clone <ACTUAL_GIT_REPOSITORY_URL> /opt/agentic-sdlc
cd /opt/agentic-sdlc
```

**Existing checkout**:

```bash
cd /opt/agentic-sdlc
git status --short
git remote -v
git branch --show-current
git fetch --prune
# Confirm target branch/ref and any uncommitted changes before updating.
git pull --ff-only
```

Record the deployed commit SHA with `git rev-parse HEAD`. If the repository is already local in a different directory, get explicit confirmation before copying/moving or replacing it.

## 6. Docker Compose requirements

Claude must inspect the actual source and implement a valid Compose setup (rather than assuming service paths or startup commands). Preferred services are:

- **frontend:** React/Vite build served by a web server or application container.
- **api:** Python/FastAPI application with documented `/health` and `/ready` endpoints (or equivalent routes that are verified).
- **worker:** Python agent execution consumer(s), with the same versioned application code as the API.
- **postgres:** persistent named volume; database internal to the Compose network.
- **redis:** internal only.
- **rabbitmq:** internal only; management UI not publicly exposed.
- **optional:** orchestration worker, model gateway, observability, migration job — only if needed by implemented code.

Compose requirements:

1. Use one named Compose project (`agentic-sdlc-dev`) and service DNS names for inter-container communication.
2. Keep PostgreSQL, Redis, RabbitMQ, and internal admin interfaces off publicly published ports; use `expose`/internal networking instead.
3. Publish only the intended web entry point, on a consciously approved interface and port; proxy `/api` and WebSocket traffic as required.
4. Include persistent named volumes, meaningful restart policies, and health checks where supported.
5. Use `depends_on` health conditions where appropriate, but also implement application-level connection retries.
6. Do not bake `.env`, API keys, SSH keys, or repository credentials into images.
7. Run worker containers as non-root and isolate file/shell tools to approved workspaces. Do not mount the host Docker socket into agent containers.
8. Never give an AI agent unrestricted access to `/opt`, `/`, host networking, or privileged containers.
9. Use pinned, maintainable base images and multi-stage builds where beneficial.
10. Provide `.dockerignore` files and `.env.example` with safe placeholders.

Before deployment:

```bash
cd /opt/agentic-sdlc
cp -n .env.example .env
chmod 600 .env
# Edit .env with actual development credentials and endpoints.
docker compose -p agentic-sdlc-dev config --quiet
```

The `.env` values must reflect actual application settings, not fabricated names. Ensure `git check-ignore .env` succeeds (or equivalent ignore rule is in place). Review `docker compose config` output carefully because it can expose substituted secrets; do not paste secret-bearing output into reports.

## 7. Build, migrate, start

Adapt to the repository's actual service names and migration implementation. Commands below express the required operations:

```bash
cd /opt/agentic-sdlc

docker compose -p agentic-sdlc-dev build

# If using Alembic, run migrations in the application image before exposing traffic:
docker compose -p agentic-sdlc-dev run --rm api alembic upgrade head

docker compose -p agentic-sdlc-dev up -d

docker compose -p agentic-sdlc-dev ps
```

If Alembic is not installed or migrations are invoked differently, identify and document the correct command. Do not report a migration as complete without exit status and schema verification. If build/migration fails, fix the underlying issue and retry with captured diagnostic output; do not silently skip the stage.

## 8. Verification gates

**Gate A — Service health**

```bash
cd /opt/agentic-sdlc
docker compose -p agentic-sdlc-dev ps
docker compose -p agentic-sdlc-dev logs --tail=150 api frontend worker
```

Check each enabled service's real health/readiness endpoint, and verify that critical dependencies (database, broker, Redis) are reachable over the internal Compose network. A running container alone does **not** prove application readiness. Note that the example service names may need updating after inspecting Compose.

**Gate B — Automated tests**

Run and report the actual test commands based on the repository, such as:

```bash
# Examples; adapt working directories and commands to actual project
docker compose -p agentic-sdlc-dev run --rm api pytest -q
docker compose -p agentic-sdlc-dev run --rm frontend npm test -- --run
```

If frontend tests require a different runner (e.g., Vitest) or aren't implemented, create a minimal useful test suite and clearly report coverage. Include graph validation, conditional routing, loop bounds, idempotency, and backend API integration tests when implemented.

**Gate C — End-to-end workflow smoke test**

Using real API contracts (not made-up endpoints):

1. Create or load a sample workflow containing Start → Python Agent → Condition → success/failure branch → End.
2. Validate and persist the workflow.
3. Start an execution using an authenticated API request or the web UI.
4. Verify the agent really executed using a configured LLM or deterministic **explicitly labeled** test agent; never misrepresent a stub as LLM-driven execution.
5. Verify the condition chooses the correct branch using recorded agent output.
6. Verify workflow status reaches `COMPLETED` or the expected controlled failure state.
7. Verify persisted run/node/event records in PostgreSQL.
8. Verify WebSocket or event-stream updates accurately appear on the React Flow canvas.
9. Repeat with a failing branch and a bounded retry/loop case.
10. Test cancel, retry, and human approval if implemented; report unsupported features as limitations.

**Gate D — Browser accessibility**

Confirm the UI is accessible through the approved network route at:

```text
http://178.105.26.247:<configured-web-port>
```

Validate page load, browser console/network errors, workflow saving, status visualization, and API/WebSocket routing. If remote browser checks are unavailable, distinguish server-side HTTP validation from actual browser/UI validation; do not claim the latter passed.

**Gate E — Restart/recovery**

Restart services (`docker compose ... restart`), verify persisted workflows and execution history survive, and test in-flight recovery if the engine supports it. Restarting a service is not the same as testing host reboot or durable background task replay: report each separately.

## 9. Deployment scripts

Claude must create executable, idempotent scripts under `scripts/`:

- `deploy-dev.sh`: preflight checks; validate Compose/env; fetch/update **only when explicitly configured**; build; migrate; start; health check; report deployed SHA and running services.
- `verify-dev.sh`: run non-destructive health/readiness checks, backend/frontend automated tests and API checks; return nonzero on failure.
- `smoke-workflow.sh`: create and execute a sample workflow through actual API endpoints; verify state, branch correctness and streamed events where possible; leave clear diagnostics and clean up test resources if safe.

Scripts must use `set -Eeuo pipefail`, meaningful exit codes, configurable environment values, timeouts, and minimal secret exposure. Avoid `docker system prune`, blanket volume deletion, and destructive Git operations.

## 10. Logs, troubleshooting and operations

Useful baseline commands:

```bash
cd /opt/agentic-sdlc

docker compose -p agentic-sdlc-dev ps
docker compose -p agentic-sdlc-dev logs -f --tail=100
docker compose -p agentic-sdlc-dev logs --tail=200 api
docker compose -p agentic-sdlc-dev restart api worker
# Stop without deleting named volumes:
docker compose -p agentic-sdlc-dev down
```

Do **not** use `docker compose down -v` except during a specifically approved destructive reset. Preserve PostgreSQL and other persistent volumes across redeployments. Avoid displaying environment secrets in logs or support reports.

Troubleshooting checklist:

- Image build: dependency pins, package registries, Docker build logs, available disk.
- API not ready: migrations, service DNS, database credentials, startup traces.
- Agent stalled: RabbitMQ connections, delivery acknowledgements, tool timeout, LLM reachability and model credentials.
- UI blank: frontend build, correct API base path, browser console errors.
- WebSockets failing: reverse proxy upgrade support, authentication, URL scheme, origin policy.
- Workflow wrong branch: condition expression, input/output schemas, node/edge mapping, saved workflow version.
- Duplicate task: ack/retry policy, idempotency keys, persisted attempt identifiers.

## 11. Re-deployment and rollback

On each redeployment:

1. Save the currently deployed Git SHA and inspect working tree state.
2. Back up application database before schema changes or potentially destructive migrations.
3. Fetch and fast-forward or check out an approved immutable ref; never discard local changes automatically.
4. Build images and validate migrations.
5. Start Compose services and run verification gates.
6. If the release fails, revert to the previous verified code/image version **only when database compatibility is understood**; do not blindly downgrade database schemas.

Describe the actual backup/restore command after identifying database container name, user, database name and named volumes. Never claim rollback is fully automatic unless tested.

## 12. Security baseline for a public development IP

`178.105.26.247` is a public-looking IP address. Before exposing the application, confirm ownership/authorization, firewall policy, and whether a domain/TLS termination point exists.

- Prefer VPN or source-IP firewall restrictions; require authentication on the UI and API.
- Use HTTPS before carrying real credentials or sensitive code over the Internet.
- Do not publish PostgreSQL (`5432`), Redis (`6379`), RabbitMQ (`5672`, `15672`), internal worker APIs, or unrestricted agent tool endpoints.
- Keep secrets server-side; apply least privilege to Git/CI tokens.
- Apply strict CORS/origin controls and WebSocket authorization.
- Isolate agent shell/code execution in non-privileged, resource-limited sandboxes without host mounts or Docker socket access.
- Never commit `.env` or credentials to the repository.

## 13. Acceptance criteria and deployment report

The deployment is accepted only if the following are demonstrated (mark `PASS`, `FAIL`, `BLOCKED`, or `NOT IMPLEMENTED` individually):

| Check | Evidence required |
|---|---|
| Repository checked out under `/opt/agentic-sdlc` | `pwd`, Git remote (redacted if sensitive), SHA |
| Docker Compose config valid | Successful config validation |
| All required images build | Build exit codes |
| Database migrations complete | Migration exit code/version |
| Required services healthy | Compose status + readiness requests |
| Backend tests pass | Test command, counts, exit code |
| Frontend tests pass | Test command, counts, exit code |
| Workflow create/save/validate | Real API response or verified UI action |
| Agent task execution | Node execution records and result |
| Condition and loop routing | Observed success/failure paths, bounded retry |
| Live React Flow visualization | Browser inspection or clearly marked as unverified |
| Persistence across restart | Same workflow and run records after restart |
| External URL reachable | Authorized network request to actual web port |
| Security exposure reviewed | Published ports/firewall/auth review |

Claude's final report must include:

- Deployment timestamp (timezone included), target IP, installation path, deployed Git commit.
- Actual Compose service names and published ports.
- Public-facing URL **only if verified**.
- Commands executed and a concise result for each verification gate.
- Test pass/fail counts; relevant non-secret error excerpts.
- Files changed, scripts created, and configuration requirements.
- Known issues, unavailable credentials/resources, and clear next steps.

## 14. Claude execution directive

**Read `ARCHITECTURE.md` and this document first.** Inspect the actual codebase, resolve filenames/service names/API paths from reality, then implement and execute the Docker Compose deployment plan on the authorized development host. Keep all code and builds under `/opt/agentic-sdlc`. Do not switch to Kubernetes or another orchestration framework. Favor a reproducible, working development deployment over speculative production complexity. Run tests and capture evidence. If SSH, repository access, secret configuration or model connectivity is missing, finish everything possible locally and mark the affected remote checks as `BLOCKED` rather than fabricating success.
