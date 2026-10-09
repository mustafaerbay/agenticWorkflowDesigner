"""End-to-end: the bundled deterministic SDLC pipeline through the API, orchestrator,
agent worker and real sandbox (real pytest runs, real git diff, real artifacts)."""

import httpx
import pytest

from app.main import app
from app.services.seed import seed
from tests.conftest import drain


@pytest.fixture
async def api(sessions, bus):
    app.state.bus = bus
    async with sessions() as session:
        await seed(session)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        r = await client.post("/api/auth/login", json={"email": "admin@test.local", "password": "admin-password-for-tests"})
        client.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
        yield client


async def test_deterministic_sdlc_pipeline(api, bus, orchestrator, worker):
    workflows = (await api.get("/api/workflows")).json()
    wf = next(w for w in workflows if w["name"].startswith("Autonomous Development Pipeline (deterministic"))
    definition = (await api.get(f"/api/workflows/{wf['id']}")).json()["definition"]
    start = next(n for n in definition["nodes"] if n["type"] == "start")
    run = (await api.post(f"/api/workflows/{wf['id']}/execute",
                          json={"input": start["data"]["config"]["default_input"]})).json()
    await drain(bus, orchestrator, worker)
    run = (await api.get(f"/api/executions/{run['id']}")).json()
    assert run["status"] == "WAITING_APPROVAL", run["error"]

    by_node: dict[str, list[dict]] = {}
    for nr in run["node_runs"]:
        by_node.setdefault(nr["node_id"], []).append(nr)
    tests = by_node["run_tests"]
    assert [t["output"]["tests_passed"] for t in tests] == [False, True]  # real failure, then real pass
    assert tests[0]["output"]["failed"] == 1 and tests[1]["output"]["passed"] == 5
    assert [n["selected_handle"] for n in by_node["tests_passed"]] == ["fix", "passed"]
    assert by_node["fix_agent"][0]["agent_kind"] == "scripted"
    assert by_node["review_ok"][0]["selected_handle"] == "approved"
    assert "calculator.py" in by_node["code_review"][0]["output"]["files_changed"]

    approval = (await api.get("/api/approvals?status=pending")).json()[0]
    await api.post(f"/api/approvals/{approval['id']}/decision", json={"decision": "approve"})
    await drain(bus, orchestrator, worker)
    run = (await api.get(f"/api/executions/{run['id']}")).json()
    assert run["status"] == "COMPLETED", run["error"]
    kinds = sorted(a["kind"] for a in run["artifacts"])
    assert kinds == ["patch", "report"]
    patch = next(a for a in run["artifacts"] if a["kind"] == "patch")
    body = (await api.get(f"/api/artifacts/{patch['id']}/download")).text
    assert 'raise ValueError("division by zero")' in body
