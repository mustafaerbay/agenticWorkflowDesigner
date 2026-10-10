"""Encryption for connection secrets (Fernet). Secrets are write-only through the API."""

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings


class SecretStoreError(RuntimeError):
    pass


def _fernet() -> Fernet:
    key = get_settings().connection_encryption_key
    if not key:
        raise SecretStoreError("CONNECTION_ENCRYPTION_KEY is not configured; connections with secrets cannot be stored")
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError) as exc:
        raise SecretStoreError("CONNECTION_ENCRYPTION_KEY is not a valid Fernet key") from exc


def encrypt_secret(secret: str) -> str:
    return _fernet().encrypt(secret.encode()).decode()


def decrypt_secret(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken as exc:
        raise SecretStoreError("stored secret cannot be decrypted (was the key rotated?)") from exc
