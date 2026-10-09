"""Sandbox service: the only process that touches agent workspaces or runs commands.

Runs in its own container with no secrets, no Docker socket, a read-only root
filesystem, dropped capabilities, and a network that only the worker can reach.
Commands are argv-only (no shell), allow-listed, time- and resource-limited.
"""

import asyncio
import hmac
import io
import json
import os
import re
import resource
import shutil
import signal
import tarfile
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.config import get_settings
from app.core.logging import configure_logging

settings = get_settings()
configure_logging("agentic-sandbox", settings.log_level)
app = FastAPI(title="Agentic Sandbox", docs_url=None, redoc_url=None, openapi_url=None)

GIT_ALLOWED = {"init", "add", "commit", "status", "diff", "log", "show", "rev-parse", "apply", "ls-files"}
GIT_FORBIDDEN_FLAGS = ("-c", "--exec-path", "--git-dir", "--work-tree", "--upload-pack", "--receive-pack")
TEMPLATE_NAME = re.compile(r"^[a-z0-9][a-z0-9_\-]{0,63}$")
MAX_FILE_BYTES = 1_000_000


def require_token(x_sandbox_token: str = Header(default="")) -> None:
    if not hmac.compare_digest(x_sandbox_token, settings.sandbox_token):
        raise HTTPException(status_code=401, detail="invalid sandbox token")


def workspace_root(workspace: str) -> Path:
    try:
        uuid.UUID(workspace)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="workspace must be a UUID") from exc
    return Path(settings.workspaces_dir) / workspace


def safe_path(workspace: str, relative: str) -> Path:
    root = workspace_root(workspace).resolve()
    if not root.exists():
        raise HTTPException(status_code=404, detail="workspace not initialised")
    if relative.startswith("/") or "\x00" in relative:
        raise HTTPException(status_code=400, detail="path must be relative to the workspace")
    target = (root / relative).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(status_code=400, detail="path escapes the workspace")
    if ".git" in target.relative_to(root).parts:
        raise HTTPException(status_code=400, detail="direct access to .git is not allowed")
    return target


def _limits() -> None:  # runs in the child before exec
    os.setsid()
    resource.setrlimit(resource.RLIMIT_CPU, (120, 130))
    resource.setrlimit(resource.RLIMIT_FSIZE, (50 * 1024 * 1024, 50 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NPROC, (128, 128))
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))


def _child_env() -> dict[str, str]:
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": "/tmp/sandbox-home",
        "LANG": "C.UTF-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_AUTHOR_NAME": "Agentic SDLC",
        "GIT_AUTHOR_EMAIL": "agent@agentic-sdlc.local",
        "GIT_COMMITTER_NAME": "Agentic SDLC",
        "GIT_COMMITTER_EMAIL": "agent@agentic-sdlc.local",
        "COVERAGE_FILE": "/tmp/.coverage",
    }


def check_argv(argv: list[str]) -> None:
    if not argv:
        raise HTTPException(status_code=400, detail="empty command")
    program = argv[0]
    if program not in settings.sandbox_allowed_commands:
        raise HTTPException(status_code=403, detail=f"command '{program}' is not allow-listed")
    if program == "git":
        sub = next((a for a in argv[1:] if not a.startswith("-")), None)
        if sub not in GIT_ALLOWED:
            raise HTTPException(status_code=403, detail=f"git subcommand '{sub}' is not allowed")
        if any(a == f or a.startswith(f + "=") for a in argv[1:] for f in GIT_FORBIDDEN_FLAGS):
            raise HTTPException(status_code=403, detail="git configuration flags are not allowed")


async def run_argv(cwd: Path, argv: list[str], timeout: int) -> dict[str, Any]:
    os.makedirs("/tmp/sandbox-home", exist_ok=True)
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(cwd),
        env=_child_env(),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.DEVNULL,
        preexec_fn=_limits,
    )
    timed_out = False
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        stdout, stderr = await proc.communicate()
    limit = settings.sandbox_max_output_bytes
    return {
        "argv": argv,
        "exit_code": proc.returncode if not timed_out else -9,
        "timed_out": timed_out,
        "stdout": stdout[-limit:].decode(errors="replace"),
        "stderr": stderr[-limit:].decode(errors="replace"),
    }


class InitRequest(BaseModel):
    workspace: str
    template: str | None = None


class ExecRequest(BaseModel):
    workspace: str
    argv: list[str] = Field(min_length=1, max_length=64)
    timeout: int = Field(default=60, ge=1, le=600)


class PathRequest(BaseModel):
    workspace: str
    path: str = "."


class WriteRequest(BaseModel):
    workspace: str
    path: str
    content: str = Field(max_length=MAX_FILE_BYTES)


class SearchRequest(BaseModel):
    workspace: str
    query: str = Field(min_length=1, max_length=200)
    path: str = "."
    regex: bool = False
    max_results: int = Field(default=100, ge=1, le=1000)


class PytestRequest(BaseModel):
    workspace: str
    path: str = ""
    extra_args: list[str] = Field(default_factory=list, max_length=20)
    timeout: int = Field(default=300, ge=1, le=1800)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/workspace/init", dependencies=[Depends(require_token)])
async def init_workspace(req: InitRequest) -> dict[str, Any]:
    root = workspace_root(req.workspace)
    if (root / ".git").exists():
        return {"created": False, "path": str(root)}
    root.mkdir(parents=True, exist_ok=True)
    if req.template:
        if not TEMPLATE_NAME.match(req.template):
            raise HTTPException(status_code=400, detail="invalid template name")
        source = Path(settings.templates_dir) / req.template
        if not source.is_dir():
            raise HTTPException(status_code=404, detail=f"template '{req.template}' not found")
        shutil.copytree(source, root, dirs_exist_ok=True)
    for argv in (["git", "init", "-q", "-b", "main"], ["git", "add", "-A"],
                 ["git", "commit", "-q", "--allow-empty", "-m", "Initial workspace"]):
        result = await run_argv(root, argv, 30)
        if result["exit_code"] != 0:
            raise HTTPException(status_code=500, detail=f"git setup failed: {result['stderr'][-500:]}")
    return {"created": True, "path": str(root), "template": req.template}


@app.post("/workspace/import", dependencies=[Depends(require_token)])
async def import_archive(request: Request, workspace: str, path: str, label: str = "imported files") -> dict[str, Any]:
    """Extract a tar.gz into an empty workspace directory and commit it as the new baseline."""
    root = workspace_root(workspace)
    if not (root / ".git").exists():
        raise HTTPException(status_code=409, detail="workspace not initialised")
    target = safe_path(workspace, path or ".")
    if target.exists() and (not target.is_dir() or any(p.name != ".git" for p in target.iterdir())):
        raise HTTPException(status_code=409, detail=f"target path '{path}' already exists and is not empty")
    body = await request.body()
    if len(body) > 500 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="archive too large")
    target.mkdir(parents=True, exist_ok=True)
    try:
        with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as tar:
            # The "data" filter rejects absolute paths, '..', links escaping the target and device files.
            tar.extractall(target, filter="data")
    except (tarfile.TarError, OSError) as exc:
        shutil.rmtree(target, ignore_errors=True)
        raise HTTPException(status_code=400, detail=f"invalid archive: {exc}") from exc
    for argv in (["git", "add", "-A"], ["git", "commit", "-q", "--allow-empty", "-m", f"Import {label[:200]}"]):
        result = await run_argv(root.resolve(), argv, 120)
        if result["exit_code"] != 0:
            raise HTTPException(status_code=500, detail=f"git baseline commit failed: {result['stderr'][-500:]}")
    files = sum(1 for p in target.rglob("*") if p.is_file() and ".git" not in p.relative_to(root.resolve()).parts)
    return {"path": path, "files": files}


@app.post("/exec", dependencies=[Depends(require_token)])
async def exec_command(req: ExecRequest) -> dict[str, Any]:
    check_argv(req.argv)
    root = safe_path(req.workspace, ".")
    return await run_argv(root, req.argv, min(req.timeout, settings.sandbox_command_timeout * 5))


@app.post("/fs/list", dependencies=[Depends(require_token)])
async def list_files(req: PathRequest) -> dict[str, Any]:
    base = safe_path(req.workspace, req.path)
    root = workspace_root(req.workspace).resolve()
    files: list[str] = []
    for path in sorted(base.rglob("*")):
        rel = path.relative_to(root)
        if ".git" in rel.parts or "__pycache__" in rel.parts or path.is_dir():
            continue
        files.append(str(rel))
        if len(files) >= 2000:
            break
    return {"files": files, "truncated": len(files) >= 2000}


@app.post("/fs/read", dependencies=[Depends(require_token)])
async def read_file(req: PathRequest) -> dict[str, Any]:
    target = safe_path(req.workspace, req.path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"file not found: {req.path}")
    data = target.read_bytes()[:MAX_FILE_BYTES]
    return {"path": req.path, "content": data.decode(errors="replace"), "bytes": target.stat().st_size}


@app.post("/fs/write", dependencies=[Depends(require_token)])
async def write_file(req: WriteRequest) -> dict[str, Any]:
    target = safe_path(req.workspace, req.path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(req.content)
    return {"path": req.path, "bytes": len(req.content.encode())}


@app.post("/fs/search", dependencies=[Depends(require_token)])
async def search_files(req: SearchRequest) -> dict[str, Any]:
    base = safe_path(req.workspace, req.path)
    root = workspace_root(req.workspace).resolve()
    try:
        pattern = re.compile(req.query if req.regex else re.escape(req.query))
    except re.error as exc:
        raise HTTPException(status_code=400, detail=f"invalid regex: {exc}") from exc
    matches: list[dict[str, Any]] = []
    for path in sorted(base.rglob("*")):
        rel = path.relative_to(root)
        if ".git" in rel.parts or not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
            continue
        for lineno, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
            if pattern.search(line):
                matches.append({"path": str(rel), "line": lineno, "text": line[:300]})
                if len(matches) >= req.max_results:
                    return {"matches": matches, "truncated": True}
    return {"matches": matches, "truncated": False}


@app.post("/pytest", dependencies=[Depends(require_token)])
async def run_pytest(req: PytestRequest) -> dict[str, Any]:
    root = safe_path(req.workspace, ".")
    target = safe_path(req.workspace, req.path or ".")
    for arg in req.extra_args:
        if not re.match(r"^-[A-Za-z0-9\-=_.:]+$|^[A-Za-z0-9_\-./:]+$", arg) or arg.startswith(("--rootdir", "-p", "--junit", "--cov")):
            raise HTTPException(status_code=400, detail=f"argument not allowed: {arg}")
    run_id = uuid.uuid4().hex
    junit, cov = f"/tmp/junit-{run_id}.xml", f"/tmp/cov-{run_id}.json"
    argv = ["python", "-m", "pytest", "-q", "--tb=short", "-p", "no:cacheprovider",
            f"--junitxml={junit}", "--cov=.", f"--cov-report=json:{cov}",
            str(target.relative_to(root.resolve()) if target != root.resolve() else "."), *req.extra_args]
    result = await run_argv(root, argv, req.timeout)
    report: dict[str, Any] = {
        "exit_code": result["exit_code"],
        "timed_out": result["timed_out"],
        "total": 0, "passed": 0, "failed": 0, "errors": 0, "skipped": 0,
        "failures": [],
        "coverage_percent": None,
        "output": (result["stdout"] + result["stderr"])[-8000:],
    }
    try:
        tree = ET.parse(junit)
        for case in tree.iter("testcase"):
            report["total"] += 1
            name = f"{case.get('classname')}::{case.get('name')}"
            failure = case.find("failure")
            error = case.find("error")
            if failure is not None:
                report["failed"] += 1
                report["failures"].append({"test": name, "message": (failure.get("message") or "")[:500]})
            elif error is not None:
                report["errors"] += 1
                report["failures"].append({"test": name, "message": (error.get("message") or "")[:500]})
            elif case.find("skipped") is not None:
                report["skipped"] += 1
            else:
                report["passed"] += 1
    except (FileNotFoundError, ET.ParseError):
        pass
    try:
        with open(cov) as fh:
            report["coverage_percent"] = round(json.load(fh)["totals"]["percent_covered"], 2)
    except (FileNotFoundError, KeyError, ValueError):
        pass
    for leftover in (junit, cov):
        try:
            os.remove(leftover)
        except FileNotFoundError:
            pass
    report["tests_passed"] = result["exit_code"] == 0 and report["total"] > 0
    report["summary"] = (
        f"{report['passed']} passed, {report['failed']} failed, {report['errors']} errors, "
        f"{report['skipped']} skipped (exit {result['exit_code']})"
    )
    return report
