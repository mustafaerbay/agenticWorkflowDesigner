"""Minimal OpenAI-compatible chat completions client (works with vLLM, Ollama, OpenAI, etc.)."""

import json
import os
from typing import Any

import httpx


class LLMError(Exception):
    """A model request failed. `message` is safe to show users; `retryable` says whether trying again can help."""

    def __init__(self, message: str, status: int | None = None, retryable: bool = True, detail: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.retryable = retryable
        self.detail = detail


def _provider_message(body: str) -> str:
    try:
        error = json.loads(body).get("error")
        if isinstance(error, dict):
            return str(error.get("message") or "")[:400]
        if isinstance(error, str):
            return error[:400]
    except (ValueError, AttributeError):
        pass
    return body[:300]


def classify_http_error(status: int, body: str, base_url: str, max_tokens: int | None = None) -> LLMError:
    said = _provider_message(body)
    host = base_url.split("//")[-1].split("/")[0]
    if status == 402 or "credit" in said.lower() or "quota" in said.lower():
        hint = f" or lower Max tokens (currently {max_tokens})" if max_tokens else ""
        return LLMError(f"Your AI provider account ({host}) is out of credit or over its spending limit. Add credits or "
                        f"raise the key's limit with the provider{hint} in Model Settings. Provider said: {said}",
                        status, retryable=False, detail=body[:2000])
    if status in (401, 403):
        return LLMError(f"The AI provider ({host}) rejected the API key. Check the key's environment variable in "
                        f"Model Settings. Provider said: {said}", status, retryable=False, detail=body[:2000])
    if status == 404:
        return LLMError(f"The AI provider ({host}) does not know this model or endpoint. Check the base URL and model "
                        f"name in Model Settings. Provider said: {said}", status, retryable=False, detail=body[:2000])
    if status == 429:
        return LLMError(f"The AI provider ({host}) is rate-limiting requests; it will be retried. Provider said: {said}",
                        status, retryable=True, detail=body[:2000])
    if status in (400, 413, 422):
        return LLMError(f"The AI provider ({host}) rejected the request: {said}", status, retryable=False,
                        detail=body[:2000])
    return LLMError(f"The AI provider ({host}) had an error (HTTP {status}): {said}", status, retryable=True,
                    detail=body[:2000])


class LLMClient:
    def __init__(self, base_url: str, model: str, api_key_ref: str | None, timeout: float = 120,
                 api_key: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        # An explicitly resolved key (platform variable) wins over the process environment.
        self.api_key = api_key or (os.environ.get(api_key_ref) if api_key_ref else None)
        self.timeout = timeout

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float = 0.2,
        max_tokens: int = 2048,
        json_mode: bool = False,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        if json_mode and not tools:
            body["response_format"] = {"type": "json_object"}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                response = await client.post(f"{self.base_url}/chat/completions", json=body, headers=self._headers())
            except httpx.HTTPError as exc:
                raise LLMError(f"The AI provider could not be reached ({self.base_url}): {type(exc).__name__}") from exc
        if response.status_code >= 400:
            raise classify_http_error(response.status_code, response.text, self.base_url, max_tokens)
        data = response.json()
        if not data.get("choices"):
            raise LLMError("LLM response contained no choices")
        return data

    async def list_models(self) -> list[str]:
        async with httpx.AsyncClient(timeout=min(self.timeout, 15)) as client:
            try:
                response = await client.get(f"{self.base_url}/models", headers=self._headers())
            except httpx.HTTPError as exc:
                raise LLMError(f"endpoint unreachable: {exc}") from exc
        if response.status_code >= 400:
            raise classify_http_error(response.status_code, response.text, self.base_url)
        return [m.get("id", "") for m in response.json().get("data", [])]
