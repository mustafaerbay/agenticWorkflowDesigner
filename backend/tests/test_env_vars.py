"""Platform environment variables: admin-only, encrypted, values never listed, audited reveal,
and resolved server-side for model providers (designer and running AI steps)."""

import json
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.agents.llm_client import LLMClient
from app.main import app
from app.models import AuditLog, EnvVariable
from app.services.seed import seed
from tests.conftest import drain, edge, node

ADMIN = ("admin@test.local", "admin-password-for-tests")


@pytest.fixture
async def api(sessions, bus):
    app.state.bus = bus
    async with sessions() as session:
        await seed(session)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        r = await client.post("/api/auth/login", json={"email": ADMIN[0], "password": ADMIN[1]})
        client.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
        yield client


async def test_crud_reveal_and_access_control(api, sessions):
    r = await api.post("/api/env-variables", json={"name": "OPENAI_API_KEY", "value": "sk-test-123",
                                                   "description": "Designer model"})
    assert r.status_code == 201 and "sk-test-123" not in r.text
    var = r.json()
    listed = await api.get("/api/env-variables")
    assert "sk-test-123" not in listed.text and listed.json()[0]["name"] == "OPENAI_API_KEY"
    async with sessions() as session:
        stored = (await session.execute(select(EnvVariable))).scalar_one()
        assert "sk-test-123" not in stored.value_encrypted  # encrypted at rest
    assert (await api.post("/api/env-variables", json={"name": "OPENAI_API_KEY", "value": "x"})).status_code == 409
    assert (await api.post("/api/env-variables", json={"name": "lowercase", "value": "x"})).status_code == 422
    assert (await api.post("/api/env-variables", json={"name": "JWT_SECRET", "value": "x"})).status_code == 422
    revealed = await api.post(f"/api/env-variables/{var['id']}/reveal")
    assert revealed.json() == {"name": "OPENAI_API_KEY", "value": "sk-test-123"}
    updated = (await api.put(f"/api/env-variables/{var['id']}", json={"value": "sk-test-456"})).json()
    assert updated["updated_by"] == ADMIN[0]
    assert (await api.post(f"/api/env-variables/{var['id']}/reveal")).json()["value"] == "sk-test-456"
    async with sessions() as session:
        actions = (await session.execute(select(AuditLog.action).where(AuditLog.entity_type == "env_variable"))).scalars().all()
    assert actions.count("env_variable.reveal") == 2 and "env_variable.update" in actions
    # Non-admins cannot list, create or reveal.
    await api.post("/api/users", json={"email": "ed@test.local", "name": "ed", "password": "password-1234567",
                                       "role": "editor", "memberships": []})
    token = (await api.post("/api/auth/login", json={"email": "ed@test.local", "password": "password-1234567"})).json()["access_token"]
    other = {"Authorization": f"Bearer {token}"}
    assert (await api.get("/api/env-variables", headers=other)).status_code == 403
    assert (await api.post(f"/api/env-variables/{var['id']}/reveal", headers=other)).status_code == 403
    assert (await api.delete(f"/api/env-variables/{var['id']}")).status_code == 204


async def test_provider_key_resolves_from_platform_variable(api, monkeypatch, bus, orchestrator, worker):
    seen: list[str | None] = []

    async def chat(self, messages, tools=None, temperature=0.2, max_tokens=2048, json_mode=False) -> dict[str, Any]:
        seen.append(self.api_key)
        return {"choices": [{"message": {"content": json.dumps({"summary": "ok"})}}], "usage": {}}

    monkeypatch.setattr(LLMClient, "chat", chat)
    provider = (await api.post("/api/model-providers", json={"name": "Model", "base_url": "http://llm.test/v1",
                                                             "default_model": "m", "api_key_ref": "MY_MODEL_KEY"})).json()
    assert provider["api_key_configured"] is False
    await api.post("/api/env-variables", json={"name": "MY_MODEL_KEY", "value": "secret-from-ui"})
    providers = (await api.get("/api/model-providers")).json()
    assert providers[0]["api_key_configured"] is True and "secret-from-ui" not in json.dumps(providers)
    used_by = (await api.get("/api/env-variables")).json()[0]["used_by"]
    assert used_by == ["Model"]

    # A running AI step receives the key in memory; it is never stored in the run.
    agent = {"id": "summarize", "type": "agent", "position": {"x": 0, "y": 0},
             "data": {"label": "Summarize", "config": {"kind": "llm", "user_prompt": "hi", "tools": []}}}
    definition = {"nodes": [node("start", "start"), agent, node("end", "end")],
                  "edges": [edge("start", "summarize"), edge("summarize", "end")]}
    wf = (await api.post("/api/workflows", json={"name": "ai", "definition": definition})).json()
    run = (await api.post(f"/api/workflows/{wf['id']}/execute", json={})).json()
    await drain(bus, orchestrator, worker)
    run = (await api.get(f"/api/executions/{run['id']}")).json()
    assert run["status"] == "COMPLETED", run["error"]
    assert seen == ["secret-from-ui"]
    assert "secret-from-ui" not in json.dumps(run)


async def test_provider_form_with_empty_optional_numbers_uses_defaults(api):
    """The UI sends null for empty Timeout/Temperature/Max tokens; that must mean 'use the default'."""
    r = await api.post("/api/model-providers", json={
        "name": "Acme", "base_url": "https://llm.example.com/v1", "default_model": "acme-1", "api_key_ref": None,
        "timeout_seconds": None, "temperature": None, "max_tokens": None})
    assert r.status_code == 201, r.text
    p = r.json()
    assert (p["timeout_seconds"], p["temperature"], p["max_tokens"]) == (120, 0.2, 2048)
    r = await api.put(f"/api/model-providers/{p['id']}", json={
        "name": "Acme", "base_url": "https://llm.example.com/v1", "default_model": "acme-2", "api_key_ref": None,
        "timeout_seconds": None, "temperature": 0.5, "max_tokens": None})
    assert r.status_code == 200 and r.json()["temperature"] == 0.5 and r.json()["timeout_seconds"] == 120
