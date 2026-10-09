"""Idempotent startup seeding: admin user, default model provider, tool catalog, examples."""

import logging
import uuid

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import hash_password
from app.models import ModelProvider, Tool, User, Workflow
from app.services.examples import EXAMPLES
from app.tools.registry import tool_catalog

log = logging.getLogger(__name__)
SEED_LOCK = 774_211


async def seed(session: AsyncSession) -> None:
    settings = get_settings()
    await session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": SEED_LOCK})

    admin = (await session.execute(select(User).where(User.email == settings.admin_email))).scalar_one_or_none()
    if admin is None:
        if not settings.admin_password:
            log.error("ADMIN_PASSWORD is not set; no administrator account was created")
            await session.commit()
            return
        admin = User(id=uuid.uuid4(), email=settings.admin_email, name=settings.admin_name,
                     password_hash=hash_password(settings.admin_password), role="admin")
        session.add(admin)
        await session.flush()
        log.info("created administrator account", extra={"email": settings.admin_email})

    for name, spec in tool_catalog().items():
        tool = await session.get(Tool, name)
        if tool is None:
            session.add(Tool(name=name, description=spec["description"], parameters=spec["parameters"],
                             dangerous=spec["dangerous"]))
        else:
            tool.description, tool.parameters, tool.dangerous = spec["description"], spec["parameters"], spec["dangerous"]

    if settings.llm_base_url and settings.llm_model:
        existing = (await session.execute(select(ModelProvider).where(ModelProvider.name == "Default (environment)"))).scalar_one_or_none()
        if existing is None:
            session.add(ModelProvider(id=uuid.uuid4(), name="Default (environment)", base_url=settings.llm_base_url,
                                      default_model=settings.llm_model, api_key_ref=settings.llm_api_key_ref))
        else:
            existing.base_url, existing.default_model = settings.llm_base_url, settings.llm_model
            existing.api_key_ref = settings.llm_api_key_ref

    from app.api.routes_workflows import create_workflow  # local import avoids a cycle

    for example in EXAMPLES:
        found = (await session.execute(
            select(Workflow).where(Workflow.name == example["name"], Workflow.is_example.is_(True))
        )).scalar_one_or_none()
        if found is None:
            await create_workflow(session, admin, example["name"], example["description"], example["definition"], is_example=True)
            log.info("seeded example workflow", extra={"workflow": example["name"]})
    await session.commit()
