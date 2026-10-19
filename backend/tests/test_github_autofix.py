"""GitHub issue auto-fixer template, end to end, with a MOCK GitHub API and a MOCK model (test doubles).
Real engine, worker, sandbox, pytest and code scan. Verifies: token from an Environment Variable,
issue -> fix -> tests -> pull request on a new branch, waiting for review, never merging."""

import io
import json
import tarfile
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import update

from app.agents.llm_client import LLMClient
from app.connections import github as github_module
from app.main import app
from app.models import NodeRun
from app.services.examples import FIXED_CALCULATOR
from app.services.seed import seed
from app.tools import git_fetch
from tests.conftest import drain

ADMIN = ("admin@test.local", "admin-password-for-tests")
REPO = "acme/calculator"
TOKEN = "ghp_test_token_never_logged"


class FakeGitHub:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.pr_states = ["open", "merged"]
        self.created_refs: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path, method = request.url.path, request.method
        assert request.headers["Authorization"] == f"Bearer {TOKEN}"
        if method == "GET" and path == f"/repos/{REPO}":
            return httpx.Response(200, json={"default_branch": "main"})
        if method == "GET" and path == f"/repos/{REPO}/pulls":
            return httpx.Response(200, json=[])
        if method == "GET" and path == f"/repos/{REPO}/issues":
            assert request.url.params["labels"] == "ai-fix"
            return httpx.Response(200, json=[
                {"number": 7, "title": "divide(1, 0) should raise ValueError", "body": "Division by zero is not handled.",
                 "html_url": "https://github.com/acme/calculator/issues/7", "labels": [{"name": "ai-fix"}]},
                {"number": 8, "title": "a PR, not an issue", "pull_request": {}, "html_url": "x", "labels": []}])
        if method == "GET" and path == f"/repos/{REPO}/git/ref/heads/main":
            return httpx.Response(200, json={"object": {"sha": "base-sha"}})
        if method == "GET" and path == f"/repos/{REPO}/git/commits/base-sha":
            return httpx.Response(200, json={"tree": {"sha": "base-tree"}})
        if method == "POST" and path == f"/repos/{REPO}/git/blobs":
            return httpx.Response(201, json={"sha": "blob-1"})
        if method == "POST" and path == f"/repos/{REPO}/git/trees":
            return httpx.Response(201, json={"sha": "tree-1"})
        if method == "POST" and path == f"/repos/{REPO}/git/commits":
            return httpx.Response(201, json={"sha": "commit-1"})
        if method == "POST" and path == f"/repos/{REPO}/git/refs":
            self.created_refs.append(json.loads(request.content)["ref"])
            return httpx.Response(201, json={})
        if method == "POST" and path == f"/repos/{REPO}/pulls":
            return httpx.Response(201, json={"number": 42, "html_url": "https://github.com/acme/calculator/pull/42"})
        if method == "GET" and path == f"/repos/{REPO}/pulls/42":
            state = self.pr_states.pop(0)
            return httpx.Response(200, json={"number": 42, "html_url": "https://github.com/acme/calculator/pull/42",
                                             "state": "closed" if state == "merged" else state,
                                             "merged": state == "merged"})
        return httpx.Response(404, json={"message": f"unexpected {method} {path}"})


def sample_repo_archive() -> git_fetch.FetchedRepo:
    root = Path(__file__).parent.parent / "workspace_templates" / "sample-calculator"
    buffer = io.BytesIO()
    files = 0
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for path in sorted(root.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                tar.add(path, arcname=str(path.relative_to(root)), recursive=False)
                files += 1
    return git_fetch.FetchedRepo(archive=buffer.getvalue(), commit="c0ffee" * 6 + "abcd", files=files, bytes=1000)


@pytest.fixture
async def api(sessions, bus):
    app.state.bus = bus
    async with sessions() as session:
        await seed(session)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        r = await client.post("/api/auth/login", json={"email": ADMIN[0], "password": ADMIN[1]})
        client.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
        yield client


async def test_github_autofix_end_to_end(api, bus, orchestrator, worker, sessions, monkeypatch):
    gh = FakeGitHub()
    monkeypatch.setattr(github_module, "HTTP_TRANSPORT", httpx.MockTransport(gh))
    clone_auth: list[dict[str, str]] = []

    async def fake_fetch(url, ref, depth=1, auth_env=None):
        assert url == f"https://github.com/{REPO}" and ref == "main"
        clone_auth.append(auth_env or {})
        return sample_repo_archive()

    monkeypatch.setattr(git_fetch, "fetch_repository", fake_fetch)
    model_calls: list[list[dict[str, Any]]] = []

    async def developer_model(self, messages, tools=None, temperature=0.2, max_tokens=2048, json_mode=False):
        model_calls.append(messages)
        if len(model_calls) == 1:  # first turn: fix the code
            return {"choices": [{"message": {"content": "", "tool_calls": [{"id": "1", "type": "function", "function": {
                "name": "write_file", "arguments": json.dumps({"path": "calculator.py", "content": FIXED_CALCULATOR})}}]}}]}
        return {"choices": [{"message": {"content": json.dumps({
            "title": "Raise ValueError when dividing by zero", "summary": "divide() now rejects a zero divisor.",
            "files_changed": ["calculator.py"]})}}]}

    monkeypatch.setattr(LLMClient, "chat", developer_model)

    # Admin setup: model key and GitHub token both come from Environment Variables.
    await api.post("/api/env-variables", json={"name": "MODEL_KEY", "value": "model-secret"})
    await api.post("/api/model-providers", json={"name": "Model", "base_url": "http://llm.test/v1",
                                                 "default_model": "m", "api_key_ref": "MODEL_KEY"})
    await api.post("/api/env-variables", json={"name": "GITHUB_TOKEN", "value": TOKEN})
    conn = await api.post("/api/connections", json={"name": "GitHub", "connector": "github", "secret_env": "GITHUB_TOKEN",
                                                    "config": {"allowed_repos": [REPO]}, "departments": []})
    assert conn.status_code == 201, conn.text
    assert conn.json()["secret_env"] == "GITHUB_TOKEN" and TOKEN not in conn.text
    used_by = {v["name"]: v["used_by"] for v in (await api.get("/api/env-variables")).json()}
    assert used_by["GITHUB_TOKEN"] == ["Connection: GitHub"]

    wf = (await api.post("/api/templates/eng_github_autofix/use", json={}, headers={})).json()
    explanation = wf["explanation"]
    assert explanation["trigger"].startswith("Starts automatically") and "*/15 * * * *" in explanation["trigger"]
    assert not any(s["policy_inserted"] for s in explanation["steps"])  # a pull request is a proposal
    repo_steps = [s["id"] for s in wf["plan"]["steps"] if (s.get("params") or {}).get("repo") == "owner/repository"]
    r = await api.post(f"/api/workflows/{wf['id']}/plan/apply", json={"base_version": 1, "operations": [
        {"op": "update_step", "step_id": sid, "params": {"repo": REPO}} for sid in repo_steps]})
    assert r.status_code == 200, r.text
    enabled = await api.post(f"/api/workflows/{wf['id']}/enable", json={"acknowledgements": []})
    assert enabled.status_code == 200, enabled.text

    run = (await api.post(f"/api/workflows/{wf['id']}/execute", json={})).json()
    await drain(bus, orchestrator, worker)
    run = (await api.get(f"/api/executions/{run['id']}")).json()
    by_node = {}
    for nr in run["node_runs"]:
        by_node.setdefault(nr["node_id"], []).append(nr)
    assert by_node["find_issues"][0]["output"]["count"] == 1  # the PR in the issue list is ignored
    assert by_node["run_tests"][0]["output"]["failed"] == 1   # real pytest run on the cloned code
    assert by_node["anything_to_fix"][0]["selected_handle"] == "yes"
    assert by_node["verify"][0]["output"]["failed"] == 0 and by_node["fixed"][0]["selected_handle"] == "pass"
    pr = by_node["propose"][0]["output"]
    assert pr["number"] == 42 and pr["files_changed"] == ["calculator.py"]
    assert gh.created_refs == [f"refs/heads/ai-fix/{run['id'][:8]}"]  # new branch only
    pr_request = next(r for r in gh.requests if r.method == "POST" and r.url.path.endswith("/pulls"))
    body = json.loads(pr_request.content)
    assert body["title"] == "Raise ValueError when dividing by zero" and "Fixes #7" in body["body"]
    assert "divide(1, 0) should raise ValueError" in json.dumps(model_calls[0])  # issue details reached the fixer
    assert run["status"] == "RUNNING"  # waiting for the review

    # Two review checks: still open, then merged on GitHub -> the run completes.
    for _ in range(2):
        async with sessions() as session:
            await session.execute(update(NodeRun).where(NodeRun.node_id == "wait_review", NodeRun.status == "WAITING")
                                  .values(wait_until=datetime.now(UTC) - timedelta(seconds=1)))
            await session.commit()
        await orchestrator.sweep()
        await drain(bus, orchestrator, worker)
    run = (await api.get(f"/api/executions/{run['id']}")).json()
    assert run["status"] == "COMPLETED", run["error"]
    assert [n["output"]["state"] for n in run["node_runs"] if n["node_id"] == "review_status"] == ["open", "merged"]
    assert not any(r.method in ("PUT", "PATCH") or r.url.path.endswith("/merge") for r in gh.requests)  # never merges
    assert TOKEN not in json.dumps(run) and "model-secret" not in json.dumps(run)
    assert clone_auth[0]["GIT_CONFIG_KEY_0"] == "http.https://github.com/.extraheader"


async def test_schedule_editing_keeps_enabled_and_skips_while_running(api, orchestrator, sessions):
    wf = (await api.post("/api/templates/hr_leave_request/use", json={})).json()
    r = await api.put(f"/api/workflows/{wf['id']}/schedule", json={"enabled": True, "cron": "not a cron"})
    assert r.status_code == 422
    await api.post(f"/api/workflows/{wf['id']}/enable", json={"acknowledgements": []})
    r = await api.put(f"/api/workflows/{wf['id']}/schedule", json={"enabled": True, "cron": "*/15 * * * *"})
    assert r.status_code == 200
    updated = r.json()
    assert updated["status"] == "enabled" and updated["enabled_version"] == updated["version"] == 2
    later = datetime.now(UTC) + timedelta(minutes=16)
    assert await orchestrator.fire_schedules(later) == 1
    # The first scheduled run is still active (no worker drained it): the next slot is skipped.
    assert await orchestrator.fire_schedules(later + timedelta(minutes=15)) == 0
    r = await api.put(f"/api/workflows/{wf['id']}/schedule", json={"enabled": False})
    assert r.json()["plan"]["trigger"]["type"] == "manual"


def test_repo_allow_list_and_branch_safety():
    from app.connections.github import check_repo
    from app.tools.registry import ToolError

    config = {"allowed_repos": ["acme/calculator"]}
    assert check_repo(config, "https://github.com/Acme/Calculator.git") == "Acme/Calculator"
    for bad in ("evil/repo", "acme", "../x/y"):
        with pytest.raises(ToolError):
            check_repo(config, bad)


async def test_scan_finds_real_problems(sandbox):
    ws = str(uuid.uuid4())
    await sandbox.call("/workspace/init", {"workspace": ws})
    await sandbox.call("/fs/write", {"workspace": ws, "path": "app.py",
                                     "content": "import os\n\ndef f():\n    return undefined_name\n"})
    result = await sandbox.call("/code/scan", {"workspace": ws})
    codes = {f["code"] for f in result["findings"]}
    assert {"F401", "F821"} <= codes and result["findings"][0]["file"] == "app.py"
