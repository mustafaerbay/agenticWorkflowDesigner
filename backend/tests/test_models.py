"""Model selection (provider roles, workflow/step choice) and provider error handling, with a MOCK model."""

import copy
import json
from typing import Any

import httpx
import pytest

from app.agents.llm_client import LLMClient, classify_http_error
from app.main import app
from app.services.seed import seed
from tests.conftest import drain

ADMIN = ("admin@test.local", "admin-password-for-tests")
OPENROUTER_402 = json.dumps({"error": {"message": "This request requires more credits, or fewer max_tokens. You requested "
                                                  "up to 4096 tokens, but can only afford 3938.", "code": 402}})


@pytest.fixture
async def api(sessions, bus):
    app.state.bus = bus
    async with sessions() as session:
        await seed(session)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        r = await client.post("/api/auth/login", json={"email": ADMIN[0], "password": ADMIN[1]})
        client.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
        yield client


def test_error_classification():
    e = classify_http_error(402, OPENROUTER_402, "https://openrouter.ai/api/v1", 4096)
    assert not e.retryable and "out of credit" in e.args[0] and "openrouter.ai" in e.args[0] and "4096" in e.args[0]
    assert "can only afford 3938" in e.args[0]
    assert not classify_http_error(401, "{}", "https://x/v1").retryable
    assert not classify_http_error(404, "{}", "https://x/v1").retryable
    assert classify_http_error(429, "{}", "https://x/v1").retryable
    assert classify_http_error(503, "oops", "https://x/v1").retryable


async def add_provider(api, name: str, model: str, max_tokens: int = 2048) -> dict[str, Any]:
    r = await api.post("/api/model-providers", json={"name": name, "base_url": f"http://{name.lower()}.test/v1",
                                                     "default_model": model, "max_tokens": max_tokens})
    assert r.status_code == 201, r.text
    return r.json()


async def test_out_of_credit_fails_fast_with_clear_message(api, bus, orchestrator, worker, monkeypatch):
    calls: list[int] = []

    async def chat(self, messages, tools=None, temperature=0.2, max_tokens=2048, json_mode=False):
        calls.append(max_tokens)
        raise classify_http_error(402, OPENROUTER_402, self.base_url, max_tokens)

    monkeypatch.setattr(LLMClient, "chat", chat)
    await add_provider(api, "Router", "openai/gpt-4o-mini", max_tokens=1500)
    # Designer: respects the provider's Max tokens and explains the problem.
    r = await api.post("/api/designer/sessions", json={"prompt": "Summarize documents", "department": "hr"})
    assert r.status_code == 502 and "out of credit" in r.json()["detail"]
    assert calls == [1500]
    # AI step in a run: retry policy allows 2 attempts, but a credit error is not retried.
    agent = {"id": "summarize", "type": "agent", "position": {"x": 0, "y": 0},
             "data": {"label": "Summarize", "config": {"kind": "llm", "user_prompt": "hi", "tools": [],
                                                        "retry": {"max_attempts": 2, "backoff_seconds": 0}}}}
    node = lambda i, t: {"id": i, "type": t, "position": {"x": 0, "y": 0}, "data": {"label": i, "config": {}}}
    edge = lambda s, t: {"id": f"{s}-{t}", "source": s, "target": t, "sourceHandle": "out", "targetHandle": "in"}
    wf = (await api.post("/api/workflows", json={"name": "ai", "definition": {
        "nodes": [node("start", "start"), agent, node("end", "end")],
        "edges": [edge("start", "summarize"), edge("summarize", "end")]}})).json()
    run = (await api.post(f"/api/workflows/{wf['id']}/execute", json={})).json()
    await drain(bus, orchestrator, worker)
    run = (await api.get(f"/api/executions/{run['id']}")).json()
    attempts = [n for n in run["node_runs"] if n["node_id"] == "summarize"]
    assert run["status"] == "FAILED" and len(attempts) == 1 and "not retryable" in run["error"]
    assert "out of credit" in run["error"]


async def test_truncated_design_is_explained(api, monkeypatch):
    async def chat(self, messages, tools=None, temperature=0.2, max_tokens=2048, json_mode=False):
        return {"choices": [{"finish_reason": "length", "message": {"content": '{"plan": {"title": "Cut'}}]}

    monkeypatch.setattr(LLMClient, "chat", chat)
    await add_provider(api, "Small", "tiny", max_tokens=300)
    r = await api.post("/api/designer/sessions", json={"prompt": "Approve leave", "department": "hr"})
    assert r.status_code == 502 and "Max tokens limit (300)" in r.json()["detail"]


async def test_provider_roles_and_model_precedence(api):
    first = await add_provider(api, "First", "first-model")
    second = await add_provider(api, "Second", "second-model")
    providers = {p["name"]: p for p in (await api.get("/api/model-providers")).json()}
    assert not providers["First"]["is_default"] and not providers["Second"]["is_default"]
    r = await api.post(f"/api/model-providers/{second['id']}/role", json={"role": "steps"})
    assert r.json()["is_default"] is True
    await api.post(f"/api/model-providers/{first['id']}/role", json={"role": "designer"})
    assert (await api.get("/api/designer/status")).json()["provider"] == "First"
    await api.post(f"/api/model-providers/{second['id']}/role", json={"role": "designer"})
    providers = {p["name"]: p for p in (await api.get("/api/model-providers")).json()}
    assert providers["Second"]["use_for_designer"] and not providers["First"]["use_for_designer"]  # exclusive

    wf = (await api.post("/api/templates/it_incident_analysis/use", json={})).json()
    steps = {s["step_id"]: s for s in wf["explanation"]["steps"]}
    assert steps["severity"]["ai_model"] == {"provider_id": second["id"], "provider": "Second", "model": "second-model",
                                             "source": "default"}
    assert wf["explanation"]["ai_model"]["source"] == "default"
    await api.post(f"/api/workflows/{wf['id']}/enable", json={"acknowledgements": []})
    r = await api.post(f"/api/workflows/{wf['id']}/plan/apply", json={"base_version": 1, "operations": [
        {"op": "set_ai_model", "provider_id": first["id"], "model": "first-large"},
        {"op": "set_ai_model", "step_id": "summary", "model": "first-mini"}]})
    assert r.status_code == 200, r.text
    updated = r.json()
    assert updated["status"] == "enabled" and updated["enabled_version"] == 2  # model-only change stays enabled
    steps = {s["step_id"]: s for s in updated["explanation"]["steps"]}
    assert steps["severity"]["ai_model"]["model"] == "first-large" and steps["severity"]["ai_model"]["source"] == "workflow"
    assert steps["summary"]["ai_model"]["model"] == "first-mini" and steps["summary"]["ai_model"]["source"] == "step"
    assert steps["summary"]["ai_model"]["provider"] == "First"
    # Not an AI step -> rejected; unknown provider -> blocking finding.
    bad = await api.post(f"/api/workflows/{wf['id']}/plan/preview", json={"operations": [
        {"op": "set_ai_model", "step_id": "report", "model": "x"}]})
    assert bad.status_code == 422 and "does not use an AI model" in bad.json()["detail"]["message"]
    missing = (await api.post(f"/api/workflows/{wf['id']}/plan/preview", json={"operations": [
        {"op": "set_ai_model", "provider_id": "00000000-0000-0000-0000-000000000000"}]})).json()
    assert any(f["code"] == "unknown_model_provider" for f in missing["findings"])

    # The compiled run definition carries the chosen models (runs snapshot it at start).
    run_definition = updated["definition"]
    agent_models = {n["id"]: (n["data"]["config"].get("model_provider_id"), n["data"]["config"].get("model"))
                    for n in run_definition["nodes"] if n["type"] == "agent"}
    assert agent_models["summary"] == (first["id"], "first-mini") and agent_models["severity"] == (first["id"], "first-large")


async def test_advanced_editor_model_change_becomes_operation(api):
    first = await add_provider(api, "First", "first-model")
    wf = (await api.post("/api/templates/it_incident_analysis/use", json={})).json()
    definition = copy.deepcopy(wf["definition"])
    node = next(n for n in definition["nodes"] if n["id"] == "summary")
    node["data"]["config"]["model_provider_id"] = first["id"]
    node["data"]["config"]["model"] = "first-xl"
    r = await api.put(f"/api/workflows/{wf['id']}", json={"definition": definition})
    assert r.status_code == 200, r.text
    step = next(s for s in r.json()["plan"]["steps"] if s["id"] == "summary")
    assert step["ai"] == {"provider_id": first["id"], "model": "first-xl"}

