"""Fetch a public git repository for the git_clone tool.

Runs in the worker (the sandbox deliberately has no Internet access). The clone is
hardened against untrusted repositories: HTTPS only, allow-listed hosts, no
credentials, no hooks, no submodules, no LFS smudge, shallow, size-limited, and the
child process gets a minimal environment without the worker's secrets. The result is
packed as a tar.gz (without .git) and handed to the sandbox for safe extraction.
"""

import asyncio
import io
import os
import re
import signal
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from app.core.config import get_settings

REF_PATTERN = re.compile(r"^[A-Za-z0-9._/\-]{1,200}$")


class FetchError(Exception):
    pass


@dataclass
class FetchedRepo:
    archive: bytes
    commit: str
    files: int
    bytes: int


def validate_repo_url(url: str) -> str:
    settings = get_settings()
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    if parts.scheme != "https":
        raise FetchError("repo_url must use https://")
    if parts.username or parts.password:
        raise FetchError("credentials in repo_url are not allowed (only public repositories are supported)")
    if parts.query or parts.fragment or parts.port not in (None, 443):
        raise FetchError("repo_url must not contain a query, fragment or custom port")
    if host not in settings.git_clone_hosts:
        raise FetchError(f"host '{host}' is not allowed (allowed: {', '.join(sorted(settings.git_clone_hosts))})")
    if not re.fullmatch(r"(/[A-Za-z0-9._\-]+){2,}(\.git)?/?", parts.path or ""):
        raise FetchError("repo_url must look like https://<host>/<owner>/<repository>")
    return url.strip()


def validate_ref(ref: str | None) -> str | None:
    if ref in (None, ""):
        return None
    if not REF_PATTERN.match(ref) or ref.startswith("-") or ".." in ref:
        raise FetchError("ref must be a branch or tag name")
    return ref


def _child_env(home: str) -> dict[str, str]:
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": home,
        "LANG": "C.UTF-8",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_LFS_SKIP_SMUDGE": "1",
        "GIT_ASKPASS": "/bin/false",
    }


async def _run(argv: list[str], cwd: str, env: dict[str, str], timeout: float) -> str:
    proc = await asyncio.create_subprocess_exec(
        *argv, cwd=cwd, env=env, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError as exc:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await proc.communicate()
        raise FetchError(f"git timed out after {int(timeout)}s") from exc
    if proc.returncode != 0:
        raise FetchError(f"git failed: {stderr.decode(errors='replace').strip()[-500:]}")
    return stdout.decode(errors="replace")


async def fetch_repository(repo_url: str, ref: str | None, depth: int = 1) -> FetchedRepo:
    settings = get_settings()
    url = validate_repo_url(repo_url)
    ref = validate_ref(ref)
    with tempfile.TemporaryDirectory(prefix="git-fetch-") as tmp:
        env = _child_env(tmp)
        dest = os.path.join(tmp, "repo")
        argv = [
            "git", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
            "-c", "core.symlinks=false", "-c", "credential.helper=",
            "clone", "--quiet", "--depth", str(depth), "--single-branch", "--no-tags", "--no-recurse-submodules",
        ]
        if ref:
            argv += ["--branch", ref]
        argv += ["--", url, dest]
        await _run(argv, tmp, env, settings.git_clone_timeout)
        commit = (await _run(["git", "rev-parse", "HEAD"], dest, env, 30)).strip()

        root = Path(dest)
        total = files = 0
        limit = settings.git_clone_max_mb * 1024 * 1024
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
            for path in sorted(root.rglob("*")):
                rel = path.relative_to(root)
                if rel.parts[0] == ".git":
                    continue
                if path.is_symlink():
                    continue  # never carry links into the workspace
                if path.is_file():
                    files += 1
                    total += path.stat().st_size
                    if files > settings.git_clone_max_files:
                        raise FetchError(f"repository has more than {settings.git_clone_max_files} files")
                    if total > limit:
                        raise FetchError(f"repository exceeds {settings.git_clone_max_mb} MB")
                    tar.add(path, arcname=str(rel), recursive=False)
        return FetchedRepo(archive=buffer.getvalue(), commit=commit, files=files, bytes=total)
