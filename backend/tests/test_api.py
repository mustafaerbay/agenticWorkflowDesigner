import httpx
import pytest

from app.main import app
from app.services.seed import seed
from tests.conftest import drain, edge, make_user, node


@pytest.fixture
async def api(sessions, bus):
    app.state.bus = bus
    async with sessions() as session:
        await seed(session)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client


async def login(api, email, password):
    r = await api.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


SIMPLE = {"nodes": [node("start", "start"), node("end", "end")], "edges": [edge("start", "end")]}


async def test_auth_required_and_login(api):
    assert (await api.get("/api/workflows")).status_code == 401
    assert (await api.get("/api/workflows", headers={"Authorization": "Bearer junk"})).status_code == 401
    assert (await api.post("/api/auth/login", json={"email": "admin@test.local", "password": "wrong"})).status_code == 401
    headers = await login(api, "admin@test.local", "admin-password-for-tests")
    me = (await api.get("/api/auth/me", headers=headers)).json()
    assert me["role"] == "admin"
    assert (await api.get("/api/health")).json() == {"status": "ok"}


async def test_seeded_examples_and_tools(api):
    headers = await login(api, "admin@test.local", "admin-password-for-tests")
    names = [w["name"] for w in (await api.get("/api/workflows", headers=headers)).json()]
    assert "Autonomous Development Pipeline" in names
    tools = {t["name"] for t in (await api.get("/api/tools", headers=headers)).json()}
    assert {"run_tests", "write_file", "git_diff", "generate_patch"} <= tools
    presets = {p["key"] for p in (await api.get("/api/agents/presets", headers=headers)).json()}
    assert {"planning", "developer", "testing", "code_review", "devops", "documentation", "repo_fetch",
            "document_analysis", "communication", "data_analysis"} == presets


async def test_workflow_crud_versioning_and_validation(api):
    headers = await login(api, "admin@test.local", "admin-password-for-tests")
    r = await api.post("/api/workflows", json={"name": "wf", "definition": SIMPLE}, headers=headers)
    assert r.status_code == 201
    wf = r.json()
    assert wf["version"] == 1
    changed = {**SIMPLE, "settings": {"max_loop_iterations": 3}}
    wf = (await api.put(f"/api/workflows/{wf['id']}", json={"definition": changed}, headers=headers)).json()
    assert wf["version"] == 2 and wf["definition"]["settings"]["max_loop_iterations"] == 3
    wf = (await api.put(f"/api/workflows/{wf['id']}", json={"name": "renamed"}, headers=headers)).json()
    assert wf["version"] == 2 and wf["name"] == "renamed"
    assert len((await api.get(f"/api/workflows/{wf['id']}/versions", headers=headers)).json()) == 2
    assert (await api.post(f"/api/workflows/{wf['id']}/validate", headers=headers)).json()["valid"] is True
    bad = (await api.post("/api/workflows/validate", json={"definition": {"nodes": [], "edges": []}}, headers=headers)).json()
    assert bad["valid"] is False and bad["errors"]
    exported = (await api.get(f"/api/workflows/{wf['id']}/export", headers=headers)).json()
    imported = await api.post("/api/workflows/import", json=exported, headers=headers)
    assert imported.status_code == 201 and imported.json()["definition"] == changed
    dup = await api.post(f"/api/workflows/{wf['id']}/duplicate", headers=headers)
    assert dup.status_code == 201 and dup.json()["name"].endswith("(copy)")
    assert (await api.delete(f"/api/workflows/{wf['id']}", headers=headers)).status_code == 204
    assert (await api.get(f"/api/workflows/{wf['id']}", headers=headers)).status_code == 404


async def test_invalid_workflow_cannot_execute(api):
    headers = await login(api, "admin@test.local", "admin-password-for-tests")
    wf = (await api.post("/api/workflows", json={"name": "bad", "definition": {"nodes": [node("start", "start")], "edges": []}},
                         headers=headers)).json()
    r = await api.post(f"/api/workflows/{wf['id']}/execute", json={}, headers=headers)
    assert r.status_code == 422 and r.json()["detail"]["valid"] is False


async def test_authorization_boundaries(api, sessions):
    admin = await login(api, "admin@test.local", "admin-password-for-tests")
    await make_user(sessions, "editor", "editor@test.local")
    await make_user(sessions, "viewer", "viewer@test.local")
    editor = await login(api, "editor@test.local", "password123")
    viewer = await login(api, "viewer@test.local", "password123")
    private = (await api.post("/api/workflows", json={"name": "admin-only", "definition": SIMPLE}, headers=admin)).json()
    # Other users cannot see or run someone else's workflow.
    assert (await api.get(f"/api/workflows/{private['id']}", headers=editor)).status_code == 404
    assert (await api.post(f"/api/workflows/{private['id']}/execute", json={}, headers=editor)).status_code == 404
    # Viewers are read-only; only admins manage model providers.
    assert (await api.post("/api/workflows", json={"name": "x", "definition": SIMPLE}, headers=viewer)).status_code == 403
    provider = {"name": "p", "base_url": "http://llm:8000/v1", "default_model": "m"}
    assert (await api.post("/api/model-providers", json=provider, headers=editor)).status_code == 403
    r = await api.post("/api/model-providers", json={**provider, "api_key_ref": "LLM_API_KEY"}, headers=admin)
    assert r.status_code == 201 and "api_key" not in {k for k in r.json() if k != "api_key_ref" and k != "api_key_configured"}
    # Editor's own run is invisible to another editor.
    own = (await api.post("/api/workflows", json={"name": "mine", "definition": SIMPLE}, headers=editor)).json()
    run = (await api.post(f"/api/workflows/{own['id']}/execute", json={}, headers=editor)).json()
    await make_user(sessions, "editor", "other@test.local")
    other = await login(api, "other@test.local", "password123")
    assert (await api.get(f"/api/executions/{run['id']}", headers=other)).status_code == 404
    assert (await api.get(f"/api/executions/{run['id']}", headers=admin)).status_code == 200


async def test_execute_and_approve_via_api(api, bus, orchestrator, worker):
    headers = await login(api, "admin@test.local", "admin-password-for-tests")
    definition = {"nodes": [node("start", "start"), node("gate", "approval", {"title": "Go?"}), node("end", "end"),
                            node("stop", "fail")],
                  "edges": [edge("start", "gate"), edge("gate", "end", "approved"), edge("gate", "stop", "rejected")]}
    wf = (await api.post("/api/workflows", json={"name": "approval", "definition": definition}, headers=headers)).json()
    run = (await api.post(f"/api/workflows/{wf['id']}/execute", json={"input": {"x": 1}}, headers=headers)).json()
    assert run["status"] == "PENDING"
    await drain(bus, orchestrator, worker)
    run = (await api.get(f"/api/executions/{run['id']}", headers=headers)).json()
    assert run["status"] == "WAITING_APPROVAL"
    pending = (await api.get("/api/approvals?status=pending", headers=headers)).json()
    assert len(pending) == 1
    r = await api.post(f"/api/approvals/{pending[0]['id']}/decision", json={"decision": "approve", "comment": "ok"},
                       headers=headers)
    assert r.status_code == 200 and r.json()["status"] == "approved"
    again = await api.post(f"/api/approvals/{pending[0]['id']}/decision", json={"decision": "reject"}, headers=headers)
    assert again.status_code == 409
    await drain(bus, orchestrator, worker)
    run = (await api.get(f"/api/executions/{run['id']}", headers=headers)).json()
    assert run["status"] == "COMPLETED"
    events = (await api.get(f"/api/executions/{run['id']}/events?after=0", headers=headers)).json()
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    assert "approval.resolved" in {e["type"] for e in events}
    stats = (await api.get("/api/stats", headers=headers)).json()
    assert stats["runs_by_status"]["COMPLETED"] >= 1
