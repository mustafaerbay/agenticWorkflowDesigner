"""Connector types and their (side-effecting) operations.

Every function receives non-secret config and the decrypted secret separately; secrets are
never logged or returned. Hosts are fixed by the admin-configured connection, so workflow
parameters cannot redirect requests elsewhere (no SSRF via workflow data).
"""

import asyncio
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import make_msgid
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.tools.registry import ToolError

# Test hook: inject an httpx transport for HTTP-based connectors.
HTTP_TRANSPORT: httpx.AsyncBaseTransport | None = None
EMAIL_RE = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[A-Za-z]{2,}$")

CONNECTOR_TYPES: dict[str, dict[str, Any]] = {
    "smtp": {
        "label": "Email (SMTP)", "capability_connector": "smtp",
        "description": "Send email through your organization's mail server.",
        "fields": [
            {"key": "host", "label": "SMTP server", "type": "string", "required": True, "placeholder": "smtp.example.com"},
            {"key": "port", "label": "Port", "type": "number", "required": True, "default": 587},
            {"key": "security", "label": "Security", "type": "select", "options": ["starttls", "ssl", "none"], "default": "starttls"},
            {"key": "username", "label": "Username", "type": "string", "required": False},
            {"key": "from_address", "label": "Send as (from address)", "type": "string", "required": True},
            {"key": "allowed_recipient_domains", "label": "Allowed recipient domains (empty = any)", "type": "list", "required": False},
        ],
        "secret": {"key": "password", "label": "Password / app password", "required": False},
    },
    "http": {
        "label": "Business system (HTTP API)", "capability_connector": "http",
        "description": "Read or write records in an HR, ticketing, ERP or other system that has an HTTP API.",
        "fields": [
            {"key": "base_url", "label": "Base URL", "type": "string", "required": True, "placeholder": "https://hr.example.com"},
            {"key": "allowed_path_prefixes", "label": "Allowed paths", "type": "list", "required": True, "default": ["/api/"]},
            {"key": "allowed_methods", "label": "Allowed methods", "type": "list", "required": False, "default": ["GET", "POST"]},
            {"key": "auth_header", "label": "Auth header name", "type": "string", "required": False, "default": "Authorization"},
            {"key": "auth_scheme", "label": "Auth scheme prefix", "type": "string", "required": False, "default": "Bearer"},
        ],
        "secret": {"key": "token", "label": "API token", "required": False},
    },
    "slack": {
        "label": "Slack", "capability_connector": "chat",
        "description": "Post messages to a Slack channel via an incoming webhook.",
        "fields": [{"key": "channel_label", "label": "Channel (for display)", "type": "string", "required": False}],
        "secret": {"key": "webhook_url", "label": "Incoming webhook URL", "required": True},
    },
    "teams": {
        "label": "Microsoft Teams", "capability_connector": "chat",
        "description": "Post messages to a Teams channel via an incoming webhook / workflow URL.",
        "fields": [{"key": "channel_label", "label": "Channel (for display)", "type": "string", "required": False}],
        "secret": {"key": "webhook_url", "label": "Webhook URL", "required": True},
    },
}


def capability_connector_of(connector_type: str) -> str:
    return CONNECTOR_TYPES[connector_type]["capability_connector"]


def validate_config(connector_type: str, config: dict[str, Any], secret: str | None) -> dict[str, Any]:
    spec = CONNECTOR_TYPES.get(connector_type)
    if spec is None:
        raise ValueError(f"unknown connector type '{connector_type}'")
    clean: dict[str, Any] = {}
    for f in spec["fields"]:
        value = config.get(f["key"], f.get("default"))
        if f.get("required") and value in (None, "", []):
            raise ValueError(f"{f['label']} is required")
        if value is None:
            continue
        if f["type"] == "number":
            value = int(value)
        if f["type"] == "list":
            value = [str(v).strip() for v in (value if isinstance(value, list) else str(value).split(",")) if str(v).strip()]
        if f["type"] == "select" and value not in f["options"]:
            raise ValueError(f"{f['label']} must be one of {f['options']}")
        clean[f["key"]] = value
    unknown = set(config) - {f["key"] for f in spec["fields"]}
    if unknown:
        raise ValueError(f"unknown settings: {sorted(unknown)}")
    if connector_type == "http":
        parts = urlsplit(clean["base_url"])
        if parts.scheme not in ("https", "http") or not parts.hostname or parts.username or parts.password:
            raise ValueError("Base URL must be http(s)://host without credentials")
        clean["base_url"] = clean["base_url"].rstrip("/")
        for prefix in clean["allowed_path_prefixes"]:
            if not prefix.startswith("/"):
                raise ValueError("allowed paths must start with /")
        clean["allowed_methods"] = [m.upper() for m in clean.get("allowed_methods") or ["GET"]]
    if connector_type == "smtp" and not EMAIL_RE.match(clean["from_address"]):
        raise ValueError("from address is not a valid email address")
    if connector_type in ("slack", "teams") and secret is not None:
        parts = urlsplit(secret)
        if parts.scheme != "https" or not parts.hostname:
            raise ValueError("webhook URL must be https://")
        if connector_type == "slack" and parts.hostname != "hooks.slack.com":
            raise ValueError("Slack webhook URLs start with https://hooks.slack.com/")
        if connector_type == "teams" and not (parts.hostname.endswith(".webhook.office.com")
                                              or parts.hostname.endswith(".logic.azure.com")
                                              or parts.hostname.endswith(".powerplatform.com")):
            raise ValueError("Teams webhook URLs are on *.webhook.office.com, *.logic.azure.com or *.powerplatform.com")
    return clean


def _recipients(value: Any, allowed_domains: list[str]) -> list[str]:
    raw = value if isinstance(value, list) else re.split(r"[,;]\s*", str(value or ""))
    out = [r.strip() for r in raw if str(r).strip()]
    if not out:
        raise ToolError("no recipient given", retryable=False)
    for address in out:
        if not EMAIL_RE.match(address):
            raise ToolError(f"invalid email address: {address}", retryable=False)
        domain = address.rsplit("@", 1)[1].lower()
        if allowed_domains and domain not in {d.lower() for d in allowed_domains}:
            raise ToolError(f"sending to {domain} is not allowed by this connection", retryable=False)
    if len(out) > 50:
        raise ToolError("too many recipients (max 50)", retryable=False)
    return out


async def send_email(config: dict[str, Any], secret: str | None, to: Any, subject: str, body: str) -> dict[str, Any]:
    recipients = _recipients(to, config.get("allowed_recipient_domains") or [])
    message = EmailMessage()
    message["From"] = config["from_address"]
    message["To"] = ", ".join(recipients)
    message["Subject"] = str(subject)[:300]
    message_id = make_msgid(domain=config["from_address"].rsplit("@", 1)[1])
    message["Message-ID"] = message_id
    message.set_content(str(body)[:100_000])

    def deliver() -> None:
        security = config.get("security", "starttls")
        context = ssl.create_default_context()
        cls = smtplib.SMTP_SSL if security == "ssl" else smtplib.SMTP
        kwargs: dict[str, Any] = {"timeout": 20}
        if security == "ssl":
            kwargs["context"] = context
        with cls(config["host"], int(config.get("port") or 587), **kwargs) as smtp:
            if security == "starttls":
                smtp.starttls(context=context)
            if config.get("username") and secret:
                smtp.login(config["username"], secret)
            smtp.send_message(message)

    try:
        await asyncio.to_thread(deliver)
    except smtplib.SMTPAuthenticationError as exc:
        raise ToolError("email server rejected the credentials", retryable=False) from exc
    except smtplib.SMTPRecipientsRefused as exc:
        raise ToolError("email server refused the recipients", retryable=False) from exc
    except (OSError, smtplib.SMTPException) as exc:
        raise ToolError(f"email delivery failed: {type(exc).__name__}", retryable=True) from exc
    return {"sent": True, "message_id": message_id, "recipients": recipients}


async def http_call(config: dict[str, Any], secret: str | None, method: str, path: str, body: Any = None) -> dict[str, Any]:
    method = (method or "GET").upper()
    if method not in config.get("allowed_methods", ["GET"]):
        raise ToolError(f"method {method} is not allowed by this connection", retryable=False)
    if not isinstance(path, str) or not path.startswith("/") or ".." in path or "//" in path or "\\" in path:
        raise ToolError("path must be a relative path starting with /", retryable=False)
    if not any(path.startswith(p) for p in config.get("allowed_path_prefixes") or []):
        raise ToolError(f"path {path} is outside the allowed paths of this connection", retryable=False)
    headers = {"Accept": "application/json"}
    if secret:
        header = config.get("auth_header") or "Authorization"
        scheme = config.get("auth_scheme") or ""
        headers[header] = f"{scheme} {secret}".strip()
    async with httpx.AsyncClient(base_url=config["base_url"], timeout=20, follow_redirects=False,
                                 transport=HTTP_TRANSPORT) as client:
        try:
            response = await client.request(method, path, json=body if method != "GET" else None, headers=headers)
        except httpx.HTTPError as exc:
            raise ToolError(f"business system unreachable: {type(exc).__name__}", retryable=True) from exc
    try:
        data = response.json()
    except ValueError:
        data = {"text": response.text[:5000]}
    if not isinstance(data, dict):
        data = {"items": data}
    if response.status_code >= 500 or response.status_code == 429:
        raise ToolError(f"business system error (HTTP {response.status_code})", retryable=True)
    return {"status": response.status_code, "ok": response.status_code < 400, "data": data}


async def post_chat(connector_type: str, secret: str, text: str) -> dict[str, Any]:
    if not text or not str(text).strip():
        raise ToolError("message is empty", retryable=False)
    async with httpx.AsyncClient(timeout=15, follow_redirects=False, transport=HTTP_TRANSPORT) as client:
        try:
            response = await client.post(secret, json={"text": str(text)[:30_000]})
        except httpx.HTTPError as exc:
            raise ToolError(f"{connector_type} unreachable: {type(exc).__name__}", retryable=True) from exc
    if response.status_code >= 400:
        raise ToolError(f"{connector_type} rejected the message (HTTP {response.status_code})",
                        retryable=response.status_code >= 500)
    return {"posted": True}
