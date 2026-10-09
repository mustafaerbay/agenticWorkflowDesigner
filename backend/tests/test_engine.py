"""Engine behaviour against a real PostgreSQL database, the real sandbox (in-process)
and the real worker/orchestrator classes. Only the message transport is in-memory."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select, update

from app.api.routes_workflows import current_definition, create_workflow
from app.models import Approval, ExecutionEvent, NodeRun, WorkflowRun
from app.orchestration.engine import Engine
from app.orchestration.events import commit_and_publish, lock_run
from app.services.execution import create_run
from tests.conftest import drain, edge, make_user, node, scripted_agent

LIST = [{"tool": "list_files", "args": {}}]


async def start_run(sessions, bus, definition: dict[str, Any], run_input: dict[str, Any] | None = None) -> str:
    user = await make_user(sessions)
    async with sessions() as session:
        workflow = await create_workflow(session, user, f"wf-{uuid.uuid4().hex[:6]}", "", definition)
        await session.flush()
        version = await current_definition(session, workflow)
        run = await create_run(session, workflow, version, run_input or {}, user.id)
        await commit_and_publish(session, bus)
        return str(run.id)


async def get_run(sessions, run_id: str) -> tuple[WorkflowRun, list[NodeRun]]:
    async with sessions() as session:
        run = await session.get(WorkflowRun, uuid.UUID(run_id))
        nrs = (await session.execute(select(NodeRun).where(NodeRun.run_id == run.id).order_by(NodeRun.created_at))).scalars().all()
        return run, list(nrs)


def statuses(nrs: list[NodeRun]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for nr in nrs:
        out.setdefault(nr.node_id, []).append(nr.status)
    return out


def branch_wf(rule: dict[str, Any]) -> dict[str, Any]:
    return {
        "nodes": [
            node("start", "start"),
            scripted_agent("agent", [{"tool": "write_file", "args": {"path": "x.txt", "content": "hi"}}], ["write_file"]),
            node("check", "condition", {"branches": [{"handle": "yes", "rule": rule}], "default_handle": "no"}),
            node("end", "end"),
            node("failed", "fail", {"message": "took the no branch"}),
        ],
        "edges": [edge("start", "agent"), edge("agent", "check"), edge("check", "end", "yes"), edge("check", "failed", "no")],
    }


async def test_agent_output_drives_true_branch(sessions, bus, orchestrator, worker):
    rule = {"op": "is_true", "left": {"ref": "agent.output.success"}}
    run_id = await start_run(sessions, bus, branch_wf(rule))
    await drain(bus, orchestrator, worker)
    run, nrs = await get_run(sessions, run_id)
    assert run.status == "COMPLETED", run.error
    by_node = {nr.node_id: nr for nr in nrs}
    assert by_node["agent"].output["deterministic"] is True
    assert by_node["agent"].tool_calls[0]["tool"] == "write_file"
    assert by_node["check"].selected_handle == "yes"
    assert "failed" not in by_node or by_node["failed"].status == "SKIPPED"


async def test_false_branch_fails_workflow(sessions, bus, orchestrator, worker):
    rule = {"op": "eq", "left": {"ref": "agent.output.success"}, "right": {"value": False}}
    run_id = await start_run(sessions, bus, branch_wf(rule))
    await drain(bus, orchestrator, worker)
    run, nrs = await get_run(sessions, run_id)
    assert run.status == "FAILED"
    assert run.error == "took the no branch"
    assert {nr.node_id: nr.selected_handle for nr in nrs}["check"] == "no"


async def test_bounded_loop_exits_via_condition(sessions, bus, orchestrator, worker):
    rule = {"op": "lt", "left": {"ref": "work.runs"}, "right": {"value": 3}}
    wf = {
        "nodes": [node("start", "start"), scripted_agent("work", LIST, ["list_files"]),
                  node("again", "condition", {"branches": [{"handle": "loop", "rule": rule}], "default_handle": "done"}),
                  node("end", "end")],
        "edges": [edge("start", "work"), edge("work", "again"), edge("again", "work", "loop"), edge("again", "end", "done")],
    }
    run_id = await start_run(sessions, bus, wf)
    await drain(bus, orchestrator, worker)
    run, nrs = await get_run(sessions, run_id)
    assert run.status == "COMPLETED"
    assert statuses(nrs)["work"] == ["COMPLETED"] * 3
    assert [nr.selected_handle for nr in nrs if nr.node_id == "again"] == ["loop", "loop", "done"]


async def test_loop_limit_stops_runaway_loop(sessions, bus, orchestrator, worker):
    always = {"op": "exists", "left": {"ref": "work.output.success"}}
    wf = {
        "nodes": [node("start", "start"), scripted_agent("work", LIST, ["list_files"]),
                  node("again", "condition", {"branches": [{"handle": "loop", "rule": always}], "default_handle": "done"}),
                  node("end", "end")],
        "edges": [edge("start", "work"), edge("work", "again"), edge("again", "work", "loop"), edge("again", "end", "done")],
        "settings": {"max_loop_iterations": 4},
    }
    run_id = await start_run(sessions, bus, wf)
    await drain(bus, orchestrator, worker)
    run, nrs = await get_run(sessions, run_id)
    assert run.status == "FAILED"
    assert run.error.startswith("limit_exceeded")
    assert statuses(nrs)["work"].count("COMPLETED") == 4


async def test_parallel_join_all_and_skipped_branch(sessions, bus, orchestrator, worker):
    never = {"op": "exists", "left": {"ref": "input.never_set"}}
    wf = {
        "nodes": [
            node("start", "start"), node("fork", "parallel"),
            scripted_agent("a", LIST, ["list_files"]), scripted_agent("b", LIST, ["list_files"]),
            node("gate", "condition", {"branches": [{"handle": "go", "rule": never}], "default_handle": "skip"}),
            scripted_agent("c", LIST, ["list_files"]),
            node("join", "join", {"mode": "all"}), node("end", "end"),
        ],
        "edges": [
            edge("start", "fork"), edge("fork", "a"), edge("fork", "b"), edge("fork", "gate"),
            edge("gate", "c", "go"), edge("gate", "join", "skip"),
            edge("a", "join"), edge("b", "join"), edge("c", "join"), edge("join", "end"),
        ],
    }
    run_id = await start_run(sessions, bus, wf)
    # Both parallel branches must be dispatched before either completes.
    await orchestrator.handle(bus.commands.pop(0))
    assert sorted(t["node_id"] for t in bus.tasks) == ["a", "b"]
    await drain(bus, orchestrator, worker)
    run, nrs = await get_run(sessions, run_id)
    assert run.status == "COMPLETED", run.error
    s = statuses(nrs)
    assert s["c"] == ["SKIPPED"]
    assert s["join"] == ["COMPLETED"]  # fired exactly once


async def test_join_any_fires_once(sessions, bus, orchestrator, worker):
    wf = {
        "nodes": [node("start", "start"), node("fork", "parallel"),
                  scripted_agent("a", LIST, ["list_files"]), scripted_agent("b", LIST, ["list_files"]),
                  node("join", "join", {"mode": "any"}), scripted_agent("after", LIST, ["list_files"]), node("end", "end")],
        "edges": [edge("start", "fork"), edge("fork", "a"), edge("fork", "b"), edge("a", "join"), edge("b", "join"),
                  edge("join", "after"), edge("after", "end")],
    }
    run_id = await start_run(sessions, bus, wf)
    await drain(bus, orchestrator, worker)
    run, nrs = await get_run(sessions, run_id)
    assert run.status == "COMPLETED"
    assert statuses(nrs)["after"] == ["COMPLETED"]


async def test_retry_policy_bounded(sessions, bus, orchestrator, worker):
    wf = {
        "nodes": [node("start", "start"),
                  node("broken", "tool", {"tool": "read_file", "args": {"path": "does-not-exist.txt"},
                                          "retry": {"max_attempts": 3, "backoff_seconds": 0}}),
                  node("end", "end")],
        "edges": [edge("start", "broken"), edge("broken", "end")],
    }
    run_id = await start_run(sessions, bus, wf)
    await drain(bus, orchestrator, worker)
    run, nrs = await get_run(sessions, run_id)
    assert run.status == "FAILED"
    attempts = [(nr.attempt, nr.status) for nr in nrs if nr.node_id == "broken"]
    assert attempts == [(1, "FAILED"), (2, "FAILED"), (3, "FAILED")]
    assert "after 3 attempt" in run.error


async def test_duplicate_task_and_result_delivery_is_idempotent(sessions, bus, orchestrator, worker):
    wf = {"nodes": [node("start", "start"), scripted_agent("a", LIST, ["list_files"]), node("end", "end")],
          "edges": [edge("start", "a"), edge("a", "end")]}
    run_id = await start_run(sessions, bus, wf)
    await orchestrator.handle(bus.commands.pop(0))
    task = bus.tasks.pop(0)
    assert await worker.process(task) == "COMPLETED"
    assert await worker.process(task) == "skipped"  # redelivery is dropped
    finished = bus.commands.pop(0)
    await orchestrator.handle(finished)
    await orchestrator.handle(finished)  # duplicate result message
    run, nrs = await get_run(sessions, run_id)
    assert run.status == "COMPLETED"
    assert statuses(nrs) == {"start": ["COMPLETED"], "a": ["COMPLETED"], "end": ["COMPLETED"]}


async def test_pause_and_resume(sessions, bus, orchestrator, worker):
    wf = {"nodes": [node("start", "start"), scripted_agent("a", LIST, ["list_files"]),
                    scripted_agent("b", LIST, ["list_files"]), node("end", "end")],
          "edges": [edge("start", "a"), edge("a", "b"), edge("b", "end")]}
    run_id = await start_run(sessions, bus, wf)
    await orchestrator.handle(bus.commands.pop(0))
    engine = Engine()
    async with sessions() as session:
        run = await lock_run(session, run_id)
        assert await engine.pause(session, run)
        await commit_and_publish(session, bus)
    await drain(bus, orchestrator, worker)  # in-flight 'a' finishes, 'b' must not start
    run, nrs = await get_run(sessions, run_id)
    assert run.status == "PAUSED"
    assert statuses(nrs)["b"] == ["PENDING"]  # activated but not dispatched while paused
    assert bus.tasks == []
    async with sessions() as session:
        run = await lock_run(session, run_id)
        assert await engine.resume(session, run)
        await commit_and_publish(session, bus)
    await drain(bus, orchestrator, worker)
    run, nrs = await get_run(sessions, run_id)
    assert run.status == "COMPLETED"
    assert statuses(nrs)["b"] == ["COMPLETED"]


async def approval_wf() -> dict[str, Any]:
    return {"nodes": [node("start", "start"), node("gate", "approval", {"title": "Ship it?"}),
                      node("end", "end"), node("rejected", "fail", {"message": "rejected"})],
            "edges": [edge("start", "gate"), edge("gate", "end", "approved"), edge("gate", "rejected", "rejected")]}


async def test_human_approval_pauses_and_resumes(sessions, bus, orchestrator, worker):
    run_id = await start_run(sessions, bus, await approval_wf())
    await drain(bus, orchestrator, worker)
    run, _ = await get_run(sessions, run_id)
    assert run.status == "WAITING_APPROVAL"
    user = await make_user(sessions)
    async with sessions() as session:
        run = await lock_run(session, run_id)
        approval = (await session.execute(select(Approval).where(Approval.run_id == run.id))).scalar_one()
        await Engine().decide_approval(session, run, approval, True, user.id, user.email, "lgtm")
        await commit_and_publish(session, bus)
    await drain(bus, orchestrator, worker)
    run, nrs = await get_run(sessions, run_id)
    assert run.status == "COMPLETED"
    gate = next(nr for nr in nrs if nr.node_id == "gate")
    assert gate.output["approved"] is True and gate.selected_handle == "approved"


async def test_rejection_takes_rejected_branch(sessions, bus, orchestrator, worker):
    run_id = await start_run(sessions, bus, await approval_wf())
    await drain(bus, orchestrator, worker)
    user = await make_user(sessions)
    async with sessions() as session:
        run = await lock_run(session, run_id)
        approval = (await session.execute(select(Approval).where(Approval.run_id == run.id))).scalar_one()
        await Engine().decide_approval(session, run, approval, False, user.id, user.email, "no")
        await commit_and_publish(session, bus)
    await drain(bus, orchestrator, worker)
    run, _ = await get_run(sessions, run_id)
    assert run.status == "FAILED" and run.error == "rejected"


async def test_cancel_drops_queued_tasks(sessions, bus, orchestrator, worker):
    wf = {"nodes": [node("start", "start"), scripted_agent("a", LIST, ["list_files"]), node("end", "end")],
          "edges": [edge("start", "a"), edge("a", "end")]}
    run_id = await start_run(sessions, bus, wf)
    await orchestrator.handle(bus.commands.pop(0))
    async with sessions() as session:
        run = await lock_run(session, run_id)
        await Engine().cancel(session, run)
        await commit_and_publish(session, bus)
    assert await worker.process(bus.tasks.pop(0)) == "skipped"
    run, nrs = await get_run(sessions, run_id)
    assert run.status == "CANCELLED"
    assert statuses(nrs)["a"] == ["CANCELLED"]


async def test_event_sequence_is_contiguous(sessions, bus, orchestrator, worker):
    rule = {"op": "is_true", "left": {"ref": "agent.output.success"}}
    run_id = await start_run(sessions, bus, branch_wf(rule))
    await drain(bus, orchestrator, worker)
    async with sessions() as session:
        seqs = (await session.execute(
            select(ExecutionEvent.seq).where(ExecutionEvent.run_id == uuid.UUID(run_id)).order_by(ExecutionEvent.id)
        )).scalars().all()
        types = (await session.execute(
            select(ExecutionEvent.type).where(ExecutionEvent.run_id == uuid.UUID(run_id)).order_by(ExecutionEvent.seq)
        )).scalars().all()
    assert seqs == list(range(1, len(seqs) + 1))
    assert types[0] == "workflow.started" and types[-1] == "workflow.completed"
    published = [e["seq"] for e in bus.events if e["run_id"] == run_id]
    assert published == seqs  # every persisted event was pushed live, in order
    assert {"node.queued", "node.started", "node.progress", "node.completed", "edge.traversed"} <= set(types)


async def test_recovery_redispatches_lost_task_and_stale_worker(sessions, bus, orchestrator, worker):
    wf = {"nodes": [node("start", "start"), scripted_agent("a", LIST, ["list_files"],
                                                           retry={"max_attempts": 2, "backoff_seconds": 0}),
                    node("end", "end")],
          "edges": [edge("start", "a"), edge("a", "end")]}
    run_id = await start_run(sessions, bus, wf)
    await orchestrator.handle(bus.commands.pop(0))
    bus.tasks.clear()  # simulate the broker losing the message during a restart
    await orchestrator.recover_on_startup()
    assert len(bus.tasks) == 1
    # Simulate a worker that claimed the task and then died (stale heartbeat).
    async with sessions() as session:
        await session.execute(update(NodeRun).where(NodeRun.node_id == "a").values(
            status="RUNNING", claimed_by="dead-worker", heartbeat_at=datetime.now(UTC) - timedelta(hours=1)))
        await session.commit()
    bus.tasks.clear()
    await orchestrator.sweep()
    await drain(bus, orchestrator, worker)
    run, nrs = await get_run(sessions, run_id)
    assert run.status == "COMPLETED"
    attempts = [(nr.attempt, nr.status) for nr in nrs if nr.node_id == "a"]
    assert attempts == [(1, "FAILED"), (2, "COMPLETED")]
    assert "heartbeat" in next(nr for nr in nrs if nr.node_id == "a" and nr.attempt == 1).error
