"""Durable workflow engine.

All state lives in PostgreSQL. Every entry point locks the run row, mutates state,
stages events/tasks in the session, and the caller commits via commit_and_publish.
Handlers are idempotent so duplicated messages are harmless.
"""

import copy
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Approval, NodeRun, WorkflowRun
from app.orchestration.conditions import EvalContext, RuleError, evaluate
from app.orchestration.events import emit
from app.orchestration.graph import WORKER_TYPES, Graph
from app.orchestration.validator import effective_settings
from app.workers.messages import AgentTask

log = logging.getLogger(__name__)

ACTIVE_NODE_STATES = {"PENDING", "QUEUED", "RUNNING", "WAITING"}
TERMINAL_RUN_STATES = {"COMPLETED", "FAILED", "CANCELLED"}


def now() -> datetime:
    return datetime.now(UTC)


class RunContext:
    """In-memory view of one run during a single locked transaction."""

    def __init__(self, session: AsyncSession, run: WorkflowRun, node_runs: list[NodeRun]) -> None:
        self.session = session
        self.run = run
        self.graph = Graph.from_definition(run.definition)
        self.node_runs = node_runs
        self.settings = effective_settings(run.definition)
        # Deep copy: mutating the loaded JSON in place would hide changes from SQLAlchemy.
        state = copy.deepcopy(run.state or {})
        state.setdefault("marks", {})
        state.setdefault("joins", {})
        state.setdefault("end_reached", False)
        self.state = state

    def save_state(self) -> None:
        # Reassign so SQLAlchemy detects the JSONB change.
        self.run.state = {
            "marks": dict(self.state["marks"]),
            "joins": {k: dict(v) for k, v in self.state["joins"].items()},
            "end_reached": self.state["end_reached"],
        }

    def runs_of(self, node_id: str) -> list[NodeRun]:
        return [nr for nr in self.node_runs if nr.node_id == node_id]

    def active(self) -> list[NodeRun]:
        return [nr for nr in self.node_runs if nr.status in ACTIVE_NODE_STATES]

    def eval_context(self) -> EvalContext:
        outputs: dict[str, Any] = {}
        statuses: dict[str, str] = {}
        counts: dict[str, int] = {}
        ordered = sorted(self.node_runs, key=lambda n: (n.created_at or now(), n.iteration, n.attempt))
        for nr in ordered:
            statuses[nr.node_id] = nr.status
            if nr.status == "COMPLETED":
                outputs[nr.node_id] = nr.output
                counts[nr.node_id] = counts.get(nr.node_id, 0) + 1
        return EvalContext(self.run.input or {}, outputs, statuses, counts, self.run.steps)


class Engine:
    async def load(self, session: AsyncSession, run: WorkflowRun) -> RunContext:
        result = await session.execute(
            select(NodeRun).where(NodeRun.run_id == run.id).order_by(NodeRun.created_at)
        )
        return RunContext(session, run, list(result.scalars().all()))

    # -- entry points ---------------------------------------------------------

    async def start(self, session: AsyncSession, run: WorkflowRun) -> None:
        if run.status != "PENDING":
            return
        ctx = await self.load(session, run)
        run.status = "RUNNING"
        run.started_at = now()
        run.deadline_at = run.started_at + timedelta(seconds=ctx.settings["max_duration_seconds"])
        emit(session, run, "workflow.started", data={"status": "RUNNING"})
        if ctx.graph.start_id is None:
            self.fail_run(ctx, "Workflow has no start node")
            return
        self.activate(ctx, ctx.graph.start_id)
        await self.pump(ctx)

    async def kick(self, session: AsyncSession, run: WorkflowRun) -> None:
        if run.status in TERMINAL_RUN_STATES or run.status == "PENDING":
            if run.status == "PENDING":
                await self.start(session, run)
            return
        ctx = await self.load(session, run)
        await self.pump(ctx)

    async def node_finished(self, session: AsyncSession, run: WorkflowRun, node_run_id: str) -> None:
        ctx = await self.load(session, run)
        nr = next((n for n in ctx.node_runs if str(n.id) == str(node_run_id)), None)
        if nr is None or nr.routed:
            return
        if nr.status not in ("COMPLETED", "FAILED", "CANCELLED"):
            return
        nr.routed = True
        if run.status in TERMINAL_RUN_STATES:
            return
        if nr.status == "COMPLETED":
            self.route(ctx, nr, nr.selected_handle or "out")
        elif nr.status == "FAILED":
            self.handle_failure(ctx, nr)
        await self.pump(ctx)

    async def complete_due_delays(self, session: AsyncSession, run: WorkflowRun) -> None:
        ctx = await self.load(session, run)
        if run.status != "RUNNING":
            return
        for nr in ctx.node_runs:
            if nr.node_type == "delay" and nr.status == "WAITING" and nr.wait_until and nr.wait_until <= now():
                self.complete_inline(ctx, nr, {"waited_seconds": ctx.graph.config(nr.node_id).get("seconds", 0)})
                self.route(ctx, nr, "out")
        await self.pump(ctx)

    # -- activation / routing ---------------------------------------------------

    def activate(self, ctx: RunContext, node_id: str) -> NodeRun | None:
        runs = ctx.runs_of(node_id)
        executed = [r for r in runs if r.status != "SKIPPED" and r.attempt == 1]
        if len(executed) >= ctx.settings["max_loop_iterations"]:
            self.fail_run(
                ctx,
                f"limit_exceeded: node '{ctx.graph.label(node_id)}' reached max_loop_iterations="
                f"{ctx.settings['max_loop_iterations']}",
            )
            return None
        if ctx.run.steps + 1 > ctx.settings["max_total_steps"]:
            self.fail_run(ctx, f"limit_exceeded: max_total_steps={ctx.settings['max_total_steps']}")
            return None
        iteration = max((r.iteration for r in runs), default=0) + 1
        nr = self._new_node_run(ctx, node_id, iteration, attempt=1)
        ctx.run.steps += 1
        for eid in ctx.graph.outgoing[node_id]:
            ctx.state["marks"].pop(eid, None)
        ctx.save_state()
        return nr

    def _new_node_run(self, ctx: RunContext, node_id: str, iteration: int, attempt: int) -> NodeRun:
        node_type = ctx.graph.node_type(node_id)
        config = ctx.run.effective_config.get(node_id, {}) if node_type == "agent" else {}
        nr = NodeRun(
            id=uuid.uuid4(),
            run_id=ctx.run.id,
            node_id=node_id,
            node_type=node_type,
            label=ctx.graph.label(node_id),
            iteration=iteration,
            attempt=attempt,
            status="PENDING",
            logs=[],
            tool_calls=[],
            agent_kind=config.get("kind") if node_type == "agent" else None,
            model=(config.get("provider") or {}).get("model") if config.get("kind") == "llm" else None,
            agent_id=uuid.UUID(config["agent_id"]) if config.get("agent_id") else None,
            created_at=now(),
        )
        ctx.session.add(nr)
        ctx.node_runs.append(nr)
        return nr

    def route(self, ctx: RunContext, nr: NodeRun, handle: str) -> None:
        graph = ctx.graph
        node_id = nr.node_id
        nr.routed = True
        if graph.node_type(node_id) == "parallel":
            fired, dead = list(graph.outgoing[node_id]), []
        else:
            fired = graph.edges_from_handle(node_id, handle)
            dead = [e for e in graph.outgoing[node_id] if e not in fired]
        for eid in fired:
            ctx.state["marks"][eid] = "fired"
            emit(ctx.session, ctx.run, "edge.traversed", node_id=node_id, data={"edge_id": eid, "handle": handle})
        for eid in dead:
            ctx.state["marks"][eid] = "dead"
        ctx.save_state()
        for eid in fired:
            if ctx.run.status in TERMINAL_RUN_STATES:
                return
            target = graph.edges[eid]["target"]
            if graph.node_type(target) == "join" and eid not in graph.back_edges:
                self.join_arrival(ctx, target, eid, fired=True)
            else:
                self.activate(ctx, target)
        for eid in dead:
            if eid not in graph.back_edges:
                self.propagate_dead(ctx, graph.edges[eid]["target"], eid)

    def propagate_dead(self, ctx: RunContext, node_id: str, via_edge: str) -> None:
        graph = ctx.graph
        if graph.node_type(node_id) == "join":
            self.join_arrival(ctx, node_id, via_edge, fired=False)
            return
        forward = graph.forward_incoming(node_id)
        if not forward or any(ctx.state["marks"].get(e) != "dead" for e in forward):
            return
        if any(r.status in ACTIVE_NODE_STATES for r in ctx.runs_of(node_id)):
            return
        if node_id in self._reachable_from_active(ctx):
            return  # still reachable (e.g. via a loop), so not dead yet
        self.skip_node(ctx, node_id)

    def _reachable_from_active(self, ctx: RunContext) -> set[str]:
        graph = ctx.graph
        frontier = [nr.node_id for nr in ctx.active()]
        seen: set[str] = set()
        while frontier:
            current = frontier.pop()
            for eid in graph.outgoing.get(current, []):
                target = graph.edges[eid]["target"]
                if target not in seen:
                    seen.add(target)
                    frontier.append(target)
        return seen

    def skip_node(self, ctx: RunContext, node_id: str) -> None:
        runs = ctx.runs_of(node_id)
        iteration = max((r.iteration for r in runs), default=0) + 1
        nr = self._new_node_run(ctx, node_id, iteration, attempt=1)
        nr.status = "SKIPPED"
        nr.routed = True
        nr.finished_at = now()
        emit(ctx.session, ctx.run, "node.skipped", node_id=node_id, node_run_id=nr.id,
             data={"status": "SKIPPED", "iteration": iteration, "attempt": 1})
        graph = ctx.graph
        for eid in graph.outgoing[node_id]:
            ctx.state["marks"][eid] = "dead"
        ctx.save_state()
        for eid in graph.outgoing[node_id]:
            if eid not in graph.back_edges:
                self.propagate_dead(ctx, graph.edges[eid]["target"], eid)

    def join_arrival(self, ctx: RunContext, join_id: str, edge_id: str, fired: bool) -> None:
        graph = ctx.graph
        mode = graph.config(join_id).get("mode") or "all"
        joins = ctx.state["joins"]
        js = joins.setdefault(join_id, {"arrived": {}, "consumed": False})
        js = {"arrived": dict(js.get("arrived", {})), "consumed": bool(js.get("consumed"))}
        js["arrived"][edge_id] = "fired" if fired else "dead"
        forward = graph.forward_incoming(join_id)
        complete = all(e in js["arrived"] for e in forward)
        any_fired = any(v == "fired" for v in js["arrived"].values())
        activate = skip = False
        if mode == "any":
            if fired and not js["consumed"]:
                js["consumed"] = True
                activate = True
            if complete:
                if not any_fired:
                    skip = True
                js = {"arrived": {}, "consumed": False}
        else:
            if complete:
                activate, skip = any_fired, not any_fired
                js = {"arrived": {}, "consumed": False}
        joins[join_id] = js
        ctx.save_state()
        if activate:
            self.activate(ctx, join_id)
        elif skip:
            self.skip_node(ctx, join_id)

    # -- dispatch ---------------------------------------------------------------

    async def pump(self, ctx: RunContext) -> None:
        """Execute inline nodes and dispatch worker nodes until no progress is possible."""
        run = ctx.run
        for _ in range(10_000):
            if run.status in TERMINAL_RUN_STATES:
                return
            if run.deadline_at and now() > run.deadline_at:
                self.fail_run(ctx, f"limit_exceeded: max_duration_seconds={ctx.settings['max_duration_seconds']}")
                return
            if run.status == "PAUSED":
                break
            ready = [
                nr for nr in ctx.node_runs
                if nr.status == "PENDING" and (nr.not_before is None or nr.not_before <= now())
            ]
            if not ready:
                break
            for nr in ready:
                if run.status in TERMINAL_RUN_STATES or run.status == "PAUSED":
                    break
                if nr.node_type in WORKER_TYPES:
                    self.dispatch(ctx, nr)
                else:
                    self.execute_inline(ctx, nr)
        self.update_status(ctx)

    def dispatch(self, ctx: RunContext, nr: NodeRun) -> None:
        run = ctx.run
        nr.status = "QUEUED"
        nr.queued_at = now()
        emit(ctx.session, run, "node.queued", node_id=nr.node_id, node_run_id=nr.id,
             data={"status": "QUEUED", "iteration": nr.iteration, "attempt": nr.attempt})
        ctx.session.info.setdefault("tasks", []).append(self.build_task(ctx, nr))

    def build_task(self, ctx: RunContext, nr: NodeRun) -> dict[str, Any]:
        config = ctx.run.effective_config.get(nr.node_id) or ctx.graph.config(nr.node_id)
        timeout = int(config.get("timeout_seconds") or 300)
        target = config.get("preset") or config.get("kind") or nr.node_type
        task = AgentTask(
            workflow_id=str(ctx.run.workflow_id),
            execution_id=str(ctx.run.id),
            task_id=str(nr.id),
            node_id=nr.node_id,
            target_agent=f"{nr.node_type}:{target}",
            correlation_id=str(ctx.run.id),
            deadline=now() + timedelta(seconds=timeout),
            input_payload={"iteration": nr.iteration, "attempt": nr.attempt},
        )
        return task.model_dump(mode="json")

    def complete_inline(self, ctx: RunContext, nr: NodeRun, output: dict[str, Any], handle: str | None = None) -> None:
        nr.status = "COMPLETED"
        nr.output = output
        nr.selected_handle = handle
        nr.finished_at = now()
        if nr.started_at is None:
            nr.started_at = nr.finished_at
        data: dict[str, Any] = {"status": "COMPLETED", "iteration": nr.iteration, "attempt": nr.attempt}
        if handle:
            data["selected_handle"] = handle
        emit(ctx.session, ctx.run, "node.completed", node_id=nr.node_id, node_run_id=nr.id, data=data)

    def execute_inline(self, ctx: RunContext, nr: NodeRun) -> None:
        graph, run, session = ctx.graph, ctx.run, ctx.session
        config = graph.config(nr.node_id)
        ntype = nr.node_type
        nr.started_at = now()
        emit(session, run, "node.started", node_id=nr.node_id, node_run_id=nr.id,
             data={"status": "RUNNING", "iteration": nr.iteration, "attempt": nr.attempt})
        if ntype == "start":
            nr.input = run.input
            self.complete_inline(ctx, nr, dict(run.input or {}))
            self.route(ctx, nr, "out")
        elif ntype == "condition":
            eval_ctx = ctx.eval_context()
            evaluations = []
            selected = config.get("default_handle") or "false"
            try:
                for branch in config.get("branches") or []:
                    ok = evaluate(branch.get("rule"), eval_ctx)
                    evaluations.append({"handle": branch.get("handle"), "label": branch.get("label"), "result": ok})
                    if ok:
                        selected = branch["handle"]
                        break
            except RuleError as exc:
                self.fail_node_inline(ctx, nr, f"Condition evaluation failed: {exc}")
                return
            nr.input = {"evaluations": evaluations}
            nr.logs = [{"ts": now().isoformat(), "level": "info", "message": f"Selected branch '{selected}'"}]
            self.complete_inline(ctx, nr, {"selected_handle": selected, "evaluations": evaluations}, handle=selected)
            self.route(ctx, nr, selected)
        elif ntype in ("parallel", "join"):
            self.complete_inline(ctx, nr, {})
            self.route(ctx, nr, "out")
        elif ntype == "end":
            self.complete_inline(ctx, nr, {})
            ctx.state["end_reached"] = True
            ctx.save_state()
        elif ntype == "fail":
            message = config.get("message") or "Workflow reached a Fail node"
            self.complete_inline(ctx, nr, {"message": message})
            self.fail_run(ctx, message)
        elif ntype == "delay":
            seconds = float(config.get("seconds") or 0)
            nr.status = "WAITING"
            nr.wait_until = now() + timedelta(seconds=seconds)
            emit(session, run, "node.waiting", node_id=nr.node_id, node_run_id=nr.id,
                 data={"status": "WAITING", "reason": "delay", "until": nr.wait_until.isoformat(),
                       "iteration": nr.iteration, "attempt": nr.attempt})
            if seconds <= 0:
                self.complete_inline(ctx, nr, {"waited_seconds": 0})
                self.route(ctx, nr, "out")
        elif ntype == "approval":
            nr.status = "WAITING"
            approval = Approval(
                id=uuid.uuid4(),
                run_id=run.id,
                node_run_id=nr.id,
                node_id=nr.node_id,
                title=str(config.get("title") or graph.label(nr.node_id)),
                description=str(config.get("description") or ""),
                status="pending",
                requested_at=now(),
            )
            session.add(approval)
            emit(session, run, "node.waiting", node_id=nr.node_id, node_run_id=nr.id,
                 data={"status": "WAITING", "reason": "approval", "iteration": nr.iteration, "attempt": nr.attempt})
            emit(session, run, "approval.requested", node_id=nr.node_id, node_run_id=nr.id,
                 data={"approval_id": str(approval.id), "title": approval.title})
        else:
            self.fail_node_inline(ctx, nr, f"Unsupported inline node type {ntype}")

    def fail_node_inline(self, ctx: RunContext, nr: NodeRun, error: str) -> None:
        nr.status = "FAILED"
        nr.error = error
        nr.finished_at = now()
        nr.routed = True
        emit(ctx.session, ctx.run, "node.failed", node_id=nr.node_id, node_run_id=nr.id,
             data={"status": "FAILED", "error": error, "iteration": nr.iteration, "attempt": nr.attempt})
        self.fail_run(ctx, error)

    def handle_failure(self, ctx: RunContext, nr: NodeRun) -> None:
        config = ctx.run.effective_config.get(nr.node_id) or ctx.graph.config(nr.node_id)
        retry = config.get("retry") or {}
        max_attempts = int(retry.get("max_attempts") or 1)
        backoff = float(retry.get("backoff_seconds") or 0)
        if not nr.retryable:
            if nr.attempt < max_attempts:
                nr.logs = [*(nr.logs or []), {"ts": now().isoformat(), "level": "warning",
                                              "message": "Not retried: this error cannot be fixed by retrying"}]
            self.fail_run(ctx, f"Node '{nr.label}' failed (not retryable): {nr.error or 'unknown error'}")
            return
        if nr.attempt < max_attempts:
            if ctx.run.steps + 1 > ctx.settings["max_total_steps"]:
                self.fail_run(ctx, f"limit_exceeded: max_total_steps={ctx.settings['max_total_steps']}")
                return
            retry_run = self._new_node_run(ctx, nr.node_id, nr.iteration, nr.attempt + 1)
            retry_run.not_before = now() + timedelta(seconds=backoff * (2 ** (nr.attempt - 1)))
            ctx.run.steps += 1
            emit(ctx.session, ctx.run, "node.progress", node_id=nr.node_id, node_run_id=retry_run.id,
                 data={"status": "PENDING", "message": f"Retry {nr.attempt + 1}/{max_attempts} scheduled",
                       "iteration": nr.iteration, "attempt": nr.attempt + 1})
            return
        self.fail_run(ctx, f"Node '{nr.label}' failed after {nr.attempt} attempt(s): {nr.error or 'unknown error'}")

    # -- run-level state ---------------------------------------------------------

    def update_status(self, ctx: RunContext) -> None:
        run = ctx.run
        if run.status in TERMINAL_RUN_STATES or run.status == "PAUSED":
            return
        active = ctx.active()
        if not active:
            run.finished_at = now()
            if ctx.state["end_reached"]:
                run.status = "COMPLETED"
                run.output = self.collect_output(ctx)
                emit(ctx.session, run, "workflow.completed", data={"status": "COMPLETED"})
            else:
                run.status = "FAILED"
                run.error = "Workflow stopped without reaching an End node"
                emit(ctx.session, run, "workflow.failed", data={"status": "FAILED", "error": run.error})
            return
        only_approvals = all(nr.status == "WAITING" and nr.node_type == "approval" for nr in active)
        if only_approvals and run.status == "RUNNING":
            run.status = "WAITING_APPROVAL"
            emit(ctx.session, run, "workflow.waiting_approval", data={"status": "WAITING_APPROVAL"})
        elif not only_approvals and run.status == "WAITING_APPROVAL":
            run.status = "RUNNING"
            emit(ctx.session, run, "workflow.resumed", data={"status": "RUNNING"})

    def collect_output(self, ctx: RunContext) -> dict[str, Any]:
        latest: dict[str, Any] = {}
        for nr in sorted(ctx.node_runs, key=lambda n: n.created_at or now()):
            if nr.status == "COMPLETED" and nr.node_type in ("agent", "tool", "approval"):
                latest[nr.node_id] = nr.output
        return {"outputs": latest, "steps": ctx.run.steps}

    def fail_run(self, ctx: RunContext, error: str) -> None:
        run = ctx.run
        if run.status in TERMINAL_RUN_STATES:
            return
        run.status = "FAILED"
        run.error = error
        run.finished_at = now()
        self._cancel_active(ctx, "Run failed")
        emit(ctx.session, run, "workflow.failed", data={"status": "FAILED", "error": error})

    def _cancel_active(self, ctx: RunContext, reason: str) -> None:
        for nr in ctx.active():
            nr.status = "CANCELLED"
            nr.error = nr.error or reason
            nr.finished_at = now()
            nr.routed = True
            emit(ctx.session, ctx.run, "node.cancelled", node_id=nr.node_id, node_run_id=nr.id,
                 data={"status": "CANCELLED", "error": reason, "iteration": nr.iteration, "attempt": nr.attempt})

    async def cancel(self, session: AsyncSession, run: WorkflowRun) -> None:
        if run.status in TERMINAL_RUN_STATES:
            return
        ctx = await self.load(session, run)
        run.status = "CANCELLED"
        run.finished_at = now()
        run.error = "Cancelled by user"
        self._cancel_active(ctx, "Cancelled by user")
        await self._cancel_approvals(session, run)
        emit(session, run, "workflow.cancelled", data={"status": "CANCELLED"})

    async def _cancel_approvals(self, session: AsyncSession, run: WorkflowRun) -> None:
        result = await session.execute(
            select(Approval).where(Approval.run_id == run.id, Approval.status == "pending")
        )
        for approval in result.scalars():
            approval.status = "cancelled"
            approval.decided_at = now()

    async def pause(self, session: AsyncSession, run: WorkflowRun) -> bool:
        if run.status not in ("RUNNING", "WAITING_APPROVAL"):
            return False
        run.status = "PAUSED"
        emit(session, run, "workflow.paused", data={"status": "PAUSED"})
        return True

    async def resume(self, session: AsyncSession, run: WorkflowRun) -> bool:
        if run.status != "PAUSED":
            return False
        run.status = "RUNNING"
        emit(session, run, "workflow.resumed", data={"status": "RUNNING"})
        ctx = await self.load(session, run)
        # Results that arrived while paused were recorded but not routed.
        for nr in ctx.node_runs:
            if nr.status in ("COMPLETED", "FAILED") and not nr.routed and nr.node_type in WORKER_TYPES | {"approval"}:
                nr.routed = True
                if nr.status == "COMPLETED":
                    self.route(ctx, nr, nr.selected_handle or "out")
                else:
                    self.handle_failure(ctx, nr)
        await self.pump(ctx)
        return True

    async def decide_approval(
        self, session: AsyncSession, run: WorkflowRun, approval: Approval, approve: bool,
        user_id: uuid.UUID, user_email: str, comment: str | None,
    ) -> None:
        approval.status = "approved" if approve else "rejected"
        approval.decided_at = now()
        approval.decided_by = user_id
        approval.comment = comment
        ctx = await self.load(session, run)
        nr = next((n for n in ctx.node_runs if n.id == approval.node_run_id), None)
        emit(session, run, "approval.resolved", node_id=approval.node_id, node_run_id=approval.node_run_id,
             data={"approval_id": str(approval.id), "decision": approval.status, "decided_by": user_email})
        if nr is None or nr.status != "WAITING":
            return
        handle = "approved" if approve else "rejected"
        self.complete_inline(ctx, nr, {"approved": approve, "decision": approval.status,
                                       "comment": comment, "decided_by": user_email}, handle=handle)
        if run.status == "PAUSED":
            nr.routed = False  # routed on resume
            return
        if run.status == "WAITING_APPROVAL":
            run.status = "RUNNING"
            emit(session, run, "workflow.resumed", data={"status": "RUNNING"})
        self.route(ctx, nr, handle)
        await self.pump(ctx)
