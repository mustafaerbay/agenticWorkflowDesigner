import io
import socket
import tarfile
import uuid

import httpx
import pytest

from app.sandbox.server import app as sandbox_app
from app.services.examples import EXAMPLES
from app.tools.git_fetch import FetchError, validate_ref, validate_repo_url
from tests.test_engine import get_run, start_run
from tests.conftest import drain

TOKEN = {"X-Sandbox-Token": "test-sandbox-token-0123456789"}


@pytest.mark.parametrize("url", [
    "http://github.com/octocat/Hello-World",            # not https
    "https://user:token@github.com/octocat/Hello-World",  # credentials
    "https://evil.example.com/octocat/Hello-World",      # host not allowed
    "https://github.com:8443/octocat/Hello-World",       # custom port
    "https://github.com/octocat",                         # not owner/repo
    "file:///etc/passwd",
    "ext::sh -c id",
])
def test_rejected_urls(url):
    with pytest.raises(FetchError):
        validate_repo_url(url)


def test_accepted_url_and_refs():
    assert validate_repo_url("https://github.com/octocat/Hello-World.git")
    assert validate_ref("release/1.2") == "release/1.2"
    assert validate_ref(None) is None
    for bad in ("--upload-pack=x", "a..b", "x y"):
        with pytest.raises(FetchError):
            validate_ref(bad)


def archive(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


@pytest.fixture
async def sandbox_client():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=sandbox_app), base_url="http://sandbox") as c:
        yield c


async def test_import_extracts_safely_and_commits_baseline(sandbox_client):
    ws = str(uuid.uuid4())
    assert (await sandbox_client.post("/workspace/init", json={"workspace": ws}, headers=TOKEN)).status_code == 200
    good = archive({"README.md": b"hi", "src/app.py": b"print(1)"})
    r = await sandbox_client.post("/workspace/import", params={"workspace": ws, "path": "code/repo"},
                                  content=good, headers=TOKEN)
    assert r.status_code == 200 and r.json()["files"] == 2
    status = await sandbox_client.post("/exec", json={"workspace": ws, "argv": ["git", "status", "--porcelain"]},
                                       headers=TOKEN)
    assert status.json()["stdout"] == ""  # imported files are the new baseline, so diffs show only later edits
    # Target must be new or empty.
    r = await sandbox_client.post("/workspace/import", params={"workspace": ws, "path": "code/repo"},
                                  content=good, headers=TOKEN)
    assert r.status_code == 409
    # Path traversal inside the archive is rejected by the extraction filter.
    evil = archive({"../../escape.txt": b"x"})
    r = await sandbox_client.post("/workspace/import", params={"workspace": ws, "path": "other"},
                                  content=evil, headers=TOKEN)
    assert r.status_code == 400
    # The target path itself cannot escape the workspace.
    r = await sandbox_client.post("/workspace/import", params={"workspace": ws, "path": "../x"},
                                  content=good, headers=TOKEN)
    assert r.status_code == 400


def _github_reachable() -> bool:
    try:
        socket.create_connection(("github.com", 443), timeout=5).close()
        return True
    except OSError:
        return False


@pytest.mark.skipif(not _github_reachable(), reason="github.com not reachable from the test environment")
async def test_fetch_repository_example_clones_real_repo(sessions, bus, orchestrator, worker):
    example = next(e for e in EXAMPLES if e["name"].startswith("Fetch repository"))
    start = next(n for n in example["definition"]["nodes"] if n["type"] == "start")
    run_id = await start_run(sessions, bus, example["definition"], start["data"]["config"]["default_input"])
    await drain(bus, orchestrator, worker)
    run, nrs = await get_run(sessions, run_id)
    assert run.status == "COMPLETED", run.error
    fetch = next(nr for nr in nrs if nr.node_id == "repo_fetch_agent")
    result = fetch.output["last_result"]
    assert len(result["commit"]) == 40 and result["path"] == "repo" and result["files"] >= 1
    listing = next(nr for nr in nrs if nr.node_id == "list_repo").output["files"]
    assert "repo/README" in listing
    assert not any("/.git/" in f or f.startswith("repo/.git") for f in listing)
