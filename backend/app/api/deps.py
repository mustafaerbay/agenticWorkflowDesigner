import uuid
from typing import Any

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import permissions
from app.core.db import get_session
from app.core.security import decode_access_token
from app.models import AuditLog, User, Workflow, WorkflowRun
from app.orchestration.bus import Bus

bearer = HTTPBearer(auto_error=False)


async def user_from_token(session: AsyncSession, token: str) -> User:
    try:
        payload = decode_access_token(token)
        user_id = uuid.UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token") from exc
    user = await session.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")
    return user


async def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    session: AsyncSession = Depends(get_session),
) -> User:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return await user_from_token(session, credentials.credentials)


def require_writer(user: User = Depends(current_user)) -> User:
    if user.role not in ("admin", "editor"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Read-only account")
    return user


def require_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator role required")
    return user


def get_bus(request: Request) -> Bus:
    return request.app.state.bus


def can_read_workflow(user: User, workflow: Workflow) -> bool:
    return permissions.can_view_workflow(user, workflow)


def can_write_workflow(user: User, workflow: Workflow) -> bool:
    return permissions.can_edit_workflow(user, workflow)


async def load_workflow(session: AsyncSession, workflow_id: uuid.UUID, user: User, write: bool = False) -> Workflow:
    workflow = await session.get(Workflow, workflow_id)
    if workflow is None or workflow.deleted_at is not None or not can_read_workflow(user, workflow):
        raise HTTPException(status_code=404, detail="Workflow not found")
    if write and not can_write_workflow(user, workflow):
        raise HTTPException(status_code=403, detail="You do not have permission to modify this workflow")
    return workflow


async def load_run(session: AsyncSession, run_id: uuid.UUID, user: User, write: bool = False) -> WorkflowRun:
    run = await session.get(WorkflowRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    workflow = await session.get(Workflow, run.workflow_id)
    if not permissions.can_view_run(user, run, workflow):
        raise HTTPException(status_code=404, detail="Execution not found")
    if write and user.role == "viewer":
        raise HTTPException(status_code=403, detail="Read-only account")
    return run


def audit(session: AsyncSession, user: User | None, action: str, entity_type: str, entity_id: Any, data: dict[str, Any] | None = None) -> None:
    session.add(AuditLog(user_id=user.id if user else None, action=action, entity_type=entity_type,
                         entity_id=str(entity_id) if entity_id else None, data=data or {}))
