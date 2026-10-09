"""LLM agent runtime against a MOCK OpenAI-compatible model (test double, not a real LLM)."""

import json
from typing import Any

import pytest

from app.agents.base import AgentContext
from app.agents.llm_client import LLMClient
from app.agents.runtime import AgentExecutionError, LLMAgent
from app.tools.registry import ToolContext


def tool_call(name: str, args: dict[str, Any], call_id: str = "c1") -> dict[str, Any]:
    return {"choices": [{"message": {"role": "assistant", "content": "", "tool_calls": [
        {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}


def final(content: str) -> dict[str, Any]:
    return {"choices": [{"message": {"role": "assistant", "content": content}}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}}


def make_context(sandbox, config: dict[str, Any], calls: list[dict[str, Any]]) -> AgentContext:
    async def noop(_: str) -> None:
        return None

    async def record(entry: dict[str, Any]) -> None:
        calls.append(entry)

    return AgentContext(
        run_id="00000000-0000-0000-0000-00000000a11c", node_id="agent", node_run_id="n", config=config,
        inputs={}, prompt="do it",
        tools=ToolContext(run_id="00000000-0000-0000-0000-00000000a11c", node_run_id="n", sandbox=sandbox,
                          workspace_template="sample-calculator"),
        report=noop, record_tool_call=record,
    )


CONFIG = {"kind": "llm", "tools": ["read_file"], "max_steps": 5,
          "provider": {"base_url": "http://mock-llm/v1", "model": "mock-model", "api_key_ref": None},
          "output_schema": {"type": "object", "properties": {"tests_passed": {"type": "boolean"}},
                            "required": ["tests_passed"]}}


async def test_tool_loop_permissions_and_schema(sandbox, monkeypatch):
    responses = [
        tool_call("read_file", {"path": "calculator.py"}),
        tool_call("write_file", {"path": "evil.py", "content": "x"}, "c2"),  # not permitted
        final("not json"),  # triggers one repair prompt
        final('```json\n{"tests_passed": false}\n```'),
    ]
    seen: list[list[dict[str, Any]]] = []

    async def fake_chat(self, messages, tools=None, temperature=0.2, max_tokens=2048, json_mode=False):
        seen.append(list(messages))
        assert [t["function"]["name"] for t in tools] == ["read_file"]  # only permitted tools are offered
        return responses.pop(0)

    monkeypatch.setattr(LLMClient, "chat", fake_chat)
    calls: list[dict[str, Any]] = []
    result = await LLMAgent().execute(make_context(sandbox, CONFIG, calls))
    assert result.output == {"tests_passed": False}
    assert result.usage == {"prompt_tokens": 60, "completion_tokens": 30, "total_tokens": 90}
    assert calls[0]["tool"] == "read_file" and "def divide" in calls[0]["result"]["content"]
    assert calls[1]["tool"] == "write_file" and "not permitted" in calls[1]["error"]
    tool_messages = [m for m in seen[2] if m["role"] == "tool"]
    assert "not permitted" in tool_messages[-1]["content"]
    assert "untrusted" in seen[0][0]["content"]  # prompt-injection guard in the system prompt


async def test_missing_provider_fails_clearly(sandbox):
    with pytest.raises(AgentExecutionError, match="No model provider configured"):
        await LLMAgent().execute(make_context(sandbox, {**CONFIG, "provider": None}, []))


async def test_step_limit(sandbox, monkeypatch):
    async def always_tools(self, *args, **kwargs):
        return tool_call("read_file", {"path": "README.md"})

    monkeypatch.setattr(LLMClient, "chat", always_tools)
    with pytest.raises(AgentExecutionError, match="max_steps=2"):
        await LLMAgent().execute(make_context(sandbox, {**CONFIG, "max_steps": 2}, []))
