"""Agent abstraction shared by every agent type."""

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from app.tools.registry import ToolContext, ToolError, execute_tool


@dataclass
class AgentContext:
    run_id: str
    node_id: str
    node_run_id: str
    config: dict[str, Any]          # effective, snapshotted agent configuration
    inputs: dict[str, Any]          # resolved input mapping + execution input
    prompt: str                     # rendered user prompt
    tools: ToolContext
    report: Callable[[str], Awaitable[None]]
    record_tool_call: Callable[[dict[str, Any]], Awaitable[None]]
    is_cancelled: Callable[[], Awaitable[bool]] = field(default=lambda: _false())

    @property
    def allowed_tools(self) -> list[str]:
        return list(self.config.get("tools") or [])

    async def call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        """Permission-checked tool call; the engine enforces this, not the LLM."""
        entry: dict[str, Any] = {"tool": name, "args": args}
        try:
            result, duration = await execute_tool(name, args, self.tools, self.allowed_tools)
            entry.update(result=_truncate(result), duration_ms=duration, error=None)
            return result
        except ToolError as exc:
            entry.update(result=None, error=str(exc), duration_ms=None)
            raise
        finally:
            await self.record_tool_call(entry)


async def _false() -> bool:
    return False


def _truncate(value: Any, limit: int = 20_000) -> Any:
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + f"... [truncated {len(value) - limit} chars]"
    if isinstance(value, dict):
        return {k: _truncate(v, limit) for k, v in value.items()}
    if isinstance(value, list):
        return [_truncate(v, limit) for v in value[:500]]
    return value


@dataclass
class AgentResult:
    output: dict[str, Any]
    usage: dict[str, int] | None = None
    model: str | None = None


class AgentExecutionError(Exception):
    def __init__(self, message: str, retryable: bool = True) -> None:
        super().__init__(message)
        self.retryable = retryable


class BaseAgent(ABC):
    @abstractmethod
    async def execute(self, context: AgentContext) -> AgentResult: ...
