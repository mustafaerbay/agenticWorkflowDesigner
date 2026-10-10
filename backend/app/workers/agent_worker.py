"""Agent worker: consumes agent/tool tasks, executes them, records results.

Idempotency: a task is claimed with a conditional QUEUED -> RUNNING update; duplicate
or stale deliveries are acknowledged and dropped. Heartbeats let the orchestrator
detect crashed workers; redelivered messages may re-claim a stale RUNNING task.
"""

import asyncio
import json
import logging
import os
import signal
import socket
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agents.base import AgentContext, AgentExecutionError, AgentResult
from app.agents.runtime import build_agent
from app.core.config import get_settings
from app.core.db import dispose_engine, session_factory
from app.core.logging import configure_logging
from app.models import AgentArtifact, NodeRun, WorkflowRun
from app.orchestration.bus import Bus, RabbitRedisBus
from app.orchestration.engine import RunContext
from app.orchestration.events import commit_and_publish, emit, lock_run
from app.services.execution import render_template, resolve_refs, resolve_value
from app.tools.registry import SandboxClient, ToolContext, ToolError, execute_tool, write_artifact_file
from app.workers.messages import AgentTask, AgentTaskResult, OrchestratorCommand

log = logging.getLogger("agent_worker")

RUNNABLE_RUN_STATES = {"RUNNING", "WAITING_APPROVAL", "PAUSED"}


def now() -> datetime:
    return datetime.now(UTC)


class AgentWorker:
    def __init__(
        self,
        bus: Bus,
        sessions: async_sessionmaker[AsyncSession] | None = None,
        sandbox: SandboxClient | None = None,
        worker_id: str | None = None,
    ) -> None:
        self.bus = bus
        self.sessions = sessions or session_factory()
        self.sandbox = sandbox or SandboxClient()
        self.worker_id = worker_id or f"{socket.gethostname()}:{os.getpid()}"
        self.settings = get_settings()

    async def process(self, raw: dict[str, Any]) -> str:
        """Handle one task message. Returns a short outcome string (for logs/tests)."""
        task = AgentTask.model_validate(raw)
        claimed = await self._claim(task)
        if claimed is None:
            return "skipped"
        node_run, run = claimed
        heartbeat = asyncio.create_task(self._heartbeat(task))
        cancelled = asyncio.Event()
        try:
            result, error, retryable = await self._execute(task, node_run, run, cancelled)
        except Exception as exc:  # never leave a claimed task RUNNING because of an unexpected bug
            log.exception("task setup crashed", extra={"task_id": task.task_id})
            result, error, retryable = None, f"Internal error: {type(exc).__name__}: {exc}", True
        finally:
            heartbeat.cancel()
        return await self._finish(task, result, error, retryable)

    # -- claim / heartbeat / finish -------------------------------------------

    async def _claim(self, task: AgentTask) -> tuple[NodeRun, WorkflowRun] | None:
        async with self.sessions() as session:
            run = await lock_run(session, task.execution_id)
            if run is None:
                return None
            node_run = await session.get(NodeRun, uuid.UUID(task.task_id), with_for_update=True)
            if node_run is None:
                return None
            if run.status not in RUNNABLE_RUN_STATES:
                if node_run.status == "QUEUED":
                    node_run.status = "CANCELLED"
                    node_run.finished_at = now()
                    node_run.routed = True
                    emit(session, run, "node.cancelled", node_id=node_run.node_id, node_run_id=node_run.id,
                         data={"status": "CANCELLED", "iteration": node_run.iteration, "attempt": node_run.attempt})
                    await commit_and_publish(session, self.bus)
                return None
            stale_before = now() - timedelta(seconds=self.settings.heartbeat_stale_seconds)
            claimable = node_run.status == "QUEUED" or (
                node_run.status == "RUNNING" and (node_run.heartbeat_at is None or node_run.heartbeat_at < stale_before)
            )
            if not claimable:
                log.info("duplicate or stale task dropped", extra={"task_id": task.task_id, "status": node_run.status})
                return None
            reclaimed = node_run.status == "RUNNING"
            node_run.status = "RUNNING"
            node_run.claimed_by = self.worker_id
            node_run.heartbeat_at = now()
            node_run.started_at = now()
            if reclaimed:
                node_run.logs = [*node_run.logs, self._log("warning", "Task re-claimed after worker heartbeat loss")]
            emit(session, run, "node.started", node_id=node_run.node_id, node_run_id=node_run.id,
                 data={"status": "RUNNING", "iteration": node_run.iteration, "attempt": node_run.attempt,
                       "worker": self.worker_id})
            await commit_and_publish(session, self.bus)
            return node_run, run

    async def _heartbeat(self, task: AgentTask) -> None:
        while True:
            await asyncio.sleep(self.settings.heartbeat_interval_seconds)
            try:
                async with self.sessions() as session:
                    await session.execute(
                        update(NodeRun)
                        .where(NodeRun.id == uuid.UUID(task.task_id), NodeRun.claimed_by == self.worker_id)
                        .values(heartbeat_at=now())
                    )
                    await session.commit()
            except Exception:
                log.warning("heartbeat failed", exc_info=True)

    async def _finish(
        self, task: AgentTask, result: AgentResult | None, error: str | None, retryable: bool = True
    ) -> str:
        async with self.sessions() as session:
            run = await lock_run(session, task.execution_id)
            node_run = await session.get(NodeRun, uuid.UUID(task.task_id), with_for_update=True,
                                         populate_existing=True)
            if run is None or node_run is None:
                return "lost"
            if node_run.status != "RUNNING" or node_run.claimed_by != self.worker_id:
                log.info("result discarded: task no longer owned", extra={"task_id": task.task_id})
                return "discarded"
            node_run.finished_at = now()
            data: dict[str, Any] = {"iteration": node_run.iteration, "attempt": node_run.attempt}
            if node_run.started_at:
                data["duration_ms"] = int((node_run.finished_at - node_run.started_at).total_seconds() * 1000)
            if error is None and result is not None:
                node_run.status = "COMPLETED"
                node_run.output = result.output
                node_run.usage = result.usage
                if result.model:
                    node_run.model = result.model
                data.update(status="COMPLETED", usage=result.usage)
                emit(session, run, "node.completed", node_id=node_run.node_id, node_run_id=node_run.id, data=data)
            else:
                node_run.status = "FAILED"
                node_run.error = error
                node_run.retryable = retryable
                node_run.logs = [*node_run.logs, self._log("error", error or "unknown error")]
                data.update(status="FAILED", error=error, retryable=retryable)
                emit(session, run, "node.failed", node_id=node_run.node_id, node_run_id=node_run.id, data=data)
            message = AgentTaskResult(
                execution_id=task.execution_id,
                task_id=task.task_id,
                correlation_id=task.correlation_id,
                status=node_run.status,  # type: ignore[arg-type]
                result_payload=node_run.output if node_run.status == "COMPLETED" else None,
                error={"type": "AgentExecutionError", "message": error} if error else None,
            )
            session.info.setdefault("commands", []).append(
                OrchestratorCommand(type="node.finished", run_id=task.execution_id, node_run_id=task.task_id,
                                    correlation_id=task.correlation_id).model_dump()
            )
            log.info("task finished", extra={"task_id": task.task_id, "status": message.status,
                                             "correlation_id": task.correlation_id})
            await commit_and_publish(session, self.bus)
            return node_run.status

    # -- execution ---------------------------------------------------------------

    def _log(self, level: str, message: str) -> dict[str, str]:
        return {"ts": now().isoformat(), "level": level, "message": message[:2000]}

    async def _execute(
        self, task: AgentTask, node_run: NodeRun, run: WorkflowRun, cancelled: asyncio.Event
    ) -> tuple[AgentResult | None, str | None, bool]:
        config = run.effective_config.get(node_run.node_id) or {}
        timeout = float(config.get("timeout_seconds") or 300)
        async with self.sessions() as session:
            result = await session.execute(select(NodeRun).where(NodeRun.run_id == run.id))
            eval_ctx = RunContext(session, run, list(result.scalars().all())).eval_context()

        run_id, node_run_id = str(run.id), str(node_run.id)

        async def report(message: str) -> None:
            await self._append(task, logs=[self._log("info", message)], progress=message)

        async def record_tool_call(entry: dict[str, Any]) -> None:
            await self._append(task, tool_calls=[entry])

        async def is_cancelled() -> bool:
            async with self.sessions() as session:
                status = (await session.execute(select(WorkflowRun.status).where(WorkflowRun.id == run.id))).scalar_one()
                return status in ("CANCELLED", "FAILED")

        tool_ctx = ToolContext(
            run_id=run_id,
            node_run_id=node_run_id,
            sandbox=self.sandbox,
            workspace_template=(run.input or {}).get("workspace_template"),
            save_artifact=lambda name, kind, content: self._save_artifact(run_id, node_run_id, name, kind, content),
            build_report=lambda: self._build_report(run_id),
            services=WorkerServices(self.sessions, run),
        )
        simulation = run.mode == "simulation"
        try:
            if simulation:
                simulated = await self._simulate(task, node_run, run, config, eval_ctx, tool_ctx, report)
                if simulated is not None:
                    return simulated, None, True
            if node_run.node_type == "tool":
                args = resolve_value(config.get("args") or {}, eval_ctx)
                await self._set_input(task, {"tool": config.get("tool"), "args": args})
                await report(f"Running tool {config.get('tool')}")
                entry: dict[str, Any] = {"tool": config.get("tool"), "args": args}
                try:
                    output, duration = await asyncio.wait_for(
                        execute_tool(config.get("tool"), args, tool_ctx, None), timeout=timeout
                    )
                    entry.update(result=output, error=None, duration_ms=duration)
                    return AgentResult(output), None, True
                except ToolError as exc:
                    entry.update(result=None, error=str(exc), duration_ms=None)
                    raise
                finally:
                    await record_tool_call(entry)
            # Data minimization: business AI steps only see their declared parameters.
            inputs: dict[str, Any] = {} if config.get("minimize_inputs") else {"input": run.input or {}}
            for key, ref in (config.get("input_mapping") or {}).items():
                inputs[key] = eval_ctx.resolve(ref)
            prompt = render_template(config.get("user_prompt") or "", eval_ctx)
            kind = config.get("kind") or "llm"
            await self._set_input(task, {"kind": kind, "prompt": prompt, "inputs": inputs,
                                         "tools": config.get("tools") or [],
                                         "model": (config.get("provider") or {}).get("model") if kind == "llm" else None})
            if kind == "scripted":
                config = {**config, "steps": [
                    {**step, "args": resolve_refs(step.get("args") or {}, eval_ctx)} for step in config.get("steps") or []
                ]}
                await report("Scripted agent (deterministic, no LLM) started")
            context = AgentContext(
                run_id=run_id, node_id=node_run.node_id, node_run_id=node_run_id, config=config,
                inputs=inputs, prompt=prompt, tools=tool_ctx, report=report,
                record_tool_call=record_tool_call, is_cancelled=is_cancelled,
            )
            agent = build_agent(kind)
            return await asyncio.wait_for(agent.execute(context), timeout=timeout), None, True
        except TimeoutError:
            return None, f"Timed out after {int(timeout)}s", True
        except (AgentExecutionError, ToolError) as exc:
            return None, str(exc), exc.retryable
        except Exception as exc:  # unexpected bug: record it rather than crash the worker
            log.exception("agent execution crashed", extra={"task_id": task.task_id})
            return None, f"Internal error: {type(exc).__name__}: {exc}", True

    async def _simulate(
        self, task: AgentTask, node_run: NodeRun, run: WorkflowRun, config: dict[str, Any], eval_ctx: Any,
        tool_ctx: ToolContext, report: Any,
    ) -> AgentResult | None:
        """Simulation mode: never perform side effects. Returns None to execute a step for real
        (read-only steps), or a labelled simulated result."""
        from app.business.capabilities import get_capability, tool_side_effects

        options = (run.effective_config or {}).get("__simulation__") or {}
        override = (options.get("step_outputs") or {}).get(node_run.node_id)
        capability = get_capability(str(config.get("capability") or ""))
        sample = dict(capability.sample_output) if capability else {}

        def labelled(output: dict[str, Any], reason: str) -> AgentResult:
            return AgentResult({**output, "_simulated": True, "_simulation_note": reason})

        if isinstance(override, dict):
            await report("Simulation: using the sample output you provided")
            return labelled({**sample, **override}, "Sample output provided for the simulation")
        if node_run.node_type == "tool":
            effect = config.get("side_effect") or tool_side_effects().get(str(config.get("tool")), "external_write")
            if effect != "none":
                await report(f"Simulation: '{node_run.label}' was not executed ({effect.replace('_', ' ')} side effect)")
                return labelled(sample, f"Not executed in simulation: this step has a {effect.replace('_', ' ')} "
                                        "side effect")
            try:
                args = resolve_value(config.get("args") or {}, eval_ctx)
                output, _ = await execute_tool(config.get("tool"), args, tool_ctx, None)
                return AgentResult({**output, "_simulated": False})
            except ToolError as exc:
                await report(f"Simulation: read-only step could not run ({exc}); using a sample result")
                return labelled(sample, f"Sample result (the real step could not run in simulation: {exc})")
        if config.get("kind") == "llm" and not (config.get("provider") or {}).get("base_url"):
            await report("Simulation: no AI model configured; using a sample result")
            return labelled(sample, "Sample result: no AI model provider is configured")
        return None

    async def _set_input(self, task: AgentTask, value: dict[str, Any]) -> None:
        async with self.sessions() as session:
            await session.execute(update(NodeRun).where(NodeRun.id == uuid.UUID(task.task_id)).values(input=value))
            await session.commit()

    async def _append(
        self, task: AgentTask, logs: list[Any] | None = None, tool_calls: list[Any] | None = None,
        progress: str | None = None,
    ) -> None:
        async with self.sessions() as session:
            run = await lock_run(session, task.execution_id)
            node_run = await session.get(NodeRun, uuid.UUID(task.task_id), with_for_update=True, populate_existing=True)
            if run is None or node_run is None or node_run.claimed_by != self.worker_id:
                return
            if logs:
                node_run.logs = [*node_run.logs, *logs][-500:]
            if tool_calls:
                node_run.tool_calls = [*node_run.tool_calls, *tool_calls][-200:]
            node_run.heartbeat_at = now()
            data: dict[str, Any] = {"status": "RUNNING", "iteration": node_run.iteration, "attempt": node_run.attempt}
            if progress:
                data["message"] = progress
            if tool_calls:
                data["tool"] = tool_calls[-1].get("tool")
            emit(session, run, "node.progress", node_id=node_run.node_id, node_run_id=node_run.id, data=data)
            await commit_and_publish(session, self.bus)

    async def _save_artifact(self, run_id: str, node_run_id: str, name: str, kind: str, content: bytes) -> dict[str, Any]:
        path, digest = write_artifact_file(run_id, name, content)
        async with self.sessions() as session:
            artifact = AgentArtifact(id=uuid.uuid4(), run_id=uuid.UUID(run_id), node_run_id=uuid.UUID(node_run_id),
                                     name=name, kind=kind, path=path, size_bytes=len(content), sha256=digest)
            session.add(artifact)
            await session.commit()
        return {"artifact_id": str(artifact.id), "name": name, "bytes": len(content), "sha256": digest}

    async def _build_report(self, run_id: str) -> str:
        async with self.sessions() as session:
            run = await session.get(WorkflowRun, uuid.UUID(run_id))
            node_runs = (await session.execute(
                select(NodeRun).where(NodeRun.run_id == uuid.UUID(run_id)).order_by(NodeRun.created_at)
            )).scalars().all()
        assert run is not None
        lines = [
            f"Workflow: **{run.workflow_name}** (version {run.workflow_version})",
            f"Execution: `{run.id}`",
            f"Input: `{json.dumps(run.input)[:500]}`",
            "",
            "| Node | Iteration | Attempt | Status | Summary |",
            "|---|---|---|---|---|",
        ]
        for nr in node_runs:
            summary = ""
            if nr.output:
                summary = str(nr.output.get("summary") or nr.output.get("selected_handle") or "")
            if nr.error:
                summary = f"error: {nr.error}"
            lines.append(f"| {nr.label} | {nr.iteration} | {nr.attempt} | {nr.status} | {summary[:120]} |")
        lines += ["", "_Generated from recorded execution data. No external systems were modified._"]
        return "\n".join(lines)


class WorkerServices:
    """Runtime services for tools. Every check here is enforced independently of the workflow
    definition: file access, recipients and connections are resolved for the run's department."""

    def __init__(self, sessions: async_sessionmaker[AsyncSession], run: WorkflowRun) -> None:
        self.sessions = sessions
        self.run = run

    async def check_file(self, file_id: str) -> None:
        from app.models import UploadedFile

        try:
            fid = uuid.UUID(file_id)
        except ValueError as exc:
            raise ToolError(f"'{file_id}' is not a file id", retryable=False) from exc
        async with self.sessions() as session:
            f = await session.get(UploadedFile, fid)
        if f is None:
            raise ToolError("file not found", retryable=False)
        same_department = f.department is not None and f.department == self.run.department
        if not (same_department or f.owner_id == self.run.created_by):
            raise ToolError("this run is not allowed to read that file", retryable=False)

    async def _resolve_users(self, session: AsyncSession, target: str) -> list[Any]:
        from app.models import User

        target = str(target).strip()
        if "@" in target and not target.split("@", 1)[0] in ("member", "builder", "approver", "dept_admin"):
            user = (await session.execute(select(User).where(User.email == target.lower(), User.is_active.is_(True)))).scalar_one_or_none()
            if user is None:
                user = (await session.execute(select(User).where(User.email == target, User.is_active.is_(True)))).scalar_one_or_none()
            return [user] if user else []
        role, _, department = target.partition("@")
        department = department or (self.run.department or "")
        users = (await session.execute(select(User).where(User.is_active.is_(True)))).scalars().all()
        return [u for u in users if any(m.get("department") == department and role in (m.get("roles") or [])
                                        for m in (u.memberships or []))]

    async def inbox(self, kind: str, target: str, title: str, body: str, due_in_days: Any = None) -> dict[str, Any]:
        from app.models import InboxItem

        async with self.sessions() as session:
            users = await self._resolve_users(session, target)
            if not users:
                raise ToolError(f"no active user or role matches '{target}'", retryable=False)
            due = None
            if due_in_days not in (None, ""):
                try:
                    due = now() + timedelta(days=float(due_in_days))
                except (TypeError, ValueError) as exc:
                    raise ToolError("due_in_days must be a number", retryable=False) from exc
            items = [InboxItem(id=uuid.uuid4(), user_id=u.id, kind=kind, title=str(title)[:300],
                               body=str(body)[:20_000], run_id=self.run.id, due_at=due) for u in users[:200]]
            session.add_all(items)
            await session.commit()
        key = "task_id" if kind == "task" else "notification_id"
        count_key = "assignees" if kind == "task" else "recipients"
        return {key: str(items[0].id), count_key: len(items)}

    async def require_prior_approval(self, tool: str) -> None:
        """Runtime safeguard independent of how the workflow was built: every sensitive action needs
        its own approved approval earlier in the same run."""
        async with self.sessions() as session:
            runs = (await session.execute(select(NodeRun).where(NodeRun.run_id == self.run.id))).scalars().all()
        approvals = sum(1 for nr in runs if nr.node_type == "approval" and nr.status == "COMPLETED"
                        and (nr.output or {}).get("approved") is True and not (nr.output or {}).get("_simulated"))
        executed = 0
        for nr in runs:
            for call in nr.tool_calls or []:
                if call.get("error") is not None or call.get("result") is None:
                    continue
                name = call.get("tool")
                method = str((call.get("args") or {}).get("method") or "GET").upper()
                if name in ("email_send", "chat_post") or (name == "http_request" and method != "GET"):
                    executed += 1
        if approvals <= executed:
            raise ToolError(f"'{tool}' needs an approval earlier in this run before it can act "
                            "(sensitive actions are never executed without approval)", retryable=False)

    async def connection(self, capability_connector: str) -> tuple[Any, str | None]:
        from app.connections.connectors import CONNECTOR_TYPES
        from app.connections.crypto import SecretStoreError, decrypt_secret
        from app.models import Connection

        types = [t for t, spec in CONNECTOR_TYPES.items() if spec["capability_connector"] == capability_connector]
        async with self.sessions() as session:
            rows = (await session.execute(
                select(Connection).where(Connection.connector.in_(types), Connection.enabled.is_(True))
                .order_by(Connection.created_at)
            )).scalars().all()
        usable = [c for c in rows if not c.departments or (self.run.department and self.run.department in c.departments)]
        if not usable:
            label = {"smtp": "email", "http": "business system", "chat": "Slack/Teams"}.get(capability_connector, capability_connector)
            raise ToolError(f"no {label} connection is available for the "
                            f"{self.run.department or 'unassigned'} department", retryable=False)
        connection = usable[0]
        try:
            secret = decrypt_secret(connection.secret_encrypted) if connection.secret_encrypted else None
        except SecretStoreError as exc:
            raise ToolError(str(exc), retryable=False) from exc
        return connection, secret


async def main() -> None:
    settings = get_settings()
    configure_logging("agentic-worker", settings.log_level)
    import aio_pika

    bus = RabbitRedisBus()
    worker = AgentWorker(bus)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    health = Path("/tmp/worker-healthy")

    while True:
        try:
            await bus.connect()
            break
        except Exception as exc:
            log.warning("waiting for RabbitMQ", extra={"error": str(exc)})
            await asyncio.sleep(3)
    connection = await aio_pika.connect_robust(settings.rabbitmq_url)
    channel = await connection.channel()
    await channel.set_qos(prefetch_count=settings.worker_concurrency)
    queue = await channel.declare_queue(settings.agent_task_queue, durable=True)
    in_flight: set[asyncio.Task[None]] = set()

    async def handle(message: aio_pika.abc.AbstractIncomingMessage) -> None:
        try:
            payload = json.loads(message.body)
            outcome = await worker.process(payload)
            log.info("task processed", extra={"task_id": payload.get("task_id"), "outcome": outcome})
            await message.ack()
        except Exception:
            log.exception("task handling failed; requeueing")
            await asyncio.sleep(2)
            await message.nack(requeue=True)

    async def on_message(message: aio_pika.abc.AbstractIncomingMessage) -> None:
        task = asyncio.create_task(handle(message))
        in_flight.add(task)
        task.add_done_callback(in_flight.discard)

    tag = await queue.consume(on_message)
    log.info("agent worker started", extra={"worker_id": worker.worker_id})
    while not stop.is_set():
        health.write_text(now().isoformat())
        try:
            await asyncio.wait_for(stop.wait(), timeout=5)
        except TimeoutError:
            pass
    log.info("shutting down: draining in-flight tasks", extra={"in_flight": len(in_flight)})
    await queue.cancel(tag)
    if in_flight:
        await asyncio.wait(in_flight, timeout=30)
    await connection.close()
    await bus.close()
    await dispose_engine()


if __name__ == "__main__":
    asyncio.run(main())

