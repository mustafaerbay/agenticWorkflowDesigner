import uuid

import httpx
import pytest

from app.sandbox.server import app as sandbox_app
from app.services.examples import FIXED_CALCULATOR

TOKEN = {"X-Sandbox-Token": "test-sandbox-token-0123456789"}


@pytest.fixture
async def client():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=sandbox_app), base_url="http://sandbox") as c:
        yield c


async def init(client, template="sample-calculator") -> str:
    ws = str(uuid.uuid4())
    r = await client.post("/workspace/init", json={"workspace": ws, "template": template}, headers=TOKEN)
    assert r.status_code == 200, r.text
    return ws


async def test_token_required(client):
    r = await client.post("/fs/list", json={"workspace": str(uuid.uuid4())})
    assert r.status_code == 401


async def test_path_traversal_and_git_dir_blocked(client):
    ws = await init(client)
    for path in ["../../etc/passwd", "/etc/passwd", ".git/config", "tests/../../x"]:
        r = await client.post("/fs/read", json={"workspace": ws, "path": path}, headers=TOKEN)
        assert r.status_code == 400, path
    r = await client.post("/fs/read", json={"workspace": "../../etc", "path": "x"}, headers=TOKEN)
    assert r.status_code == 400


async def test_command_allow_list(client):
    ws = await init(client)
    for argv in (["bash", "-c", "id"], ["curl", "http://example.com"], ["git", "push"], ["git", "-c", "core.pager=x", "log"]):
        r = await client.post("/exec", json={"workspace": ws, "argv": argv}, headers=TOKEN)
        assert r.status_code == 403, argv
    r = await client.post("/exec", json={"workspace": ws, "argv": ["git", "status", "--short"]}, headers=TOKEN)
    assert r.status_code == 200 and r.json()["exit_code"] == 0


async def test_child_process_gets_no_secrets(client, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://secret")
    ws = await init(client)
    r = await client.post("/exec", json={"workspace": ws, "argv": ["python", "-c", "import os;print(sorted(os.environ))"]},
                          headers=TOKEN)
    assert "DATABASE_URL" not in r.json()["stdout"] and "SANDBOX_TOKEN" not in r.json()["stdout"]


async def test_real_pytest_fail_then_fix_then_pass(client):
    ws = await init(client)
    r = await client.post("/pytest", json={"workspace": ws}, headers=TOKEN)
    report = r.json()
    assert report["tests_passed"] is False
    assert (report["total"], report["passed"], report["failed"]) == (5, 4, 1)
    assert "divide_by_zero" in report["failures"][0]["test"]
    r = await client.post("/fs/write", json={"workspace": ws, "path": "calculator.py", "content": FIXED_CALCULATOR},
                          headers=TOKEN)
    assert r.status_code == 200
    report = (await client.post("/pytest", json={"workspace": ws}, headers=TOKEN)).json()
    assert report["tests_passed"] is True and report["passed"] == 5
    assert report["coverage_percent"] is not None and report["coverage_percent"] >= 80


async def test_command_timeout(client):
    ws = await init(client)
    r = await client.post("/exec", json={"workspace": ws, "argv": ["python", "-c", "import time; time.sleep(30)"],
                                         "timeout": 1}, headers=TOKEN)
    assert r.json()["timed_out"] is True
