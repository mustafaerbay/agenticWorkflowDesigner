"""Orchestrator service: applies commands to runs and sweeps timers/recovery.

Commands are idempotent and serialized per run with a row lock, so several
orchestrator replicas may run concurrently. The sweeper uses a Redis lock so only
one replica performs periodic maintenance at a time.
"""

import asyncio
import json
import logging
import signal
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import get_settings
from app.core.db import dispose_engine, session_factory
from app.core.logging import configure_logging
from app.models import NodeRun, WorkflowRun
from app.orchestration.bus import Bus, RabbitRedisBus
from app.orchestration.engine import TERMINAL_RUN_STATES, Engine
from app.orchestration.events import commit_and_publish, emit, lock_run
from app.workers.messages import OrchestratorCommand

log = logging.getLogger("orchestrator")


def now() -> datetime:
    return datetime.now(UTC)


class Orchestrator:
    def __init__(self, bus: Bus, sessions: async_sessionmaker[AsyncSession] | None = None) -> None:
        self.bus = bus
        self.sessions = sessions or session_factory()
        self.engine = Engine()
        self.settings = get_settings()

    async def handle(self, raw: dict[str, Any]) -> None:
        cmd = OrchestratorCommand.model_validate(raw)
        async with self.sessions() as session:
            run = await lock_run(session, cmd.run_id)
            if run is None:
                log.warning("command for unknown run", extra={"run_id": cmd.run_id})
                return
            if cmd.type == "run.start":
                await self.engine.start(session, run)
            elif cmd.type == "node.finished" and cmd.node_run_id:
                await self.engine.node_finished(session, run, cmd.node_run_id)
            elif cmd.type == "run.kick":
                await self.engine.kick(session, run)
            await commit_and_publish(session, self.bus)

    async def sweep(self) -> dict[str, int]:
        """Periodic maintenance: delays, retries, deadlines, lost workers, lost messages."""
        counts = {"delays": 0, "retries": 0, "deadlines": 0, "stale": 0, "requeued": 0, "started": 0}
        stale_before = now() - timedelta(seconds=self.settings.heartbeat_stale_seconds * 2)
        async with self.sessions() as session:
            due_delays = (await session.execute(
                select(NodeRun.run_id).where(NodeRun.status == "WAITING", NodeRun.node_type == "delay",
                                             NodeRun.wait_until <= now()).distinct()
            )).scalars().all()
            due_retries = (await session.execute(
                select(NodeRun.run_id).join(WorkflowRun, WorkflowRun.id == NodeRun.run_id)
                .where(NodeRun.status == "PENDING", NodeRun.not_before.is_not(None), NodeRun.not_before <= now(),
                       WorkflowRun.status == "RUNNING").distinct()
            )).scalars().all()
            overdue = (await session.execute(
                select(WorkflowRun.id).where(
                    WorkflowRun.status.in_(["RUNNING", "WAITING_APPROVAL", "PAUSED"]),
                    WorkflowRun.deadline_at < now())
            )).scalars().all()
            stale = (await session.execute(
                select(NodeRun.run_id, NodeRun.id).where(
                    NodeRun.status == "RUNNING", NodeRun.node_type.in_(["agent", "tool"]),
                    or_(NodeRun.heartbeat_at < stale_before, NodeRun.heartbeat_at.is_(None)))
            )).all()
            lost = (await session.execute(
                select(NodeRun.run_id, NodeRun.id).join(WorkflowRun, WorkflowRun.id == NodeRun.run_id).where(
                    NodeRun.status == "QUEUED", NodeRun.queued_at < now() - timedelta(seconds=120),
                    WorkflowRun.status.in_(["RUNNING", "WAITING_APPROVAL"]))
            )).all()
            pending_runs = (await session.execute(
                select(WorkflowRun.id).where(WorkflowRun.status == "PENDING",
                                             WorkflowRun.created_at < now() - timedelta(seconds=15))
            )).scalars().all()

        for run_id in due_delays:
            await self._with_run(run_id, self.engine.complete_due_delays)
            counts["delays"] += 1
        for run_id in due_retries:
            await self._with_run(run_id, self.engine.kick)
            counts["retries"] += 1
        for run_id in overdue:
            async def expire(session: AsyncSession, run: WorkflowRun) -> None:
                if run.status in TERMINAL_RUN_STATES:
                    return
                ctx = await self.engine.load(session, run)
                self.engine.fail_run(ctx, f"limit_exceeded: max_duration_seconds={ctx.settings['max_duration_seconds']}")
            await self._with_run(run_id, expire)
            counts["deadlines"] += 1
        for run_id, node_run_id in stale:
            await self._fail_stale(run_id, node_run_id)
            counts["stale"] += 1
        for run_id, node_run_id in lost:
            await self._requeue(run_id, node_run_id)
            counts["requeued"] += 1
        for run_id in pending_runs:
            await self._with_run(run_id, self.engine.start)
            counts["started"] += 1
        return counts

    async def _with_run(self, run_id: uuid.UUID, action: Any) -> None:
        async with self.sessions() as session:
            run = await lock_run(session, run_id)
            if run is None:
                return
            await action(session, run)
            await commit_and_publish(session, self.bus)

    async def _fail_stale(self, run_id: uuid.UUID, node_run_id: uuid.UUID) -> None:
        stale_before = now() - timedelta(seconds=self.settings.heartbeat_stale_seconds * 2)
        async with self.sessions() as session:
            run = await lock_run(session, run_id)
            nr = await session.get(NodeRun, node_run_id, with_for_update=True, populate_existing=True)
            if run is None or nr is None or nr.status != "RUNNING":
                return
            if nr.heartbeat_at is not None and nr.heartbeat_at >= stale_before:
                return
            nr.status = "FAILED"
            nr.error = "Worker heartbeat lost (worker crashed or was restarted)"
            nr.finished_at = now()
            emit(session, run, "node.failed", node_id=nr.node_id, node_run_id=nr.id,
                 data={"status": "FAILED", "error": nr.error, "iteration": nr.iteration, "attempt": nr.attempt})
            await self.engine.node_finished(session, run, str(nr.id))
            await commit_and_publish(session, self.bus)

    async def _requeue(self, run_id: uuid.UUID, node_run_id: uuid.UUID) -> None:
        async with self.sessions() as session:
            run = await lock_run(session, run_id)
            nr = await session.get(NodeRun, node_run_id, with_for_update=True, populate_existing=True)
            if run is None or nr is None or nr.status != "QUEUED":
                return
            nr.queued_at = now()
            ctx = await self.engine.load(session, run)
            session.info.setdefault("tasks", []).append(self.engine.build_task(ctx, nr))
            log.info("re-dispatching queued task", extra={"task_id": str(nr.id)})
            await commit_and_publish(session, self.bus)

    async def recover_on_startup(self) -> None:
        """Re-dispatch work that may have been in flight when the platform stopped."""
        counts = await self.sweep()
        async with self.sessions() as session:
            queued = (await session.execute(
                select(NodeRun.run_id, NodeRun.id).join(WorkflowRun, WorkflowRun.id == NodeRun.run_id)
                .where(NodeRun.status == "QUEUED", WorkflowRun.status.in_(["RUNNING", "WAITING_APPROVAL"]))
            )).all()
            unrouted = (await session.execute(
                select(NodeRun.run_id, NodeRun.id).join(WorkflowRun, WorkflowRun.id == NodeRun.run_id)
                .where(NodeRun.status.in_(["COMPLETED", "FAILED"]), NodeRun.routed.is_(False),
                       WorkflowRun.status.in_(["RUNNING", "WAITING_APPROVAL"]))
            )).all()
        for run_id, node_run_id in queued:
            await self._requeue(run_id, node_run_id)
        for run_id, node_run_id in unrouted:
            await self.handle(OrchestratorCommand(type="node.finished", run_id=str(run_id),
                                                  node_run_id=str(node_run_id), correlation_id=str(run_id)).model_dump())
        log.info("startup recovery complete",
                 extra={**counts, "requeued_on_start": len(queued), "rerouted": len(unrouted)})


async def main() -> None:
    settings = get_settings()
    configure_logging("agentic-orchestrator", settings.log_level)
    import aio_pika

    bus = RabbitRedisBus()
    orchestrator = Orchestrator(bus)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    health = Path("/tmp/orchestrator-healthy")

    while True:
        try:
            await bus.connect()
            break
        except Exception as exc:
            log.warning("waiting for RabbitMQ", extra={"error": str(exc)})
            await asyncio.sleep(3)

    await orchestrator.recover_on_startup()
    connection = await aio_pika.connect_robust(settings.rabbitmq_url)
    channel = await connection.channel()
    await channel.set_qos(prefetch_count=16)
    queue = await channel.declare_queue(settings.orchestrator_queue, durable=True)

    async def on_message(message: aio_pika.abc.AbstractIncomingMessage) -> None:
        try:
            await orchestrator.handle(json.loads(message.body))
            await message.ack()
        except Exception:
            log.exception("command failed; requeueing")
            await asyncio.sleep(1)
            await message.nack(requeue=True)

    tag = await queue.consume(on_message)
    log.info("orchestrator started")
    lock_key = "orchestrator:sweeper"
    while not stop.is_set():
        health.write_text(now().isoformat())
        try:
            if await bus.redis.set(lock_key, "1", nx=True, ex=10):
                try:
                    counts = await orchestrator.sweep()
                    if any(counts.values()):
                        log.info("sweep", extra=counts)
                finally:
                    await bus.redis.delete(lock_key)
        except Exception:
            log.exception("sweep failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.sweep_interval_seconds)
        except TimeoutError:
            pass
    await queue.cancel(tag)
    await connection.close()
    await bus.close()
    await dispose_engine()


if __name__ == "__main__":
    asyncio.run(main())
