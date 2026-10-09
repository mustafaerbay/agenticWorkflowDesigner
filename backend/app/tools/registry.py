"""Tool registry. Tools run with least privilege: every call is checked against the
agent's permission list by the runtime, arguments are schema-validated, and all
workspace access goes through the isolated sandbox service."""

import hashlib
import os
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import jsonschema

from app.core.config import get_settings


class ToolError(Exception):
    """A tool call failed. retryable=False means repeating the same call cannot succeed."""

    def __init__(self, message: str, retryable: bool = True) -> None:
        super().__init__(message)
        self.retryable = retryable


class SandboxClient:
    def __init__(
        self, base_url: str | None = None, token: str | None = None, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        settings = get_settings()
        self.base_url = base_url or settings.sandbox_url
        self.token = token or settings.sandbox_token
        self.transport = transport

    async def call(self, path: str, payload: dict[str, Any], timeout: float = 120) -> dict[str, Any]:
        async with httpx.AsyncClient(base_url=self.base_url, timeout=timeout + 15, transport=self.transport) as client:
            try:
                response = await client.post(path, json=payload, headers={"X-Sandbox-Token": self.token})
            except httpx.HTTPError as exc:
                raise ToolError(f"sandbox unreachable: {exc}") from exc
        if response.status_code >= 400:
            try:
                detail = response.json().get("detail")
            except ValueError:
                detail = response.text[:300]
            raise ToolError(f"sandbox error ({response.status_code}): {detail}", retryable=response.status_code >= 500)
        return response.json()

    async def upload(self, path: str, params: dict[str, str], content: bytes, timeout: float = 300) -> dict[str, Any]:
        async with httpx.AsyncClient(base_url=self.base_url, timeout=timeout, transport=self.transport) as client:
            try:
                response = await client.post(path, params=params, content=content, headers={
                    "X-Sandbox-Token": self.token, "Content-Type": "application/gzip"})
            except httpx.HTTPError as exc:
                raise ToolError(f"sandbox unreachable: {exc}") from exc
        if response.status_code >= 400:
            try:
                detail = response.json().get("detail")
            except ValueError:
                detail = response.text[:300]
            raise ToolError(f"sandbox error ({response.status_code}): {detail}", retryable=response.status_code >= 500)
        return response.json()


@dataclass
class ToolContext:
    run_id: str
    node_run_id: str
    sandbox: SandboxClient
    workspace_template: str | None = None
    save_artifact: Callable[[str, str, bytes], Awaitable[dict[str, Any]]] | None = None
    build_report: Callable[[], Awaitable[str]] | None = None
    workspace_ready: bool = False

    async def ensure_workspace(self) -> None:
        if not self.workspace_ready:
            await self.sandbox.call("/workspace/init", {"workspace": self.run_id, "template": self.workspace_template})
            self.workspace_ready = True


Handler = Callable[[ToolContext, dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Handler
    output_schema: dict[str, Any] = field(default_factory=dict)
    dangerous: bool = False

    def public(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
            "output_schema": self.output_schema,
            "dangerous": self.dangerous,
        }


def _obj(props: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required or [], "additionalProperties": False}


async def _list_files(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    await ctx.ensure_workspace()
    return await ctx.sandbox.call("/fs/list", {"workspace": ctx.run_id, "path": args.get("path", ".")})


async def _read_file(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    await ctx.ensure_workspace()
    return await ctx.sandbox.call("/fs/read", {"workspace": ctx.run_id, "path": args["path"]})


async def _search_files(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    await ctx.ensure_workspace()
    return await ctx.sandbox.call("/fs/search", {"workspace": ctx.run_id, **args})


async def _write_file(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    await ctx.ensure_workspace()
    return await ctx.sandbox.call("/fs/write", {"workspace": ctx.run_id, **args})


async def _run_command(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    await ctx.ensure_workspace()
    timeout = int(args.get("timeout", 60))
    result = await ctx.sandbox.call(
        "/exec", {"workspace": ctx.run_id, "argv": args["argv"], "timeout": timeout}, timeout=timeout
    )
    result["success"] = result.get("exit_code") == 0
    return result


async def _run_tests(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    await ctx.ensure_workspace()
    timeout = int(args.get("timeout", 300))
    return await ctx.sandbox.call(
        "/pytest",
        {"workspace": ctx.run_id, "path": args.get("path", ""), "extra_args": args.get("extra_args", []), "timeout": timeout},
        timeout=timeout,
    )


async def _git_diff(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    await ctx.ensure_workspace()
    await ctx.sandbox.call("/exec", {"workspace": ctx.run_id, "argv": ["git", "add", "-A"], "timeout": 30})
    diff = await ctx.sandbox.call(
        "/exec", {"workspace": ctx.run_id, "argv": ["git", "diff", "--cached", "HEAD"], "timeout": 30}
    )
    names = await ctx.sandbox.call(
        "/exec", {"workspace": ctx.run_id, "argv": ["git", "diff", "--cached", "--name-only", "HEAD"], "timeout": 30}
    )
    files = [f for f in names["stdout"].splitlines() if f]
    return {"diff": diff["stdout"], "files_changed": files, "has_changes": bool(files)}


async def _generate_patch(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    result = await _git_diff(ctx, {})
    if ctx.save_artifact is None:
        raise ToolError("artifact storage unavailable")
    name = args.get("name") or "changes.patch"
    artifact = await ctx.save_artifact(name, "patch", result["diff"].encode())
    return {**artifact, "files_changed": result["files_changed"], "has_changes": result["has_changes"]}


async def _git_clone(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    from app.tools.git_fetch import FetchError, fetch_repository

    path = str(args.get("path") or "repo").strip().strip("/") or "."
    await ctx.ensure_workspace()
    try:
        repo = await fetch_repository(args["repo_url"], args.get("ref"), int(args.get("depth") or 1))
    except FetchError as exc:
        raise ToolError(str(exc), retryable=exc.retryable) from exc
    label = f"{args['repo_url']}@{repo.commit[:12]}"
    imported = await ctx.sandbox.upload(
        "/workspace/import", {"workspace": ctx.run_id, "path": path, "label": label}, repo.archive
    )
    return {"success": True, "repo_url": args["repo_url"], "ref": args.get("ref"), "commit": repo.commit,
            "path": path, "files": imported["files"], "bytes": repo.bytes}


async def _create_report(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    if ctx.save_artifact is None:
        raise ToolError("artifact storage unavailable")
    title = args.get("title") or "Execution report"
    body = args.get("content")
    if not body and ctx.build_report is not None:
        body = await ctx.build_report()
    content = f"# {title}\n\n{body or ''}\n"
    artifact = await ctx.save_artifact(args.get("name") or "report.md", "report", content.encode())
    return {**artifact, "title": title, "preview": content[:2000]}


TEST_REPORT_SCHEMA = _obj({
    "tests_passed": {"type": "boolean"},
    "exit_code": {"type": "integer"},
    "total": {"type": "integer"},
    "passed": {"type": "integer"},
    "failed": {"type": "integer"},
    "errors": {"type": "integer"},
    "skipped": {"type": "integer"},
    "coverage_percent": {"type": ["number", "null"]},
    "summary": {"type": "string"},
    "output": {"type": "string"},
    "failures": {"type": "array"},
    "timed_out": {"type": "boolean"},
})
ARTIFACT_SCHEMA = {"artifact_id": {"type": "string"}, "name": {"type": "string"}, "bytes": {"type": "integer"}}

TOOLS: dict[str, ToolSpec] = {
    spec.name: spec
    for spec in [
        ToolSpec("list_files", "List files in the workspace (recursively).",
                 _obj({"path": {"type": "string", "default": "."}}), _list_files,
                 _obj({"files": {"type": "array"}, "truncated": {"type": "boolean"}})),
        ToolSpec("read_file", "Read a text file from the workspace.",
                 _obj({"path": {"type": "string"}}, ["path"]), _read_file,
                 _obj({"path": {"type": "string"}, "content": {"type": "string"}, "bytes": {"type": "integer"}})),
        ToolSpec("search_files", "Search workspace files for a literal string or regex.",
                 _obj({"query": {"type": "string"}, "path": {"type": "string"}, "regex": {"type": "boolean"},
                       "max_results": {"type": "integer"}}, ["query"]), _search_files,
                 _obj({"matches": {"type": "array"}, "truncated": {"type": "boolean"}})),
        ToolSpec("write_file", "Create or overwrite a file in the isolated workspace.",
                 _obj({"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"]), _write_file,
                 _obj({"path": {"type": "string"}, "bytes": {"type": "integer"}})),
        ToolSpec("run_command", "Run an allow-listed command (argv list, no shell) in the sandbox.",
                 _obj({"argv": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                       "timeout": {"type": "integer", "minimum": 1, "maximum": 600}}, ["argv"]), _run_command,
                 _obj({"exit_code": {"type": "integer"}, "success": {"type": "boolean"}, "stdout": {"type": "string"},
                       "stderr": {"type": "string"}, "timed_out": {"type": "boolean"}}), dangerous=True),
        ToolSpec("run_tests", "Run the workspace's pytest suite and return structured results with coverage.",
                 _obj({"path": {"type": "string"}, "extra_args": {"type": "array", "items": {"type": "string"}},
                       "timeout": {"type": "integer", "minimum": 1, "maximum": 1800}}), _run_tests, TEST_REPORT_SCHEMA),
        ToolSpec("git_diff", "Show all changes made in the workspace since it was created.",
                 _obj({}), _git_diff,
                 _obj({"diff": {"type": "string"}, "files_changed": {"type": "array"}, "has_changes": {"type": "boolean"}})),
        ToolSpec("generate_patch", "Store the workspace changes as a patch artifact.",
                 _obj({"name": {"type": "string"}}), _generate_patch,
                 _obj({**ARTIFACT_SCHEMA, "files_changed": {"type": "array"}, "has_changes": {"type": "boolean"}})),
        ToolSpec("git_clone",
                 "Fetch a public HTTPS git repository (branch or tag) into a workspace path. The path must be new or empty.",
                 _obj({"repo_url": {"type": "string", "minLength": 1},
                       "ref": {"type": "string"},
                       "path": {"type": "string"},
                       "depth": {"type": "integer", "minimum": 1, "maximum": 50}}, ["repo_url"]),
                 _git_clone,
                 _obj({"success": {"type": "boolean"}, "repo_url": {"type": "string"}, "ref": {"type": ["string", "null"]},
                       "commit": {"type": "string"}, "path": {"type": "string"}, "files": {"type": "integer"},
                       "bytes": {"type": "integer"}})),
        ToolSpec("create_report", "Create a Markdown development report artifact (auto-generated if no content).",
                 _obj({"title": {"type": "string"}, "content": {"type": "string"}, "name": {"type": "string"}}),
                 _create_report, _obj({**ARTIFACT_SCHEMA, "title": {"type": "string"}, "preview": {"type": "string"}})),
    ]
}


def tool_catalog() -> dict[str, dict[str, Any]]:
    return {name: spec.public() for name, spec in TOOLS.items()}


async def execute_tool(
    name: str, args: dict[str, Any], ctx: ToolContext, allowed: list[str] | None
) -> tuple[dict[str, Any], float]:
    """Run a tool after enforcing permissions and validating arguments."""
    if allowed is not None and name not in allowed:
        raise ToolError(f"tool '{name}' is not permitted for this agent", retryable=False)
    spec = TOOLS.get(name)
    if spec is None:
        raise ToolError(f"unknown tool '{name}'", retryable=False)
    try:
        jsonschema.validate(args, spec.parameters)
    except jsonschema.ValidationError as exc:
        raise ToolError(f"invalid arguments for '{name}': {exc.message}", retryable=False) from exc
    started = time.monotonic()
    result = await spec.handler(ctx, args)
    return result, round((time.monotonic() - started) * 1000, 1)


def write_artifact_file(run_id: str, name: str, content: bytes) -> tuple[str, str]:
    """Persist artifact bytes under ARTIFACTS_DIR/<run_id>/; returns (path, sha256)."""
    safe_name = "".join(c for c in Path(name).name if c.isalnum() or c in "._-") or "artifact"
    directory = Path(get_settings().artifacts_dir) / run_id
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{int(time.time() * 1000)}-{safe_name}"
    path.write_bytes(content)
    os.chmod(path, 0o640)
    return str(path), hashlib.sha256(content).hexdigest()
