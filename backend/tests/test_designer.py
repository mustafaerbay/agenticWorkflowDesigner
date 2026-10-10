"""AI designer pipeline against a MOCK OpenAI-compatible model (test double, not a real LLM).
Verifies registry-only capabilities, repair loop, policy independence, proposals/diffs, undo/redo, save."""

import json
from typing import Any

import httpx
import pytest

from app.agents.llm_client import LLMClient
from app.main import app
from app.services.seed import seed

ADMIN = ("admin@test.local", "admin-password-for-tests")


class MockModel:
    """Scripted chat completions; records every request for assertions."""

    def __init__(self, replies: list[dict[str, Any]]) -> None:
        self.replies = replies
        self.requests: list[list[dict[str, Any]]] = []

    async def chat(self, _client: Any, messages, tools=None, temperature=0.2, max_tokens=2048, json_mode=False):
        self.requests.append(messages)
        reply = self.replies.pop(0)
        return {"choices": [{"message": {"content": json.dumps(reply)}}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}}


@pytest.fixture
async def api(sessions, bus):
    app.state.bus = bus
    async with sessions() as session:
        await seed(session)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        r = await client.post("/api/auth/login", json={"email": ADMIN[0], "password": ADMIN[1]})
        client.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
        yield client


async def add_provider(api) -> None:
    r = await api.post("/api/model-providers", json={"name": "Mock", "base_url": "http://mock-llm/v1",
                                                     "default_model": "mock-model"})
    assert r.status_code == 201


def use(monkeypatch, model: MockModel) -> None:
    async def chat(self, messages, tools=None, temperature=0.2, max_tokens=2048, json_mode=False):
        return await model.chat(self, messages, tools, temperature, max_tokens, json_mode)
    monkeypatch.setattr(LLMClient, "chat", chat)


LEAVE_PLAN = {
    "schema": "bp/1", "title": "Leave requests", "summary": "Approve leave and tell the employee.",
    "department": "finance",  # the model's department is ignored; the session's department wins
    "inputs": [{"key": "employee_email", "label": "Employee email", "type": "email"},
               {"key": "days", "label": "Days", "type": "number"}],
    "steps": [
        {"id": "manager_ok", "kind": "approval", "title": "Manager approval",
         "approver": {"role": "approver", "department": "hr"}, "on_reject": {"fail": "Leave rejected"}},
        {"id": "tell_employee", "kind": "action", "title": "Email the employee", "capability": "email.send",
         "params": {"to": {"from": "input.employee_email"}, "subject": "Leave approved",
                    "body": "Your {{input.days}} days are approved."}},
    ],
}


async def test_no_model_configured_is_a_clear_setup_requirement(api):
    status = (await api.get("/api/designer/status")).json()
    assert status["available"] is False and "Model Settings" in status["reason"]
    r = await api.post("/api/designer/sessions", json={"prompt": "Approve leave", "department": "hr"})
    assert r.status_code == 409 and "No AI model" in r.json()["detail"]


async def test_propose_repair_policy_and_save(api, monkeypatch):
    await add_provider(api)
    invented = json.loads(json.dumps(LEAVE_PLAN))
    invented["steps"][1]["capability"] = "hris.update_leave_balance"  # not in the registry
    model = MockModel([
        {"plan": invented, "unmet_needs": [], "summary": "first try"},
        {"plan": LEAVE_PLAN, "unmet_needs": [{"need": "Update leave balance in the HR system",
                                              "reason": "No capability for it"}], "summary": "Leave workflow"},
    ])
    use(monkeypatch, model)
    r = await api.post("/api/designer/sessions", json={"prompt": "When someone asks for leave, a manager approves "
                                                                  "and we email them", "department": "hr"})
    assert r.status_code == 201, r.text
    session = r.json()
    # The repair loop told the model exactly what was wrong; the catalog was in the prompt.
    assert len(model.requests) == 2
    assert "hris.update_leave_balance' does not exist" in model.requests[1][1]["content"]
    assert "email.send" in model.requests[0][0]["content"] and "finance.submit_payment" not in model.requests[0][0]["content"]
    proposal = session["proposal"]
    assert proposal["kind"] == "create" and proposal["plan"]["department"] == "hr"
    assert proposal["unmet_needs"][0]["need"].startswith("Update leave balance")
    ids = [s["id"] for s in proposal["plan"]["steps"]]
    # The model's approval sits before the email, so policy adds nothing; but email needs SMTP.
    assert ids == ["manager_ok", "tell_employee"]
    codes = {f["code"] for f in proposal["findings"]}
    assert "connection_required" in codes
    assert proposal["explanation"]["integrations"][0]["status"] == "requires_connection"
    assert any(n["data"]["business"]["title"] == "Email the employee" for n in proposal["definition"]["nodes"])
    # Nothing is saved before Accept + Save.
    assert (await api.post(f"/api/designer/sessions/{session['id']}/save", json={})).status_code == 409
    session = (await api.post(f"/api/designer/sessions/{session['id']}/accept")).json()
    assert session["plan"] and session["proposal"] is None and session["can_undo"]

    # Conversational change -> typed operations -> diff for confirmation.
    model.replies.append({"operations": [
        {"op": "set_retry", "step_id": "tell_employee", "max_attempts": 3, "backoff_seconds": 10},
        {"op": "add_step", "after": "manager_ok", "step": {"id": "long_leave", "kind": "decision",
            "title": "More than 10 days?", "branches": [{"id": "long", "label": "Long leave",
            "when": {"op": "gt", "left": {"ref": "input.days"}, "right": {"value": 10}}, "goto": "hr_ok"}],
            "otherwise": "tell_employee"}},
        {"op": "add_step", "after": "long_leave", "step": {"id": "hr_ok", "kind": "approval", "title": "HR approval"}},
    ], "summary": "Retry the email and add HR approval for long leave"})
    r = await api.post(f"/api/designer/sessions/{session['id']}/messages",
                       json={"message": "Retry the email twice and get HR approval for leave over 10 days"})
    assert r.status_code == 200, r.text
    proposal = r.json()["proposal"]
    assert proposal["kind"] == "modify"
    assert {a["step_id"] for a in proposal["diff"]["added"]} == {"long_leave", "hr_ok"}
    assert proposal["diff"]["changed"][0]["step_id"] == "tell_employee"
    assert "the request's 'days' is more than 10" in next(
        s for s in proposal["explanation"]["steps"] if s["step_id"] == "long_leave")["rules"][0]
    session = (await api.post(f"/api/designer/sessions/{session['id']}/accept")).json()
    assert len(session["plan"]["steps"]) == 4
    session = (await api.post(f"/api/designer/sessions/{session['id']}/undo")).json()
    assert len(session["plan"]["steps"]) == 2 and session["can_redo"]
    session = (await api.post(f"/api/designer/sessions/{session['id']}/redo")).json()
    assert len(session["plan"]["steps"]) == 4

    wf = (await api.post(f"/api/designer/sessions/{session['id']}/save", json={"name": "Leave (AI)"})).json()
    assert wf["has_plan"] and wf["status"] == "draft" and wf["department"] == "hr" and wf["version"] == 1
    assert wf["plan_meta"]["policy_version"]


async def test_model_cannot_bypass_policy_or_invent_forever(api, monkeypatch):
    await add_provider(api)
    unsafe = json.loads(json.dumps(LEAVE_PLAN))
    unsafe["steps"] = [unsafe["steps"][1]]  # sends email with no approval at all
    bogus = {"plan": {**LEAVE_PLAN, "steps": [{"id": "x", "kind": "action", "title": "Do magic",
                                               "capability": "magic.do_it", "params": {}}]}, "summary": ""}
    model = MockModel([{"plan": unsafe, "summary": "Just email"}, bogus, bogus, bogus])
    use(monkeypatch, model)
    session = (await api.post("/api/designer/sessions", json={"prompt": "email people", "department": "hr"})).json()
    steps = session["proposal"]["plan"]["steps"]
    assert [s["id"] for s in steps] == ["approval_before_tell_employee", "tell_employee"]
    assert steps[0]["policy_inserted"] is True
    # A modification that tries to remove the policy approval is rejected after the repair attempts.
    await api.post(f"/api/designer/sessions/{session['id']}/accept")
    removal = {"operations": [{"op": "remove_step", "step_id": "approval_before_tell_employee"}], "summary": "removed"}
    model.replies[:] = [removal, removal, removal]
    r = await api.post(f"/api/designer/sessions/{session['id']}/messages", json={"message": "remove the approval"})
    assert r.status_code == 422 and "required by policy" in r.json()["detail"]
    # A brand-new design that only ever invents capabilities fails cleanly; nothing is created.
    model.replies[:] = [bogus, bogus, bogus]
    r = await api.post("/api/designer/sessions", json={"prompt": "do magic", "department": "hr"})
    assert r.status_code == 422 and "magic.do_it" in r.json()["detail"]
    assert (await api.get("/api/workflows")).json() == [w for w in (await api.get("/api/workflows")).json() if w["is_example"]]
