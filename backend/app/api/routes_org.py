"""Organization: departments, users, connections (write-only secrets), file uploads, inbox."""

import hashlib
import os
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import audit, current_user, require_admin
from app.connections.connectors import CONNECTOR_TYPES, validate_config
from app.connections.crypto import SecretStoreError, decrypt_secret, encrypt_secret
from app.core import permissions
from app.core.config import get_settings
from app.core.db import get_session
from app.core.security import hash_password
from app.models import Connection, Department, InboxItem, UploadedFile, User, utcnow

router = APIRouter(prefix="/api", tags=["organization"])


# -- departments and users -------------------------------------------------------------------

@router.get("/departments")
async def departments(user: User = Depends(current_user), db: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    rows = (await db.execute(select(Department).order_by(Department.name))).scalars().all()
    return [{"code": d.code, "name": d.name, "sensitive": d.sensitive} for d in rows]


class MembershipIn(BaseModel):
    department: str
    roles: list[str] = Field(default_factory=lambda: ["member"])


class UserCreate(BaseModel):
    email: str = Field(min_length=3, max_length=320, pattern=r"^[^@\s]+@[^@\s]+$")
    name: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=10, max_length=200)
    role: str = Field(default="editor", pattern="^(admin|editor|viewer)$")
    memberships: list[MembershipIn] = Field(default_factory=list)


class UserUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    password: str | None = Field(default=None, min_length=10, max_length=200)
    role: str | None = Field(default=None, pattern="^(admin|editor|viewer)$")
    memberships: list[MembershipIn] | None = None
    is_active: bool | None = None


async def _check_memberships(db: AsyncSession, memberships: list[MembershipIn]) -> list[dict[str, Any]]:
    known = set((await db.execute(select(Department.code))).scalars().all())
    out = []
    for m in memberships:
        if m.department not in known:
            raise HTTPException(status_code=422, detail=f"Unknown department '{m.department}'")
        bad = [r for r in m.roles if r not in permissions.DEPARTMENT_ROLES]
        if bad:
            raise HTTPException(status_code=422, detail=f"Unknown roles {bad}")
        out.append({"department": m.department, "roles": sorted(set(m.roles))})
    return out


@router.get("/users")
async def list_users(admin: User = Depends(require_admin), db: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    return [permissions.public_user(u) for u in (await db.execute(select(User).order_by(User.email))).scalars()]


@router.post("/users", status_code=201)
async def create_user(body: UserCreate, admin: User = Depends(require_admin),
                      db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    user = User(id=uuid.uuid4(), email=body.email.lower(), name=body.name, password_hash=hash_password(body.password),
                role=body.role, memberships=await _check_memberships(db, body.memberships))
    db.add(user)
    audit(db, admin, "user.create", "user", user.id, {"email": user.email, "role": user.role,
                                                       "memberships": user.memberships})
    try:
        await db.commit()
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="A user with this email already exists") from exc
    return permissions.public_user(user)


@router.put("/users/{user_id}")
async def update_user(user_id: uuid.UUID, body: UserUpdate, admin: User = Depends(require_admin),
                      db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == admin.id and (body.role not in (None, "admin") or body.is_active is False):
        raise HTTPException(status_code=409, detail="You cannot remove your own administrator access")
    changes: dict[str, Any] = {}
    if body.name is not None:
        user.name = body.name
    if body.password is not None:
        user.password_hash = hash_password(body.password)
        changes["password"] = "changed"
    if body.role is not None:
        user.role = changes["role"] = body.role
    if body.memberships is not None:
        user.memberships = changes["memberships"] = await _check_memberships(db, body.memberships)
    if body.is_active is not None:
        user.is_active = changes["is_active"] = body.is_active
    audit(db, admin, "user.update", "user", user.id, changes)
    await db.commit()
    return permissions.public_user(user)


# -- connectors and connections -----------------------------------------------------------------

class ConnectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    connector: str
    config: dict[str, Any] = Field(default_factory=dict)
    secret: str | None = Field(default=None, max_length=4000)
    departments: list[str] = Field(default_factory=list)
    enabled: bool = True


def connection_out(c: Connection) -> dict[str, Any]:
    return {"id": str(c.id), "name": c.name, "connector": c.connector, "config": c.config,
            "departments": c.departments or [], "enabled": c.enabled, "has_secret": bool(c.secret_encrypted),
            "last_test_ok": c.last_test_ok, "last_test_at": c.last_test_at, "created_at": c.created_at}


@router.get("/connectors")
async def connectors(user: User = Depends(current_user)) -> list[dict[str, Any]]:
    return [{"type": t, **{k: v for k, v in spec.items()}} for t, spec in CONNECTOR_TYPES.items()]


@router.get("/connections")
async def list_connections(user: User = Depends(current_user), db: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    rows = (await db.execute(select(Connection).order_by(Connection.name))).scalars().all()
    if not permissions.is_admin(user):
        mine = permissions.departments_of(user)
        rows = [c for c in rows if not c.departments or mine & set(c.departments)]
    return [connection_out(c) for c in rows]


async def _validated(db: AsyncSession, body: ConnectionIn, existing_secret: str | None) -> tuple[dict[str, Any], str | None]:
    known = set((await db.execute(select(Department.code))).scalars().all())
    unknown = [d for d in body.departments if d not in known]
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown departments {unknown}")
    secret = body.secret if body.secret not in (None, "") else existing_secret
    spec = CONNECTOR_TYPES.get(body.connector)
    if spec is None:
        raise HTTPException(status_code=422, detail=f"Unknown connector type '{body.connector}'")
    if spec["secret"]["required"] and not secret:
        raise HTTPException(status_code=422, detail=f"{spec['secret']['label']} is required")
    try:
        config = validate_config(body.connector, body.config, secret)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return config, secret


@router.post("/connections", status_code=201)
async def create_connection(body: ConnectionIn, admin: User = Depends(require_admin),
                            db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    config, secret = await _validated(db, body, None)
    try:
        encrypted = encrypt_secret(secret) if secret else None
    except SecretStoreError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    c = Connection(id=uuid.uuid4(), name=body.name, connector=body.connector, config=config, secret_encrypted=encrypted,
                   departments=body.departments, enabled=body.enabled, created_by=admin.id)
    db.add(c)
    audit(db, admin, "connection.create", "connection", c.id, {"connector": c.connector, "departments": c.departments})
    try:
        await db.commit()
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="A connection with this name already exists") from exc
    return connection_out(c)


@router.put("/connections/{connection_id}")
async def update_connection(connection_id: uuid.UUID, body: ConnectionIn, admin: User = Depends(require_admin),
                            db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    c = await db.get(Connection, connection_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Connection not found")
    if body.connector != c.connector:
        raise HTTPException(status_code=422, detail="The connector type cannot be changed")
    try:
        existing = decrypt_secret(c.secret_encrypted) if c.secret_encrypted and not body.secret else None
        config, secret = await _validated(db, body, existing)
        c.secret_encrypted = encrypt_secret(secret) if secret else None
    except SecretStoreError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    c.name, c.config, c.departments, c.enabled = body.name, config, body.departments, body.enabled
    c.last_test_ok = None
    audit(db, admin, "connection.update", "connection", c.id,
          {"departments": c.departments, "secret_changed": bool(body.secret), "enabled": c.enabled})
    await db.commit()
    return connection_out(c)


@router.delete("/connections/{connection_id}", status_code=204)
async def delete_connection(connection_id: uuid.UUID, admin: User = Depends(require_admin),
                            db: AsyncSession = Depends(get_session)) -> Response:
    c = await db.get(Connection, connection_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Connection not found")
    await db.delete(c)
    audit(db, admin, "connection.delete", "connection", connection_id, {"name": c.name})
    await db.commit()
    return Response(status_code=204)


@router.post("/connections/{connection_id}/test")
async def test_connection(connection_id: uuid.UUID, admin: User = Depends(require_admin),
                          db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """Checks reachability/credentials without sending any message or changing any record."""
    import asyncio
    import smtplib
    import ssl

    import httpx

    c = await db.get(Connection, connection_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Connection not found")
    try:
        secret = decrypt_secret(c.secret_encrypted) if c.secret_encrypted else None
    except SecretStoreError as exc:
        return {"ok": False, "detail": str(exc)}
    ok, detail = False, ""
    try:
        if c.connector == "smtp":
            def probe() -> None:
                context = ssl.create_default_context()
                security = c.config.get("security", "starttls")
                cls = smtplib.SMTP_SSL if security == "ssl" else smtplib.SMTP
                kwargs: dict[str, Any] = {"timeout": 10, **({"context": context} if security == "ssl" else {})}
                with cls(c.config["host"], int(c.config.get("port") or 587), **kwargs) as smtp:
                    if security == "starttls":
                        smtp.starttls(context=context)
                    if c.config.get("username") and secret:
                        smtp.login(c.config["username"], secret)
                    smtp.noop()
            await asyncio.to_thread(probe)
            ok, detail = True, "Connected and authenticated. No email was sent."
        elif c.connector == "http":
            async with httpx.AsyncClient(base_url=c.config["base_url"], timeout=10, follow_redirects=False) as client:
                response = await client.get(c.config["allowed_path_prefixes"][0])
            ok = response.status_code < 500
            detail = f"Reached the system (HTTP {response.status_code}). Nothing was changed."
        else:
            ok, detail = True, "The webhook URL is stored and valid. A test message is never sent automatically."
    except Exception as exc:  # report, never leak secrets
        ok, detail = False, f"Could not connect: {type(exc).__name__}"
    c.last_test_ok, c.last_test_at = ok, utcnow()
    audit(db, admin, "connection.test", "connection", c.id, {"ok": ok})
    await db.commit()
    return {"ok": ok, "detail": detail}


# -- files ---------------------------------------------------------------------------------------

ALLOWED_TYPES = {".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv"}


@router.post("/files", status_code=201)
async def upload_file(file: UploadFile = File(...), department: str | None = Form(default=None),
                      user: User = Depends(current_user), db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    settings = get_settings()
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail="Upload a PDF, TXT, MD or CSV file")
    if department and not (permissions.is_admin(user) or permissions.roles_in(user, department)):
        raise HTTPException(status_code=403, detail=f"You are not a member of {department}")
    content = await file.read(settings.upload_max_mb * 1024 * 1024 + 1)
    if len(content) > settings.upload_max_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Files are limited to {settings.upload_max_mb} MB")
    if suffix == ".pdf" and not content.startswith(b"%PDF-"):
        raise HTTPException(status_code=415, detail="This is not a valid PDF file")
    record = UploadedFile(id=uuid.uuid4(), name=Path(file.filename or "file").name[:300], content_type=ALLOWED_TYPES[suffix],
                          size_bytes=len(content), sha256=hashlib.sha256(content).hexdigest(), owner_id=user.id,
                          department=department)
    path = Path(settings.uploads_dir) / str(record.id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    os.chmod(path, 0o640)
    db.add(record)
    audit(db, user, "file.upload", "file", record.id, {"name": record.name, "department": department,
                                                         "size": record.size_bytes})
    await db.commit()
    return {"id": str(record.id), "name": record.name, "content_type": record.content_type,
            "size_bytes": record.size_bytes, "department": department}


# -- inbox ---------------------------------------------------------------------------------------

def inbox_out(i: InboxItem) -> dict[str, Any]:
    return {"id": str(i.id), "kind": i.kind, "title": i.title, "body": i.body,
            "run_id": str(i.run_id) if i.run_id else None, "due_at": i.due_at, "done_at": i.done_at,
            "created_at": i.created_at}


@router.get("/inbox")
async def inbox(user: User = Depends(current_user), db: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    rows = (await db.execute(select(InboxItem).where(InboxItem.user_id == user.id)
                             .order_by(InboxItem.created_at.desc()).limit(200))).scalars().all()
    return [inbox_out(i) for i in rows]


@router.post("/inbox/{item_id}/done")
async def inbox_done(item_id: uuid.UUID, user: User = Depends(current_user),
                     db: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    item = await db.get(InboxItem, item_id)
    if item is None or item.user_id != user.id:
        raise HTTPException(status_code=404, detail="Item not found")
    item.done_at = item.done_at or utcnow()
    await db.commit()
    return inbox_out(item)
