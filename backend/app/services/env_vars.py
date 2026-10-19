"""Platform environment variables: encrypted, admin-managed values referenced by name
(e.g. a model provider's api_key_ref). Resolved only on the server, at the moment of use."""

import os

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connections.crypto import SecretStoreError, decrypt_secret
from app.models import EnvVariable


async def resolve_env(session: AsyncSession, name: str | None) -> str | None:
    """Platform variable first, then the server process environment (.env)."""
    if not name:
        return None
    row = (await session.execute(select(EnvVariable).where(EnvVariable.name == name))).scalar_one_or_none()
    if row is not None:
        try:
            return decrypt_secret(row.value_encrypted)
        except SecretStoreError:
            return None
    return os.environ.get(name)


async def env_is_set(session: AsyncSession, name: str | None) -> bool:
    if not name:
        return False
    row = (await session.execute(select(EnvVariable.id).where(EnvVariable.name == name))).first()
    return row is not None or bool(os.environ.get(name))
