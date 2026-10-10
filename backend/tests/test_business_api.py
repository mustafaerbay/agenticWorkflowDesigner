"""Business workflows end to end through the API, orchestrator, worker and sandbox:
templates, simulation, enabling, real runs, approvals with separation of duties,
department access, visual edits, execution isolation and the runtime approval guard."""

import copy
import smtplib
import uuid
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.main import app
from app.models import InboxItem, User, WorkflowRun
from app.services.seed import seed
from tests.conftest import drain

ADMIN = ("admin@test.local", "admin-password-for-tests")
PASSWORD = "password-1234567"


@pytest.fixture
async def api(sessions, bus):
    app.state.bus = bus
    async with sessions() as session:
        await seed(session)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client


async def login(api, email: str, password: str) -> dict[str, str]:
    r = await api.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def make_user(api, admin, email: str, memberships: list[dict[str, Any]]) -> dict[str, str]:
    r = await api.post("/api/users", json={"email": email, "name": email.split("@")[0], "password": PASSWORD,
                                           "role": "editor", "memberships": memberships}, headers=admin)
    assert r.status_code == 201, r.text
    return await login(api, email, PASSWORD)


async def upload(api, headers, name: str, content: bytes, department: str) -> str:
    r = await api.post("/api/files", files={"file": (name, content, "text/plain")}, data={"department": department},
                       headers=headers)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def run_to_rest(api, headers, bus, orchestrator, worker, run_id: str) -> dict[str, Any]:
    await drain(bus, orchestrator, worker)
    return (await api.get(f"/api/executions/{run_id}", headers=headers)).json()


INVOICE = b"ACME Ltd\nInvoice number: INV-42\nIBAN: DE00 1234\nTotal: 20,000.00 EUR\n"


async def test_templates_catalog(api):
    admin = await login(api, *ADMIN)
    templates = (await api.get("/api/templates", headers=admin)).json()
    assert len(templates) == 14
    by_id = {t["id"]: t for t in templates}
    assert by_id["hr_leave_request"]["runs_locally"] and by_id["finance_invoice"]["runs_locally"]
    daily = by_id["ops_daily_report"]
    assert not daily["runs_locally"]
    assert {n["connector"] for n in daily["needs"]} == {"http", "llm"}
    assert all(n["status"] == "requires_connection" for n in daily["needs"])
    caps = (await api.get("/api/capabilities?department=hr", headers=admin)).json()
    assert next(c for c in caps if c["id"] == "finance.submit_payment")["status"] == "restricted"


async def test_invoice_template_simulate_enable_run_with_separation_of_duties(api, bus, orchestrator, worker, sessions):
    admin = await login(api, *ADMIN)
    builder = await make_user(api, admin, "builder@fin.test", [{"department": "finance", "roles": ["builder", "member"]}])
    approver = await make_user(api, admin, "approver@fin.test", [{"department": "finance", "roles": ["approver"]}])
    clerk = await make_user(api, admin, "clerk@fin.test", [{"department": "finance", "roles": ["member"]}])
    outsider = await make_user(api, admin, "hr@hr.test", [{"department": "hr", "roles": ["builder", "member"]}])

    wf = (await api.post("/api/templates/finance_invoice/use", json={}, headers=builder)).json()
    assert wf["status"] == "draft" and wf["has_plan"] and wf["department"] == "finance"
    assert wf["plan_meta"]["compiler_version"] and wf["explanation"]["steps"]
    # Other departments cannot see it; drafts cannot run.
    assert (await api.get(f"/api/workflows/{wf['id']}", headers=outsider)).status_code == 404
    r = await api.post(f"/api/workflows/{wf['id']}/execute", json={"input": {}}, headers=builder)
    assert r.status_code == 409

    invoice = await upload(api, builder, "invoice.txt", INVOICE, "finance")
    # Simulation: real read-only checks, no side effects, approval outcome chosen up front.
    sim = (await api.post(f"/api/workflows/{wf['id']}/simulate", json={
        "input": {"invoice": invoice, "amount": 20000, "supplier": "ACME"},
        "approvals": {"finance_manager": "approve"}}, headers=builder)).json()
    assert sim["mode"] == "simulation"
    sim = await run_to_rest(api, builder, bus, orchestrator, worker, sim["id"])
    assert sim["status"] == "COMPLETED", sim["error"]
    by_node = {nr["node_id"]: nr for nr in sim["node_runs"]}
    assert by_node["check_invoice"]["output"]["all_present"] is True and by_node["check_invoice"]["output"]["_simulated"] is False
    assert by_node["large_amount"]["selected_handle"] == "large"
    assert by_node["finance_manager"]["output"]["_simulated"] is True
    assert by_node["notify_payables"]["output"]["_simulated"] is True  # side effect not executed
    async with sessions() as session:
        assert (await session.execute(select(InboxItem))).scalars().first() is None
    assert (await api.get("/api/stats", headers=admin)).json()["runs_total"] == 0  # simulations don't count

    # Enable (no sensitive steps in this template) and run for real.
    enabled = (await api.post(f"/api/workflows/{wf['id']}/enable", json={"acknowledgements": []}, headers=builder)).json()
    assert enabled["status"] == "enabled" and enabled["enabled_version"] == 1
    r = await api.post(f"/api/workflows/{wf['id']}/execute", json={"input": {"invoice": invoice}}, headers=clerk)
    assert r.status_code == 422 and set(r.json()["detail"]["missing_inputs"]) == {"amount", "supplier"}
    run = (await api.post(f"/api/workflows/{wf['id']}/execute",
                          json={"input": {"invoice": invoice, "amount": 20000, "supplier": "ACME"}}, headers=clerk)).json()
    run = await run_to_rest(api, clerk, bus, orchestrator, worker, run["id"])
    assert run["status"] == "WAITING_APPROVAL" and run["mode"] == "real"

    pending = (await api.get("/api/approvals?status=pending", headers=clerk)).json()
    assert pending[0]["separation_of_duties"] and not pending[0]["can_decide"]
    r = await api.post(f"/api/approvals/{pending[0]['id']}/decision", json={"decision": "approve"}, headers=clerk)
    assert r.status_code == 403 and "Separation of duties" in r.json()["detail"]
    r = await api.post(f"/api/approvals/{pending[0]['id']}/decision", json={"decision": "approve"}, headers=outsider)
    assert r.status_code == 404
    r = await api.post(f"/api/approvals/{pending[0]['id']}/decision", json={"decision": "approve"}, headers=approver)
    assert r.status_code == 200, r.text
    run = await run_to_rest(api, clerk, bus, orchestrator, worker, run["id"])
    assert run["status"] == "COMPLETED", run["error"]
    async with sessions() as session:
        items = (await session.execute(select(InboxItem, User).join(User, User.id == InboxItem.user_id))).all()
    assert {u.email for _, u in items} == {"builder@fin.test", "clerk@fin.test"}  # every finance member
    assert all(i.kind == "task" for i, _ in items)


async def test_enable_requires_connections_and_acknowledgements(api):
    admin = await login(api, *ADMIN)
    hr = await make_user(api, admin, "builder@hr.test", [{"department": "hr", "roles": ["builder", "member"]}])
    wf = (await api.post("/api/templates/hr_onboarding/use", json={}, headers=hr)).json()
    steps = {s["step_id"]: s for s in wf["explanation"]["steps"]}
    assert steps["approval_before_welcome_email"]["policy_inserted"]  # policy added an approval before email
    r = await api.post(f"/api/workflows/{wf['id']}/enable", json={"acknowledgements": []}, headers=hr)
    detail = r.json()["detail"]
    assert r.status_code == 422 and any(f["code"] == "connection_required" for f in detail["findings"])
    conn = await api.post("/api/connections", json={
        "name": "HR mail", "connector": "smtp", "departments": ["hr"], "secret": "s3cret-password",
        "config": {"host": "smtp.example.com", "port": 587, "from_address": "hr@example.com"}}, headers=admin)
    assert conn.status_code == 201 and "s3cret" not in conn.text and conn.json()["has_secret"] is True
    listed = (await api.get("/api/connections", headers=hr)).text
    assert "s3cret" not in listed
    r = await api.post(f"/api/workflows/{wf['id']}/enable", json={"acknowledgements": []}, headers=hr)
    assert r.status_code == 422 and r.json()["detail"]["missing_acknowledgements"] == ["welcome_email"]
    r = await api.post(f"/api/workflows/{wf['id']}/enable", json={"acknowledgements": ["welcome_email"]}, headers=hr)
    assert r.status_code == 200 and r.json()["status"] == "enabled"


async def test_visual_edits_unsupported_and_detach(api):
    admin = await login(api, *ADMIN)
    wf = (await api.post("/api/templates/hr_leave_request/use", json={}, headers=admin)).json()
    definition = copy.deepcopy(wf["definition"])
    node = next(n for n in definition["nodes"] if n["id"] == "notify_approved")
    node["data"]["label"] = "Tell the employee the good news"
    node["position"] = {"x": 10, "y": 500}
    r = await api.put(f"/api/workflows/{wf['id']}", json={"definition": definition}, headers=admin)
    assert r.status_code == 200, r.text
    updated = r.json()
    assert updated["version"] == 2
    assert next(s for s in updated["plan"]["steps"] if s["id"] == "notify_approved")["title"] == "Tell the employee the good news"
    assert updated["plan"]["ui"]["positions"]["notify_approved"] == {"x": 10, "y": 500}
    # Parallel branches cannot be represented: rejected with reasons, nothing saved.
    bad = copy.deepcopy(updated["definition"])
    bad["nodes"].append({"id": "fork", "type": "parallel", "position": {"x": 0, "y": 0}, "data": {"label": "Fork", "config": {}}})
    r = await api.put(f"/api/workflows/{wf['id']}", json={"definition": bad}, headers=admin)
    assert r.status_code == 422 and "Parallel" in r.json()["detail"]["unsupported"][0]["message"]
    assert (await api.get(f"/api/workflows/{wf['id']}", headers=admin)).json()["version"] == 2
    detached = (await api.post(f"/api/workflows/{wf['id']}/detach", headers=admin)).json()
    assert detached["has_plan"] is False and detached["plan"] is None
    r = await api.put(f"/api/workflows/{wf['id']}", json={"definition": bad}, headers=admin)
    assert r.status_code == 200  # advanced-only now


async def test_running_execution_is_isolated_from_edits(api, bus, orchestrator, worker):
    admin = await login(api, *ADMIN)
    wf = (await api.post("/api/templates/hr_leave_request/use", json={}, headers=admin)).json()
    await api.post(f"/api/workflows/{wf['id']}/enable", json={"acknowledgements": []}, headers=admin)
    run = (await api.post(f"/api/workflows/{wf['id']}/execute", json={"input": {
        "employee_email": "admin@test.local", "days": 3, "start_date": "2026-11-01"}}, headers=admin)).json()
    await drain(bus, orchestrator, worker)
    r = await api.post(f"/api/workflows/{wf['id']}/plan/apply", headers=admin, json={
        "base_version": 1, "operations": [{"op": "remove_step", "step_id": "hr_approval"}]})
    assert r.status_code == 200 and r.json()["version"] == 2
    stale = await api.post(f"/api/workflows/{wf['id']}/plan/apply", headers=admin, json={
        "base_version": 1, "operations": [{"op": "rename", "title": "x"}]})
    assert stale.status_code == 409
    current = (await api.get(f"/api/executions/{run['id']}", headers=admin)).json()
    assert current["workflow_version"] == 1
    assert any(n["id"] == "hr_approval" for n in current["definition"]["nodes"])  # snapshot unchanged
    assert (await api.get(f"/api/workflows/{wf['id']}", headers=admin)).json()["enabled_version"] == 1


async def test_runtime_guard_blocks_unapproved_sensitive_action(api, bus, orchestrator, worker, monkeypatch):
    sent: list[Any] = []

    class FakeSMTP:
        def __init__(self, *a, **k): ...
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def starttls(self, **k): ...
        def login(self, *a): ...
        def send_message(self, msg): sent.append(msg)

    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    admin = await login(api, *ADMIN)
    await api.post("/api/connections", json={"name": "Mail", "connector": "smtp", "departments": [],
                                             "config": {"host": "smtp.example.com", "from_address": "a@example.com"}},
                   headers=admin)
    n = lambda i, t, c=None: {"id": i, "type": t, "position": {"x": 0, "y": 0}, "data": {"label": i, "config": c or {}}}
    e = lambda s, t, h="out": {"id": f"{s}-{h}-{t}", "source": s, "target": t, "sourceHandle": h, "targetHandle": "in"}
    mail = {"tool": "email_send", "args": {"to": "x@example.com", "subject": "Hi", "body": "Hello"}}
    unguarded = {"nodes": [n("start", "start"), n("mail", "tool", mail), n("end", "end")],
                 "edges": [e("start", "mail"), e("mail", "end")]}
    wf = (await api.post("/api/workflows", json={"name": "advanced mail", "definition": unguarded}, headers=admin)).json()
    run = (await api.post(f"/api/workflows/{wf['id']}/execute", json={}, headers=admin)).json()
    run = await run_to_rest(api, admin, bus, orchestrator, worker, run["id"])
    assert run["status"] == "FAILED" and "needs an approval" in run["error"] and not sent
    guarded = {"nodes": [n("start", "start"), n("ok", "approval", {"title": "OK?"}), n("mail", "tool", mail),
                         n("end", "end"), n("no", "fail")],
               "edges": [e("start", "ok"), e("ok", "mail", "approved"), e("ok", "no", "rejected"), e("mail", "end")]}
    wf = (await api.post("/api/workflows", json={"name": "approved mail", "definition": guarded}, headers=admin)).json()
    run = (await api.post(f"/api/workflows/{wf['id']}/execute", json={}, headers=admin)).json()
    await drain(bus, orchestrator, worker)
    approval = (await api.get("/api/approvals?status=pending", headers=admin)).json()[0]
    await api.post(f"/api/approvals/{approval['id']}/decision", json={"decision": "approve"}, headers=admin)
    run = await run_to_rest(api, admin, bus, orchestrator, worker, run["id"])
    assert run["status"] == "COMPLETED", run["error"]
    assert len(sent) == 1 and sent[0]["To"] == "x@example.com"


async def test_schedule_fires_once_per_slot(api, orchestrator, sessions):
    from datetime import UTC, datetime, timedelta

    admin = await login(api, *ADMIN)
    wf = (await api.post("/api/templates/hr_leave_request/use", json={}, headers=admin)).json()
    r = await api.post(f"/api/workflows/{wf['id']}/plan/apply", headers=admin, json={
        "base_version": 1, "operations": [{"op": "set_trigger", "trigger": {"type": "schedule", "cron": "*/5 * * * *"}}]})
    assert r.status_code == 200
    await api.post(f"/api/workflows/{wf['id']}/enable", json={"acknowledgements": []}, headers=admin)
    later = datetime.now(UTC) + timedelta(minutes=6)
    assert await orchestrator.fire_schedules(later) == 1
    assert await orchestrator.fire_schedules(later) == 0  # same slot never fires twice
    async with sessions() as session:
        runs = (await session.execute(select(WorkflowRun).where(WorkflowRun.workflow_id == uuid.UUID(wf["id"])))).scalars().all()
    assert len(runs) == 1 and runs[0].triggered_by == "schedule" and runs[0].workflow_version == 2
