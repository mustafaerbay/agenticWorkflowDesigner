import io
import uuid
from pathlib import Path

import httpx
import pytest

from app.connections import connectors
from app.connections.connectors import http_call, post_chat, send_email, validate_config
from app.connections.crypto import decrypt_secret, encrypt_secret
from app.core.config import get_settings
from app.sandbox.server import app as sandbox_app
from app.tools.registry import ToolError

TOKEN = {"X-Sandbox-Token": "test-sandbox-token-0123456789"}
HTTP_CONFIG = validate_config("http", {"base_url": "https://hr.example.com", "allowed_path_prefixes": ["/api/"],
                                       "allowed_methods": ["GET", "POST"]}, None)


def test_secret_encryption_roundtrip():
    token = encrypt_secret("hunter2-password")
    assert "hunter2" not in token and decrypt_secret(token) == "hunter2-password"


def test_connection_config_validation():
    with pytest.raises(ValueError):
        validate_config("http", {"base_url": "https://user:pw@hr.example.com", "allowed_path_prefixes": ["/api/"]}, None)
    with pytest.raises(ValueError):
        validate_config("slack", {}, "https://evil.example.com/hook")
    assert validate_config("teams", {}, "https://contoso.webhook.office.com/x") == {}


async def test_http_connector_cannot_escape_its_configuration(monkeypatch):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(201, json={"id": 7})

    monkeypatch.setattr(connectors, "HTTP_TRANSPORT", httpx.MockTransport(handler))
    for path in ("/admin/delete", "https://evil.example.com/api/x", "/api/../admin", "//evil.example.com/api/"):
        with pytest.raises(ToolError) as exc:
            await http_call(HTTP_CONFIG, "tok", "POST", path, {})
        assert exc.value.retryable is False
    with pytest.raises(ToolError):
        await http_call(HTTP_CONFIG, "tok", "DELETE", "/api/users/1")
    result = await http_call(HTTP_CONFIG, "tok", "POST", "/api/access-grants", {"user": "a"})
    assert result == {"status": 201, "ok": True, "data": {"id": 7}}
    assert str(seen[0].url) == "https://hr.example.com/api/access-grants"
    assert seen[0].headers["Authorization"] == "Bearer tok"


async def test_chat_and_email_validation(monkeypatch):
    monkeypatch.setattr(connectors, "HTTP_TRANSPORT", httpx.MockTransport(lambda r: httpx.Response(200, text="ok")))
    assert await post_chat("slack", "https://hooks.slack.com/services/x", "hello") == {"posted": True}
    config = {"host": "smtp.example.com", "from_address": "hr@example.com", "allowed_recipient_domains": ["example.com"]}
    with pytest.raises(ToolError, match="not allowed"):
        await send_email(config, None, "someone@gmail.com", "s", "b")
    with pytest.raises(ToolError, match="invalid email"):
        await send_email(config, None, "not-an-address", "s", "b")


@pytest.fixture
async def sandbox_client():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=sandbox_app), base_url="http://sandbox") as c:
        yield c


def put_upload(content: bytes) -> str:
    file_id = str(uuid.uuid4())
    (Path(get_settings().uploads_dir) / file_id).write_bytes(content)
    return file_id


async def test_document_and_data_tools(sandbox_client):
    from pypdf import PdfWriter

    doc = put_upload(b"Employee: Jane\nDate of birth: 1990-01-01\nID number: X1\n")
    r = (await sandbox_client.post("/docs/check_fields", json={"file_id": doc, "fields": ["date of birth", "IBAN"]},
                                   headers=TOKEN)).json()
    assert r == {"all_present": False, "missing": ["IBAN"], "found": ["date of birth"]}
    csv_id = put_upload(b"Date;Item;Amount\n2026-01-01;Taxi;1.234,50\n2026-01-02;Hotel;100,00\n")
    summary = (await sandbox_client.post("/data/summarize", json={"file_id": csv_id}, headers=TOKEN)).json()
    assert summary["rows"] == 2 and summary["totals"]["Amount"] == 1334.5
    rec = (await sandbox_client.post("/data/reconcile", json={"file_id": csv_id, "amount_column": "amount",
                                                              "expected_total": 1334, "tolerance": 1}, headers=TOKEN)).json()
    assert rec["within_tolerance"] is True and rec["difference"] == 0.5
    buffer = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.write(buffer)
    pdf = (await sandbox_client.post("/docs/extract", json={"file_id": put_upload(buffer.getvalue())}, headers=TOKEN)).json()
    assert pdf["pages"] == 1
    assert (await sandbox_client.post("/docs/extract", json={"file_id": "../../etc/passwd"}, headers=TOKEN)).status_code == 400
    binary = put_upload(b"\x00\x01\x02binary")
    assert (await sandbox_client.post("/docs/extract", json={"file_id": binary}, headers=TOKEN)).status_code == 415
