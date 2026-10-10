# Build an Agentic AI SDLC Platform with Python Agents and React Flow

## Your Role

Act as a **Principal Solution Architect, Senior Full-Stack Engineer, AI Systems Engineer, and DevOps Architect**.

Your mission is to design and implement a production-oriented, extensible, containerized **Agentic AI Software Development Lifecycle (SDLC) Platform**.

The platform must allow users to create AI-driven software development workflows through a visual drag-and-drop interface using React Flow.

The platform must not be a static workflow visualization. It must be a functional workflow orchestration system that executes real Python AI agents, evaluates conditional branches, coordinates tasks, maintains state, and visualizes execution in real time.

Do not stop after architecture design or create only mock UI screens. Implement a working MVP with actual backend-to-frontend integration.

## 1. Primary Objectives

Build a system where users can:

1. Create, edit, duplicate, save, import, export, and delete workflows.
2. Visually connect AI agents using drag-and-drop nodes.
3. Configure individual agents through a web interface.
4. Define conditions controlling which branches execute.
5. Execute workflows manually or through API triggers.
6. Observe workflow execution and agent progress in real time.
7. Inspect agent prompts, outputs, logs, errors, and execution history.
8. Pause, resume, cancel, and retry workflows.
9. Configure LLM models, API endpoints, and agent-specific settings.
10. Add custom Python agents and tools without modifying the core execution engine.

The primary use case is autonomous software development, but the workflow engine must remain generic enough for other types of automation.

## 2. Technology Stack

Use the following technologies.

### Frontend

- React with TypeScript
- Vite
- React Flow (`@xyflow/react`)
- Tailwind CSS
- shadcn/ui
- Zustand for client-side state
- TanStack Query for server state
- WebSocket for live workflow updates

React Flow documentation: https://reactflow.dev/

Create a clean, modern interface inspired by professional visual automation platforms.

### Backend

- Python 3.12+
- FastAPI
- Pydantic
- SQLAlchemy
- Alembic
- LangGraph for Python agent execution where appropriate
- PostgreSQL for persistent state
- Redis for caching and coordination
- RabbitMQ for asynchronous task dispatch
- WebSocket streaming
- OpenAI-compatible LLM API client

Do not assume OpenAI cloud services are required. Support self-hosted models.

### Infrastructure

- Docker
- Docker Compose for local development
- Kubernetes-compatible deployment architecture
- Structured JSON logging
- OpenTelemetry-compatible tracing
- Environment-based configuration

## 3. High-Level Architecture

Separate the platform into these logical components:

**Frontend Application**
- Workflow editor
- Agent configuration
- Workflow execution visualization
- Monitoring dashboard
- Execution history
- Model and tool management

**Backend API**
- Authentication and authorization
- Workflow CRUD
- Workflow versioning
- Graph validation
- Agent registry
- Execution management
- Event streaming
- Tool configuration

**Workflow Orchestrator**
- Loads validated workflow definitions
- Determines executable nodes
- Evaluates conditions
- Handles dependencies
- Dispatches agent tasks
- Processes agent results
- Controls retries and loop limits
- Manages workflow state and recovery

**Python Agent Workers**
- Receive tasks
- Load agent configuration
- Invoke configured LLMs
- Execute approved tools
- Return structured output
- Report intermediate progress

**Infrastructure Services**
- PostgreSQL
- Redis
- RabbitMQ
- Shared model gateway
- Optional MCP tool services

The orchestrator must not depend on the frontend to execute workflows.

The frontend represents workflow definitions and runtime states but is not the execution engine.

## 4. Visual Workflow Builder

This is the most important user-facing feature.

Use React Flow to create an interactive workflow designer.

### Page Layout

Create a three-panel interface.

**Left sidebar — Node palette**

Display available node types, grouped by category.

- Triggers
- AI Agents
- Conditions
- Control Flow
- Tools
- Human Interaction
- Outputs

Users can drag nodes from this sidebar onto the canvas.

**Center — Workflow canvas**

Support:

- Drag-and-drop nodes
- Connect and disconnect edges
- Zoom and pan
- Mini-map
- Background grid
- Multi-node selection
- Copy and paste
- Delete
- Undo and redo
- Auto-layout
- Fit-to-view
- Edge labels
- Node grouping where practical

**Right sidebar — Node configuration**

Selecting a node opens its configuration panel.

The form must change based on the node type.

For AI agents, provide:

- Agent name
- Description
- System prompt
- Model provider
- Model selection
- Temperature
- Maximum tokens
- Tool permissions
- Timeout
- Retry policy
- Input mapping
- Output schema

For condition nodes, provide a visual condition builder.

For control-flow nodes, expose their execution settings.

### Node Types

Implement the following types.

| Node | Purpose |
|---|---|
| Start | Entry point |
| AI Agent | Run an LLM-powered Python agent |
| Condition | Evaluate structured rules |
| Tool | Invoke an approved external tool |
| Parallel | Start independent branches |
| Join | Synchronize branches |
| Human Approval | Pause until an authorized user decides |
| Delay | Resume after a configured period |
| End | Mark successful termination |
| Fail | Mark workflow failure |

Include specialized presets for:

- Planning Agent
- Developer Agent
- Testing Agent
- Code Review Agent
- DevOps Agent
- Documentation Agent

These presets must use the same generic Python agent runtime, with different prompts, tools, and configurations.

## 5. Conditional Workflow Execution

Users must be able to create conditions visually without coding.

Examples:

- Tests passed?
- Code coverage greater than 80%?
- Review score greater than or equal to 7?
- Retry count below 3?
- Deployment approved?
- Agent output indicates success?

The condition editor must support:

- AND
- OR
- NOT
- Equal
- Not equal
- Greater than
- Less than
- Greater than or equal
- Less than or equal
- Contains
- Exists
- Boolean true/false

Conditions must operate on typed values from previous node outputs.

Example:

`testing_agent.output.tests_passed == true`

A condition node can expose multiple named output handles.

Example:

- True → Code Review Agent
- False → Fix Code Agent

Use safe, declarative JSON-based rules or a restricted expression evaluator. Never execute user-supplied Python using `eval()`.

Backend validation must verify referenced values, supported operators, branch destinations and type compatibility.

## 6. Workflow Execution Engine

Implement a durable workflow execution engine.

A workflow definition consists of nodes, edges, configuration and a version.

When a user starts a workflow:

1. Validate the complete workflow definition.
2. Create a workflow execution record.
3. Snapshot the workflow version and effective agent configuration.
4. Resolve the start node.
5. Schedule ready nodes based on dependencies.
6. Dispatch AI agent tasks to workers.
7. Record outputs and status transitions.
8. Evaluate conditional branches.
9. Schedule the next eligible nodes.
10. Finish when all required terminal conditions are satisfied.

Support these states:

**Workflow states**
- PENDING
- RUNNING
- PAUSED
- WAITING_APPROVAL
- COMPLETED
- FAILED
- CANCELLED

**Node states**
- PENDING
- QUEUED
- RUNNING
- COMPLETED
- FAILED
- SKIPPED
- WAITING
- CANCELLED

Persist execution state so workflows can recover from backend restarts.

For each node execution, record:

- Unique execution ID
- Workflow run ID
- Node ID
- Agent ID
- Input
- Output
- Start time
- End time
- Duration
- Retry count
- Status
- Error details
- Model usage, when available

### Loop Handling

Workflows may contain cycles, especially development/testing loops.

Implement bounded cycles.

Allow a workflow author to configure:

- Maximum loop iterations
- Maximum workflow duration
- Maximum total agent steps
- Per-agent execution timeout
- Retry policies
- Failure escalation

The workflow validator must distinguish supported bounded loops from invalid or potentially unbounded cyclic graphs.

Never permit unbounded agent delegation or execution.

### Parallel Execution

Support multiple independent nodes running simultaneously.

A Join node must have explicit semantics, such as:

- Wait for all required upstream branches
- Wait for any successful branch

Define how skipped branches and failed branches affect joins.

Ensure an individual node is not accidentally executed multiple times due to duplicated events.

Use idempotency keys and persisted execution attempts.

## 7. Python Agent Framework

Create a reusable Python agent abstraction.

Every agent must have:

- Agent identity
- Name and description
- System instructions
- Model configuration
- Allowed tools
- Input schema
- Output schema
- Execution limits
- Execution method

Provide a typed interface conceptually similar to:

```python
class BaseAgent(ABC):
    @abstractmethod
    async def execute(
        self,
        context: AgentContext
    ) -> AgentResult:
        ...
```

Implement a common runtime that supports:

1. Creating LLM requests
2. Receiving model responses
3. Parsing tool calls
4. Validating tool arguments
5. Executing authorized tools
6. Feeding results back to the model
7. Repeating within configured limits
8. Validating the final structured output

Agents should not need individually deployed LLM servers.

They should be able to share a central OpenAI-compatible inference endpoint.

### Model Configuration

Allow the user to configure providers through the UI.

Fields:

- Provider name
- Base URL
- Model ID
- API key reference
- Temperature
- Maximum output tokens
- Request timeout

Support local inference services such as vLLM or Ollama through their compatible interfaces.

API credentials must remain server-side and never appear in workflow JSON or browser responses.

Support per-agent model selection.

## 8. Agent-to-Agent Communication

Design agents as independently deployable services.

For the MVP, support:

- Internal HTTP communication for direct calls
- RabbitMQ for asynchronous task execution
- Consistent task correlation identifiers

Structure the code so an A2A adapter can be added later.

Do not make A2A mandatory for the initial MVP.

Distinguish agent-to-agent communication from tool access.

Prepare MCP integration for external tools, but implement a minimal tool registry first.

Communication contracts must define:

- Workflow ID
- Execution ID
- Task ID
- Source agent
- Target agent
- Input payload
- Correlation ID
- Deadline
- Result payload
- Error representation

Use versioned, schema-validated messages.

## 9. Real-Time Workflow Visualization

The workflow canvas must visualize actual execution state.

Use WebSockets to broadcast events to connected clients.

Required events:

- workflow.started
- workflow.paused
- workflow.resumed
- workflow.completed
- workflow.failed
- node.queued
- node.started
- node.progress
- node.completed
- node.failed
- node.skipped
- approval.requested
- approval.resolved

### Node Appearance

Use status-driven styling:

- Gray: Pending
- Blue: Queued
- Animated blue: Running
- Green: Completed
- Red: Failed
- Yellow: Waiting for approval
- Muted gray: Skipped

Animate the relevant edges when workflow execution advances.

When an agent is running, display:

- Current status
- Latest meaningful activity
- Elapsed execution time
- Token usage when available

Clicking a node during execution must show its inputs, outputs, logs, tool calls, errors and retry history.

Reconnect WebSocket clients safely, using persisted execution state and event sequence numbers to recover missed updates.

Do not rely on in-memory frontend state as the source of truth.

## 10. Example SDLC Workflow

Ship the application with a preconfigured working example.

**Workflow name:** Autonomous Development Pipeline

Execution:

1. User enters a software development requirement.
2. Planning Agent analyzes requirements and produces implementation tasks.
3. Developer Agent performs development operations in an isolated workspace.
4. Testing Agent executes configured tests.
5. Condition Node checks test results.
6. If tests fail, Fix Code Agent receives the findings and attempts repair.
7. Repeat until tests pass or the maximum retry count is reached.
8. Code Review Agent evaluates the changes.
9. Condition Node checks the review result.
10. If review fails, return to Developer Agent.
11. If review passes, request human approval.
12. After approval, create a pull request or perform an explicitly authorized merge action.
13. Complete the workflow and generate an execution report.

Do not simulate successful test or review results in the real example.

Use an actual sandbox repository and real test execution.

If Git or CI credentials are not configured, clearly identify unavailable external operations and provide a local demonstration using a sample repository. Never fabricate a GitHub pull request, Jenkins build, deployment, or approval.

## 11. Tool Integration

Create a tool interface so agents can execute permitted operations.

Initial tools:

- Read repository files
- Search repository content
- Create or modify files in an isolated workspace
- Run approved shell commands in a sandbox
- Run unit tests
- Inspect Git changes
- Generate a patch
- Create a local development report

Prepare optional integration adapters for:

- GitHub
- GitLab
- Jenkins
- Kubernetes
- MCP servers

Tool security is mandatory.

Do not provide unrestricted host shell execution.

Each agent must operate with least-privilege permissions and explicit workspace boundaries.

Destructive operations and production deployments must require authorization.

## 12. Database Design

Create database tables for at least:

- users
- workflows
- workflow_versions
- workflow_nodes
- workflow_edges
- agents
- agent_versions
- model_providers
- tools
- workflow_runs
- node_runs
- execution_events
- approvals
- agent_artifacts

Use UUID primary keys where appropriate.

Workflow definitions must be versioned.

Completed execution records must reference immutable workflow versions.

Store large logs and artifacts outside the main relational database when appropriate; retain references and metadata in PostgreSQL.

Use Alembic for database migrations.

## 13. API Design

Implement REST APIs including:

**Workflows**
- GET /api/workflows
- POST /api/workflows
- GET /api/workflows/{id}
- PUT /api/workflows/{id}
- DELETE /api/workflows/{id}
- POST /api/workflows/{id}/validate

**Execution**
- POST /api/workflows/{id}/execute
- GET /api/executions/{id}
- POST /api/executions/{id}/pause
- POST /api/executions/{id}/resume
- POST /api/executions/{id}/cancel
- GET /api/executions/{id}/events

**Agents**
- GET /api/agents
- POST /api/agents
- GET /api/agents/{id}
- PUT /api/agents/{id}
- DELETE /api/agents/{id}

**Approvals**
- GET /api/approvals
- POST /api/approvals/{id}/decision

**Real-time**
- WS /api/executions/{id}/stream

Also provide model configuration, tools, and workflow import/export endpoints.

Document API contracts using FastAPI OpenAPI documentation.

## 14. Frontend Pages

Build these pages:

### Dashboard

Show recent executions, workflows, success/failure counts, active runs and pending approvals.

### Workflow Management

Show workflows with search, create, duplicate, edit, delete and execution actions.

### Workflow Editor

Full React Flow drag-and-drop builder with node palette, canvas, configuration panel and save/validate controls.

### Workflow Execution

Reuse the React Flow canvas in execution-monitoring mode.

Show live node status, logs, timeline and workflow execution controls.

### Agent Management

Create and configure available agents and their tool permissions.

### Model Settings

Configure LLM providers, base URLs and model IDs.

### Execution History

Search previous workflow executions and inspect their node-level results.

### Approvals

Allow authorized users to review and approve or reject pending actions.

## 15. UI/UX Expectations

Create a polished professional application, not a basic admin template.

Requirements:

- Dark and light theme
- Responsive layout
- Collapsible sidebar
- Modern typography
- Consistent iconography
- Well-designed empty states
- Clear error states
- Loading indicators
- Confirmation dialogs for destructive actions
- Toast notifications
- Accessible keyboard interactions

The workflow editor must remain usable for larger graphs.

Prioritize readability, efficient node spacing and discoverable controls.

Use React Flow custom nodes and named handles for conditional branches.

## 16. Security and Reliability

Implement or establish working foundations for:

- Authentication and authorization
- Per-workflow access control
- Secret handling
- Per-agent tool permissions
- Input and output validation
- Workflow-level resource limits
- Execution timeouts
- Bounded retries
- Idempotent task handling
- Audit logs
- WebSocket authorization
- Health and readiness endpoints
- Graceful shutdown and task recovery

Agent-generated instructions, repository content, and tool results must be treated as untrusted inputs.

Protect against prompt-injection attempts and unauthorized cross-workflow data access.

The execution engine must independently enforce permission checks, rather than trusting the LLM to do so.

## 17. Project Organization

Use a monorepo with this general structure:

```text
agentic-sdlc/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── workflow/
│   │   │   ├── nodes/
│   │   │   ├── edges/
│   │   │   ├── editor/
│   │   │   └── execution/
│   │   ├── services/
│   │   ├── stores/
│   │   └── types/
│   └── package.json
├── backend/
│   ├── app/
│   │   ├── api/
│   │   ├── core/
│   │   ├── models/
│   │   ├── schemas/
│   │   ├── services/
│   │   ├── orchestration/
│   │   ├── agents/
│   │   ├── tools/
│   │   ├── workers/
│   │   └── integrations/
│   ├── alembic/
│   └── tests/
├── infrastructure/
│   ├── docker/
│   └── kubernetes/
├── examples/
├── docs/
├── docker-compose.yml
├── .env.example
└── README.md
```

Use modular architecture and clear boundaries between orchestration, agent execution, persistence and external integrations.

Avoid unnecessary microservice fragmentation for the MVP.

However, design agent workers so they can be independently containerized and horizontally scaled later.

## 18. Testing Requirements

Create automated tests for:

- Workflow graph validation
- Branch condition evaluation
- Agent input/output contracts
- Dependency resolution
- Parallel branch joining
- Loop execution limits
- Retry handling
- Task deduplication
- Workflow pause/resume
- Human approvals
- Authorization failures
- WebSocket event consistency

Provide a frontend integration test demonstrating creation of a workflow, connecting nodes, configuring a condition and saving it.

Provide at least one end-to-end test that executes a working sample workflow and verifies the expected branch selections and final state.

## 19. Implementation Strategy

Implement in the following order.

**Phase 1 — Project foundation**

Create the repository structure, Docker Compose services, FastAPI backend, React application, database migrations and health checks.

**Phase 2 — Workflow editor**

Implement React Flow custom nodes, connections, condition editing, workflow persistence and graph validation.

**Phase 3 — Execution engine**

Implement workflow runs, dependency scheduling, conditional branching, retries, bounded loops and execution persistence.

**Phase 4 — Python agent runtime**

Implement a working LLM client, structured inputs/outputs, reusable agent abstractions, model settings and a secure basic tool registry.

**Phase 5 — Real-time execution**

Implement WebSocket events and synchronize them with the React Flow execution visualization.

**Phase 6 — End-to-end SDLC workflow**

Build the sample development pipeline with real tool execution in a sandbox, test evaluation, conditional branches and human approval.

**Phase 7 — Reliability and documentation**

Add automated tests, authentication, failure recovery, developer documentation and deployment instructions.

## 20. Definition of Done

Do not consider the MVP complete until the following works:

- A user can open the workflow editor.
- A user can drag AI agent and condition nodes onto the canvas.
- A user can connect nodes using handles.
- A user can configure agent prompts and conditions.
- A user can save and reopen a workflow.
- The backend can validate the workflow.
- A user can launch workflow execution.
- Python agent workers actually execute configured tasks.
- Conditions select the correct branches.
- Loops stop at configured limits.
- Workflow state survives backend restarts.
- The frontend shows real execution progress.
- Node inspection shows real outputs and errors.
- Human approvals pause and resume execution.
- The sample SDLC workflow completes successfully under configured local prerequisites.
- The entire local platform starts through Docker Compose.
- Tests and documentation explain how to verify these behaviors.

## 21. Your Instructions as Claude

Before implementation:

1. Inspect the current repository if one exists.
2. Identify reusable components and existing conventions.
3. Present a concise architecture and implementation plan.
4. Identify major technical risks and proposed mitigations.
5. Use the selected technology stack unless a documented compatibility problem requires a change.

Then proceed with implementation.

Do not produce architecture documentation as a substitute for working code.

Do not build a frontend disconnected from the backend.

Do not create fake agent execution results in production endpoints.

Prefer simple, testable implementations over premature abstraction.

Use explicit types, structured interfaces, clear errors and appropriate logging.

After each implementation phase:

- Run relevant tests.
- Fix failures.
- Document completed functionality.
- Identify incomplete features accurately.
- Continue with the next phase.

When finished, provide:

1. Architecture overview.
2. Project directory structure.
3. Implemented features.
4. Local startup commands.
5. Test and verification instructions.
6. Example workflow walkthrough.
7. Known limitations.
8. Kubernetes scaling recommendations.

**Your ultimate goal is a genuinely functional visual Agentic AI SDLC platform, not a proof-of-concept UI.**
## 22. Business-Friendly AI Workflow Creation (enhancement)

The platform also serves non-technical employees in HR, Finance, Operations, IT and other
departments. Technical complexity is hidden by default and stays available in Advanced mode.
The detailed design is in `docs/superpowers/specs/2026-10-10-business-ai-workflow-design.md`.

### Canonical model
- The **Business Plan** (`bp/1`) is the single source of truth for business workflows. It is
  typed, versioned JSON made of business steps (action, decision, approval, wait). Each step
  names a registered **capability**, not an implementation.
- A **deterministic compiler** turns a plan into the React Flow workflow definition that the
  existing engine executes. Node ids equal stable step ids. Compiling the same plan always gives
  the same output. `definition.meta` records the plan schema, compiler, registry and policy
  versions and the plan hash.
- React Flow is a view of the plan. Visual edits in the Advanced editor are translated back into
  typed plan operations. Edits that cannot be represented safely are rejected with a reason,
  never silently dropped. A workflow can be explicitly detached into an advanced-only workflow.
- Workflows built only in the Advanced editor (no plan) remain fully supported.

### Three creation modes, one schema and engine
1. **AI-Assisted Builder (default)**: natural language → Business Plan → compiled graph, with a
   business-language explanation, conversational changes, and diffs to confirm.
2. **Template Builder**: department templates (HR, Finance, Operations, IT, Software
   Development) that are themselves Business Plans and fully editable.
3. **Advanced Builder**: the existing React Flow editor.

### AI Workflow Designer (`backend/app/designer`)
- A pluggable `Planner` interface. v1 is an LLM planner on the configured OpenAI-compatible
  provider, producing schema-validated JSON (never code). An agentic planner can be added later
  without touching the compiler or the policy layer.
- Pipeline:
  1. analyze intent and select capabilities from the registry only
  2. validate and repair
  3. apply policy
  4. compile
  5. validate the graph
  6. produce a deterministic explanation
  7. user review
- Conversational changes are typed operations (`add_step`, `remove_step`, `update_step`,
  `set_condition`, `add_approval_before`, `set_retry`, `set_next`, `set_on_failure`,
  `set_trigger`, `add_input`, `remove_input`, `rename`). They are applied transactionally and
  shown as a diff before confirmation. Accepted changes create new versions; designer sessions
  provide undo/redo.

### Registries
- **Capability registry**: business capabilities with descriptions, I/O schemas, allowed
  departments, side-effect class, sensitivity, connector requirement, implementation, and a
  simulation sample.
- **Agent registry**: agents discoverable by capability, with departments, I/O schemas, required
  tools, configuration requirements, constraints, version and availability.
- **Tool and connector registry**: tools with capability, connector type, authentication, scopes,
  department restrictions, side-effect class and approval requirement.
- Each capability has a status: *available and authorized*, *requires connection*, *restricted by
  policy*, or *not available*.
- Missing capabilities are shown as setup requirements and are never faked or substituted.
- **Connections** (SMTP, HTTP/webhook, Slack, Teams) are created by administrators through a
  guided form. Secrets are encrypted at rest, write-only, and never reach the LLM, the browser
  or workflow definitions. LLM recommendations never grant permissions.

### Governance, independent of the LLM
- Role-based access with department memberships (member, builder, approver, dept_admin) and
  platform admins.
- Workflow visibility and editing follow ownership and department. HR and Finance run data is
  restricted to those groups.
- Mandatory approval before communication, external-write and financial side effects. Missing
  approvals are inserted by policy.
- Separation of duties for financial approvals, enforced at decision time.
- Workflows must be explicitly **enabled** (with acknowledgement of sensitive actions) before
  real execution. Runs always execute the immutable enabled version snapshot.
- Agent outputs and external documents are untrusted input. Data minimization: steps receive
  only their declared parameters. Every security-relevant action is audited.

### Simulation
Simulation runs the draft through the same engine in `simulation` mode:
- side-effect tools return labelled sample outputs instead of acting
- approval outcomes come from the simulation input
- waits are skipped

Results are clearly marked as simulated. Simulation shows the branch path, missing integrations,
approvals and expected outputs.
