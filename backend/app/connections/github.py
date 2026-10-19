"""GitHub REST client for the GitHub connection.

Only repositories on the connection's allow-list can be used. Changes are uploaded through the
Git Data API (blobs -> tree -> commit -> new branch -> pull request), so nothing is pushed from the
sandbox and existing branches are never modified or force-updated. The platform never merges.
"""

import base64
import re
from typing import Any

import httpx

from app.tools.registry import ToolError

# Test hook: inject an httpx transport.
HTTP_TRANSPORT: httpx.AsyncBaseTransport | None = None
REPO_RE = re.compile(r"^[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+$")
BRANCH_RE = re.compile(r"^[A-Za-z0-9._/\-]{1,200}$")


def check_repo(config: dict[str, Any], repo: str) -> str:
    repo = str(repo or "").strip().removeprefix("https://github.com/").removesuffix(".git").strip("/")
    if not REPO_RE.match(repo):
        raise ToolError(f"'{repo}' is not a repository name like owner/name", retryable=False)
    allowed = [r.lower() for r in config.get("allowed_repos") or []]
    if repo.lower() not in allowed:
        raise ToolError(f"repository {repo} is not on this GitHub connection's allow-list", retryable=False)
    return repo


class GitHub:
    def __init__(self, config: dict[str, Any], token: str | None) -> None:
        self.config = config
        self.token = token
        self.api = str(config.get("api_url") or "https://api.github.com").rstrip("/")

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                   "User-Agent": "agentic-sdlc"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        async with httpx.AsyncClient(base_url=self.api, timeout=30, transport=HTTP_TRANSPORT,
                                     follow_redirects=False) as client:
            try:
                response = await client.request(method, path, headers=headers, **kwargs)
            except httpx.HTTPError as exc:
                raise ToolError(f"GitHub unreachable: {type(exc).__name__}", retryable=True) from exc
        if response.status_code in (401, 403) and "rate limit" not in response.text.lower():
            raise ToolError(f"GitHub denied access (HTTP {response.status_code}); check the token's permissions",
                            retryable=False)
        if response.status_code == 404:
            raise ToolError(f"GitHub resource not found: {path}", retryable=False)
        if response.status_code == 422:
            raise ToolError(f"GitHub rejected the request: {response.text[:300]}", retryable=False)
        if response.status_code >= 400:
            raise ToolError(f"GitHub error (HTTP {response.status_code})", retryable=response.status_code >= 429)
        return response.json() if response.content else None

    async def default_branch(self, repo: str) -> str:
        return str((await self._request("GET", f"/repos/{repo}"))["default_branch"])

    async def list_issues(self, repo: str, label: str | None, limit: int = 20) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"state": "open", "per_page": min(limit, 100), "sort": "created", "direction": "asc"}
        if label:
            params["labels"] = label
        items = await self._request("GET", f"/repos/{repo}/issues", params=params)
        return [{"number": i["number"], "title": i["title"], "body": (i.get("body") or "")[:8000],
                 "url": i["html_url"], "labels": [lbl["name"] for lbl in i.get("labels") or []]}
                for i in items if "pull_request" not in i][:limit]

    async def open_pulls(self, repo: str, branch_prefix: str) -> list[dict[str, Any]]:
        pulls = await self._request("GET", f"/repos/{repo}/pulls", params={"state": "open", "per_page": 100})
        return [{"number": p["number"], "url": p["html_url"], "branch": p["head"]["ref"], "title": p["title"]}
                for p in pulls if str(p["head"]["ref"]).startswith(branch_prefix)]

    async def pull_status(self, repo: str, number: int) -> dict[str, Any]:
        p = await self._request("GET", f"/repos/{repo}/pulls/{int(number)}")
        merged = bool(p.get("merged"))
        state = "merged" if merged else str(p["state"])  # open | closed | merged
        return {"state": state, "merged": merged, "closed": state != "open", "url": p["html_url"],
                "number": p["number"], "review_comments": p.get("review_comments", 0)}

    async def create_pull_request(self, repo: str, branch: str, title: str, body: str,
                                  changes: list[dict[str, Any]], base: str | None = None) -> dict[str, Any]:
        if not BRANCH_RE.match(branch) or ".." in branch:
            raise ToolError(f"invalid branch name {branch!r}", retryable=False)
        if not changes:
            raise ToolError("there are no code changes to propose", retryable=False)
        base = base or await self.default_branch(repo)
        ref = await self._request("GET", f"/repos/{repo}/git/ref/heads/{base}")
        base_sha = ref["object"]["sha"]
        base_tree = (await self._request("GET", f"/repos/{repo}/git/commits/{base_sha}"))["tree"]["sha"]
        tree: list[dict[str, Any]] = []
        for change in changes:
            path = str(change["path"]).lstrip("/")
            if not path or ".." in path.split("/") or path.startswith(".git/"):
                raise ToolError(f"invalid file path {path!r}", retryable=False)
            if change.get("deleted"):
                tree.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
                continue
            blob = await self._request("POST", f"/repos/{repo}/git/blobs", json={
                "content": base64.b64encode(change["content"].encode()).decode(), "encoding": "base64"})
            tree.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        new_tree = await self._request("POST", f"/repos/{repo}/git/trees", json={"base_tree": base_tree, "tree": tree})
        commit = await self._request("POST", f"/repos/{repo}/git/commits", json={
            "message": title, "tree": new_tree["sha"], "parents": [base_sha]})
        # A new branch only: never move an existing ref.
        await self._request("POST", f"/repos/{repo}/git/refs", json={"ref": f"refs/heads/{branch}", "sha": commit["sha"]})
        pull = await self._request("POST", f"/repos/{repo}/pulls", json={
            "title": title[:250], "head": branch, "base": base, "body": body[:60_000], "maintainer_can_modify": True})
        return {"number": pull["number"], "url": pull["html_url"], "branch": branch, "base": base,
                "commit": commit["sha"], "files_changed": [c["path"] for c in changes]}


def clone_auth_env(token: str | None) -> dict[str, str]:
    """Git config passed through the environment (not argv) so the token never shows in process lists."""
    if not token:
        return {}
    basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    return {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
            "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {basic}"}
