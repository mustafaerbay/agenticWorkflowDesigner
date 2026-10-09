"""Minimal OpenAI-compatible chat completions client (works with vLLM, Ollama, OpenAI, etc.)."""

import os
from typing import Any

import httpx


class LLMError(Exception):
    pass


class LLMClient:
    def __init__(self, base_url: str, model: str, api_key_ref: str | None, timeout: float = 120) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = os.environ.get(api_key_ref) if api_key_ref else None
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
                raise LLMError(f"LLM endpoint unreachable ({self.base_url}): {exc}") from exc
        if response.status_code >= 400:
            raise LLMError(f"LLM request failed ({response.status_code}): {response.text[:500]}")
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
            raise LLMError(f"HTTP {response.status_code}: {response.text[:300]}")
        return [m.get("id", "") for m in response.json().get("data", [])]
