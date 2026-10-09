"""Test fixtures. DB-backed tests use a dedicated `<db>_test` database migrated with Alembic.

Run inside the Compose network:  docker compose -p agentic-sdlc-dev run --rm api pytest -q
"""

import os
import tempfile
import uuid
from collections.abc import AsyncIterator
from typing import Any

_base_url = os.environ.get("DATABASE_URL", "postgresql+asyncpg://agentic:agentic@postgres:5432/agentic")
_server_url, _db_name = _base_url.rsplit("/", 1)
TEST_DB = f"{_db_name}_test"
os.environ["DATABASE_URL"] = f"{_server_url}/{TEST_DB}"
_tmp = tempfile.mkdtemp(prefix="agentic-tests-")
os.environ["WORKSPACES_DIR"] = os.path.join(_tmp, "workspaces")
os.environ["ARTIFACTS_DIR"] = os.path.join(_tmp, "artifacts")
os.environ.setdefault("TEMPLATES_DIR", os.path.join(os.path.dirname(__file__), "..", "workspace_templates"))
os.environ["SANDBOX_TOKEN"] = "test-sandbox-token-0123456789"
os.environ["JWT_SECRET"] = "test-jwt-secret-0123456789abcdef"
os.environ["ADMIN_EMAIL"] = "admin@test.local"
os.environ["ADMIN_PASSWORD"] = "admin-password-for-tests"
os.makedirs(os.environ["WORKSPACES_DIR"], exist_ok=True)
os.makedirs(os.environ["ARTIFACTS_DIR"], exist_ok=True)

import asyncpg  # noqa: E402
import httpx  # noqa: E402
import pytest  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker  # noqa: E402

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()

from app.core.db import get_engine, session_factory  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.models import User  # noqa: E402
from app.orchestration.bus import InMemoryBus  # noqa: E402
from app.sandbox.server import app as sandbox_app  # noqa: E402
from app.tools.registry import SandboxClient  # noqa: E402
from app.workers.agent_worker import AgentWorker  # noqa: E402
from app.workers.orchestrator import Orchestrator  # noqa: E402

TABLES = [
    "audit_logs", "agent_artifacts", "approvals", "execution_events", "node_runs", "workflow_runs",
    "workflow_edges", "workflow_nodes", "workflow_versions", "workflows", "agent_versions", "agents",
    "model_providers", "tools", "users",
]


@pytest.fixture(scope="session", autouse=True)
async def database() -> AsyncIterator[None]:
    dsn = _server_url.replace("postgresql+asyncpg", "postgresql") + "/postgres"
    conn = await asyncpg.connect(dsn)
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{TEST_DB}" WITH (FORCE)')
        await conn.execute(f'CREATE DATABASE "{TEST_DB}"')
    finally:
        await conn.close()
    # Apply the real migrations so they are exercised by the suite.
    import asyncio

    from alembic import command
    from alembic.config import Config

    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "..", "alembic"))
    await asyncio.to_thread(command.upgrade, cfg, "head")
    yield
    await get_engine().dispose()


@pytest.fixture
async def sessions() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    factory = session_factory()
    async with factory() as session:
        await session.execute(text(f"TRUNCATE {', '.join(TABLES)} RESTART IDENTITY CASCADE"))
        await session.commit()
    yield factory


@pytest.fixture
def bus() -> InMemoryBus:
    return InMemoryBus()


@pytest.fixture
def sandbox() -> SandboxClient:
    return SandboxClient(base_url="http://sandbox", transport=httpx.ASGITransport(app=sandbox_app))


@pytest.fixture
def orchestrator(bus: InMemoryBus, sessions: async_sessionmaker[AsyncSession]) -> Orchestrator:
    return Orchestrator(bus, sessions)


@pytest.fixture
def worker(bus: InMemoryBus, sessions: async_sessionmaker[AsyncSession], sandbox: SandboxClient) -> AgentWorker:
    return AgentWorker(bus, sessions, sandbox, worker_id="test-worker")


async def make_user(sessions: async_sessionmaker[AsyncSession], role: str = "admin", email: str | None = None) -> User:
    async with sessions() as session:
        user = User(id=uuid.uuid4(), email=email or f"{role}-{uuid.uuid4().hex[:6]}@test.local", name=role,
                    password_hash=hash_password("password123"), role=role)
        session.add(user)
        await session.commit()
        return user


async def drain(bus: InMemoryBus, orchestrator: Orchestrator, worker: AgentWorker, max_rounds: int = 200) -> None:
    """Deliver queued commands and tasks until the system is quiescent."""
    for _ in range(max_rounds):
        if bus.commands:
            await orchestrator.handle(bus.commands.pop(0))
        elif bus.tasks:
            await worker.process(bus.tasks.pop(0))
        else:
            return
    raise AssertionError("system did not quiesce")


def scripted_agent(node_id: str, steps: list[dict[str, Any]], tools: list[str], **extra: Any) -> dict[str, Any]:
    return {"id": node_id, "type": "agent", "position": {"x": 0, "y": 0},
            "data": {"label": node_id, "config": {"kind": "scripted", "steps": steps, "tools": tools, **extra}}}


def node(node_id: str, type_: str, config: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"id": node_id, "type": type_, "position": {"x": 0, "y": 0}, "data": {"label": node_id, "config": config or {}}}


def edge(source: str, target: str, handle: str = "out") -> dict[str, Any]:
    return {"id": f"{source}-{handle}-{target}", "source": source, "target": target,
            "sourceHandle": handle, "targetHandle": "in"}
