"""End-to-end smoke test against a running stack, through the public web entry point.

Runs inside the backend image on the Compose network (see scripts/smoke-workflow.sh):
  SMOKE_BASE_URL=http://web:8080 python -m scripts.smoke_workflow

Every agent used here is a *scripted deterministic test agent (no LLM)*; tests,
file edits, branching, events and persistence are real.
"""

import asyncio
import json
import os
import sys
import time
import uuid
from typing import Any

import asyncpg
import httpx
from websockets.asyncio.client import connect

BASE = os.environ.get("SMOKE_BASE_URL", "http://web:8080").rstrip("/")
WS_BASE = BASE.replace("http://", "ws://").replace("https://", "wss://")
EMAIL = os.environ["ADMIN_EMAIL"]
PASSWORD = os.environ["ADMIN_PASSWORD"]
TIMEOUT = float(os.environ.get("SMOKE_TIMEOUT", "180"))
TAG = f"smoke-{uuid.uuid4().hex[:6]}"
FIXED = (
    "def add(a, b):\n    return a + b\n\n\ndef subtract(a, b):\n    return a - b\n\n\n"
    "def multiply(a, b):\n    return a * b\n\n\ndef divide(a, b):\n    if b == 0:\n"
    "        raise ValueError(\"division by zero\")\n    return a / b\n"
)

results: list[dict[str, Any]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append({"check": name, "result": "PASS" if ok else "FAIL", "detail": detail})
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)
    return ok


def n(id_: str, type_: str, label: str, config: dict[str, Any] | None = None, x: int = 0, y: int = 0) -> dict[str, Any]:
    return {"id": id_, "type": type_, "position": {"x": x, "y": y}, "data": {"label": label, "config": config or {}}}


def e(source: str, target: str, handle: str = "out") -> dict[str, Any]:
    return {"id": f"{source}-{handle}-{target}", "source": source, "target": target, "sourceHandle": handle, "targetHandle": "in"}


def test_and_fix_workflow() -> dict[str, Any]:
    """Start → test agent → condition → (pass) End | (fix) fixer → loop | (else) Fail."""
    passed = {"op": "is_true", "left": {"ref": "tester.output.last_result.tests_passed"}}
    fix = {"op": "and", "rules": [
        {"op": "lt", "left": {"ref": "fixer.runs"}, "right": {"value": 1}},
        {"op": "not", "rule": {"op": "is_true", "left": {"ref": "input.no_fix"}}},
    ]}
    return {
        "nodes": [
            n("start", "start", "Start", {"default_input": {"workspace_template": "sample-calculator"}}, 0, 100),
            n("tester", "agent", "Deterministic test agent (no LLM)",
              {"kind": "scripted", "tools": ["run_tests"], "steps": [{"tool": "run_tests", "args": {}}]}, 250, 100),
            n("check", "condition", "Tests passed?", {"branches": [
                {"handle": "pass", "label": "Pass", "rule": passed},
                {"handle": "fix", "label": "Fix once", "rule": fix}], "default_handle": "give_up"}, 500, 100),
            n("fixer", "agent", "Deterministic fixer (no LLM)",
              {"kind": "scripted", "tools": ["write_file"],
               "steps": [{"tool": "write_file", "args": {"path": "calculator.py", "content": FIXED}}]}, 500, 300),
            n("end", "end", "End", {}, 750, 100),
            n("failed", "fail", "Fail", {"message": "tests failed and no fix allowed"}, 750, 300),
        ],
        "edges": [e("start", "tester"), e("tester", "check"), e("check", "end", "pass"), e("check", "fixer", "fix"),
                  e("check", "failed", "give_up"), e("fixer", "tester")],
        "settings": {"max_loop_iterations": 3, "max_total_steps": 30, "max_duration_seconds": 600},
    }


def runaway_workflow() -> dict[str, Any]:
    always = {"op": "exists", "left": {"ref": "work.output.success"}}
    return {
        "nodes": [n("start", "start", "Start"),
                  n("work", "agent", "Deterministic agent (no LLM)",
                    {"kind": "scripted", "tools": ["list_files"], "steps": [{"tool": "list_files", "args": {}}]}),
                  n("again", "condition", "Loop?", {"branches": [{"handle": "loop", "rule": always}], "default_handle": "done"}),
                  n("end", "end", "End")],
        "edges": [e("start", "work"), e("work", "again"), e("again", "work", "loop"), e("again", "end", "done")],
        "settings": {"max_loop_iterations": 3},
    }


def delay_workflow(seconds: int) -> dict[str, Any]:
    return {"nodes": [n("start", "start", "Start"), n("wait", "delay", "Wait", {"seconds": seconds}), n("end", "end", "End")],
            "edges": [e("start", "wait"), e("wait", "end")]}


class Client:
    def __init__(self) -> None:
        self.http = httpx.AsyncClient(base_url=BASE, timeout=30)
        self.token = ""
        self.created: list[str] = []

    async def login(self) -> None:
        r = await self.http.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
        r.raise_for_status()
        self.token = r.json()["access_token"]
        self.http.headers["Authorization"] = f"Bearer {self.token}"

    async def create(self, name: str, definition: dict[str, Any]) -> dict[str, Any]:
        r = await self.http.post("/api/workflows", json={"name": f"{TAG} {name}", "definition": definition})
        r.raise_for_status()
        self.created.append(r.json()["id"])
        return r.json()

    async def execute(self, wf_id: str, run_input: dict[str, Any]) -> dict[str, Any]:
        r = await self.http.post(f"/api/workflows/{wf_id}/execute", json={"input": run_input})
        r.raise_for_status()
        return r.json()

    async def run(self, run_id: str) -> dict[str, Any]:
        r = await self.http.get(f"/api/executions/{run_id}")
        r.raise_for_status()
        return r.json()

    async def wait(self, run_id: str, states: set[str], timeout: float = TIMEOUT) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            run = await self.run(run_id)
            if run["status"] in states:
                return run
            await asyncio.sleep(0.5)
        return await self.run(run_id)


async def stream_events(run_id: str, token: str, stop_types: set[str], timeout: float = TIMEOUT) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    async with connect(f"{WS_BASE}/api/executions/{run_id}/stream?token={token}&after=0", open_timeout=15) as ws:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                message = json.loads(await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.monotonic())))
            except TimeoutError:
                break
            if message.get("type") == "event":
                events.append(message["event"])
                if message["event"]["type"] in stop_types:
                    break
    return events


async def db_counts(run_id: str) -> dict[str, int]:
    dsn = os.environ["DATABASE_URL"].replace("postgresql+asyncpg", "postgresql")
    conn = await asyncpg.connect(dsn)
    try:
        rid = uuid.UUID(run_id)
        return {
            "workflow_runs": await conn.fetchval("SELECT count(*) FROM workflow_runs WHERE id=$1", rid),
            "node_runs": await conn.fetchval("SELECT count(*) FROM node_runs WHERE run_id=$1", rid),
            "execution_events": await conn.fetchval("SELECT count(*) FROM execution_events WHERE run_id=$1", rid),
        }
    finally:
        await conn.close()


async def business_flow(c: "Client") -> None:
    password = uuid.uuid4().hex
    users = {"clerk": ["member", "builder"], "approver": ["approver"]}
    created_users: list[str] = []
    headers: dict[str, dict[str, str]] = {}
    try:
        for name, roles in users.items():
            email = f"{TAG}-{name}@smoke.invalid"
            r = await c.http.post("/api/users", json={"email": email, "name": f"{TAG} {name}", "password": password,
                                                      "role": "editor",
                                                      "memberships": [{"department": "finance", "roles": roles}]})
            r.raise_for_status()
            created_users.append(r.json()["id"])
            token = (await c.http.post("/api/auth/login", json={"email": email, "password": password})).json()["access_token"]
            headers[name] = {"Authorization": f"Bearer {token}"}
        clerk, approver = headers["clerk"], headers["approver"]
        templates = (await c.http.get("/api/templates", headers=clerk)).json()
        check("14 department templates available", len(templates) == 14, f"{len(templates)} templates")
        wf = (await c.http.post("/api/templates/finance_invoice/use", json={"name": f"{TAG} invoice"}, headers=clerk)).json()
        c.created.append(wf["id"])
        check("template creates a draft business workflow", wf.get("status") == "draft" and wf.get("has_plan") is True,
              f"status={wf.get('status')} meta={wf.get('plan_meta')}")
        invoice = b"Supplier: ACME\nInvoice number: INV-1\nIBAN: DE00 1234\nTotal: 20,000.00\n"
        r = await c.http.post("/api/files", files={"file": ("invoice.txt", invoice, "text/plain")},
                              data={"department": "finance"}, headers=clerk)
        r.raise_for_status()
        file_id = r.json()["id"]
        run_input = {"invoice": file_id, "amount": 20000, "supplier": "ACME"}
        blocked = await c.http.post(f"/api/workflows/{wf['id']}/execute", json={"input": run_input}, headers=clerk)
        check("draft workflows cannot run before enabling", blocked.status_code == 409, f"HTTP {blocked.status_code}")
        sim = (await c.http.post(f"/api/workflows/{wf['id']}/simulate", json={"input": run_input}, headers=clerk)).json()
        sim = await c.wait(sim["id"], {"COMPLETED", "FAILED", "CANCELLED"})
        nodes = {nr["node_id"]: nr for nr in sim["node_runs"]}
        check("simulation reads the real invoice and takes the large-amount branch",
              sim["status"] == "COMPLETED" and nodes["check_invoice"]["output"].get("all_present") is True
              and nodes["large_amount"]["selected_handle"] == "large",
              f"{sim['status']} {sim.get('error') or ''}")
        check("simulation performs no side effects", nodes["notify_payables"]["output"].get("_simulated") is True
              and (await c.http.get("/api/inbox", headers=clerk)).json() == [])
        enabled = (await c.http.post(f"/api/workflows/{wf['id']}/enable", json={"acknowledgements": []}, headers=clerk)).json()
        check("workflow enabled", enabled.get("status") == "enabled", str(enabled.get("status")))
        run = (await c.http.post(f"/api/workflows/{wf['id']}/execute", json={"input": run_input}, headers=clerk)).json()
        waiting = await c.wait(run["id"], {"WAITING_APPROVAL", "COMPLETED", "FAILED", "CANCELLED"})
        approval = next(a for a in (await c.http.get("/api/approvals?status=pending", headers=approver)).json()
                        if a["run_id"] == run["id"])
        self_approve = await c.http.post(f"/api/approvals/{approval['id']}/decision", json={"decision": "approve"},
                                         headers=clerk)
        check("separation of duties blocks self-approval", waiting["status"] == "WAITING_APPROVAL"
              and self_approve.status_code == 403, f"HTTP {self_approve.status_code}")
        await c.http.post(f"/api/approvals/{approval['id']}/decision", json={"decision": "approve"}, headers=approver)
        final = await c.wait(run["id"], {"COMPLETED", "FAILED", "CANCELLED"})
        inbox = (await c.http.get("/api/inbox", headers=clerk)).json()
        check("approved business run completes and assigns the payables task",
              final["status"] == "COMPLETED" and any("ACME" in i["title"] for i in inbox),
              f"{final['status']} {final.get('error') or ''}")
    finally:
        for user_id in created_users:  # deactivate smoke users (kept for the audit trail)
            await c.http.put(f"/api/users/{user_id}", json={"is_active": False})


async def main() -> int:
    c = Client()
    try:
        r = await c.http.get("/api/ready")
        check("web→api proxy and readiness", r.status_code == 200 and r.json()["status"] == "ready", r.text[:200])
        r = await c.http.get("/")
        check("web serves SPA", r.status_code == 200 and "<div id=\"root\"" in r.text, f"HTTP {r.status_code}")
        unauth = await c.http.get("/api/workflows")
        check("API rejects unauthenticated requests", unauth.status_code == 401, f"HTTP {unauth.status_code}")
        await c.login()
        check("login", bool(c.token))

        # 1. Create, persist, validate.
        wf = await c.create("test-and-fix", test_and_fix_workflow())
        validation = (await c.http.post(f"/api/workflows/{wf['id']}/validate")).json()
        check("workflow saved and valid", validation["valid"], json.dumps(validation["errors"])[:300])
        reloaded = (await c.http.get(f"/api/workflows/{wf['id']}")).json()
        check("workflow reopens with same definition", reloaded["definition"] == test_and_fix_workflow())

        # 2. Success path with bounded fix loop, observed live over WebSocket.
        run = await c.execute(wf["id"], {"workspace_template": "sample-calculator"})
        ws_task = asyncio.create_task(stream_events(run["id"], c.token, {"workflow.completed", "workflow.failed"}))
        final = await c.wait(run["id"], {"COMPLETED", "FAILED", "CANCELLED"})
        ws_events = await ws_task
        check("success path reaches COMPLETED", final["status"] == "COMPLETED", final.get("error") or "")
        tester_runs = [nr for nr in final["node_runs"] if nr["node_id"] == "tester"]
        outcomes = [nr["output"]["last_result"]["tests_passed"] for nr in tester_runs if nr["output"]]
        check("agent really ran pytest (fail → fix → pass)", outcomes == [False, True], f"tests_passed per run: {outcomes}")
        handles = [nr["selected_handle"] for nr in final["node_runs"] if nr["node_id"] == "check"]
        check("condition chose branches from recorded output", handles == ["fix", "pass"], f"{handles}")
        check("agent runs labelled scripted (no LLM)", all(nr["agent_kind"] == "scripted" for nr in tester_runs))
        api_events = (await c.http.get(f"/api/executions/{run['id']}/events?after=0")).json()
        ws_seqs = [ev["seq"] for ev in ws_events]
        check("WebSocket delivered ordered events matching persisted log",
              ws_seqs == [ev["seq"] for ev in api_events][: len(ws_seqs)] and ws_seqs == list(range(1, len(ws_seqs) + 1))
              and bool(ws_events) and ws_events[-1]["type"] == "workflow.completed",
              f"{len(ws_events)} ws events, {len(api_events)} persisted")
        check("edge traversal events streamed", any(ev["type"] == "edge.traversed" for ev in ws_events))
        resumed = await stream_events(run["id"], c.token, set(), timeout=3)
        check("WebSocket replay from seq 0 after reconnect", [ev["seq"] for ev in resumed] == [ev["seq"] for ev in api_events])
        counts = await db_counts(run["id"])
        check("run, node runs and events persisted in PostgreSQL",
              counts["workflow_runs"] == 1 and counts["node_runs"] == len(final["node_runs"])
              and counts["execution_events"] == len(api_events), json.dumps(counts))

        # 3. Failing branch (controlled failure).
        run = await c.execute(wf["id"], {"workspace_template": "sample-calculator", "no_fix": True})
        final = await c.wait(run["id"], {"COMPLETED", "FAILED", "CANCELLED"})
        handles = [nr["selected_handle"] for nr in final["node_runs"] if nr["node_id"] == "check"]
        check("failing branch reaches controlled FAILED", final["status"] == "FAILED" and handles == ["give_up"],
              f"{final['status']} {handles} {final.get('error')}")

        # 4. Loop bound.
        loop_wf = await c.create("runaway-loop", runaway_workflow())
        run = await c.execute(loop_wf["id"], {})
        final = await c.wait(run["id"], {"COMPLETED", "FAILED", "CANCELLED"})
        work_runs = [nr for nr in final["node_runs"] if nr["node_id"] == "work"]
        check("runaway loop stopped at max_loop_iterations=3",
              final["status"] == "FAILED" and (final.get("error") or "").startswith("limit_exceeded") and len(work_runs) == 3,
              f"{final['status']} runs={len(work_runs)} {final.get('error')}")

        # 5. Pause / resume and cancel.
        delay_wf = await c.create("delay", delay_workflow(4))
        run = await c.execute(delay_wf["id"], {})
        await c.wait(run["id"], {"RUNNING"}, timeout=20)
        paused = (await c.http.post(f"/api/executions/{run['id']}/pause")).json()
        resumed_run = (await c.http.post(f"/api/executions/{run['id']}/resume")).json()
        final = await c.wait(run["id"], {"COMPLETED", "FAILED", "CANCELLED"}, timeout=30)
        check("pause then resume completes", paused["status"] == "PAUSED" and resumed_run["status"] == "RUNNING"
              and final["status"] == "COMPLETED", f"{paused['status']} → {resumed_run['status']} → {final['status']}")
        long_wf = await c.create("long-delay", delay_workflow(600))
        run = await c.execute(long_wf["id"], {})
        await c.wait(run["id"], {"RUNNING"}, timeout=20)
        cancelled = (await c.http.post(f"/api/executions/{run['id']}/cancel")).json()
        check("cancel stops a running workflow", cancelled["status"] == "CANCELLED")

        # 6. Bundled deterministic SDLC pipeline incl. human approval and artifacts.
        workflows = (await c.http.get("/api/workflows")).json()
        demo = next((w for w in workflows if w["name"].startswith("Autonomous Development Pipeline (deterministic")), None)
        if check("bundled deterministic SDLC example present", demo is not None):
            definition = (await c.http.get(f"/api/workflows/{demo['id']}")).json()["definition"]
            start = next(x for x in definition["nodes"] if x["type"] == "start")
            run = await c.execute(demo["id"], start["data"]["config"]["default_input"])
            waiting = await c.wait(run["id"], {"WAITING_APPROVAL", "COMPLETED", "FAILED", "CANCELLED"})
            check("pipeline pauses for human approval", waiting["status"] == "WAITING_APPROVAL", waiting.get("error") or "")
            approvals = (await c.http.get("/api/approvals?status=pending")).json()
            mine = [a for a in approvals if a["run_id"] == run["id"]]
            if mine:
                await c.http.post(f"/api/approvals/{mine[0]['id']}/decision", json={"decision": "approve", "comment": TAG})
            final = await c.wait(run["id"], {"COMPLETED", "FAILED", "CANCELLED"})
            kinds = sorted(a["kind"] for a in final.get("artifacts", []))
            check("pipeline completes after approval with patch + report", final["status"] == "COMPLETED" and kinds == ["patch", "report"],
                  f"{final['status']} artifacts={kinds} {final.get('error') or ''}")
        # 7. Business workflow: template -> simulate (no side effects) -> enable -> run -> approval (SoD).
        await business_flow(c)
    except Exception as exc:  # report, don't hide
        check("smoke test crashed", False, f"{type(exc).__name__}: {exc}")
    finally:
        for wf_id in c.created:
            try:
                await c.http.delete(f"/api/workflows/{wf_id}")
            except Exception:
                pass
        await c.http.aclose()

    failed = [r for r in results if r["result"] == "FAIL"]
    print(json.dumps({"tag": TAG, "passed": len(results) - len(failed), "failed": len(failed)}))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
