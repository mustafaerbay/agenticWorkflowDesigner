"""Versioned, schema-validated messages exchanged over RabbitMQ."""

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

SCHEMA_VERSION = 1


class OrchestratorCommand(BaseModel):
    schema_version: Literal[1] = SCHEMA_VERSION
    message_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    type: Literal["run.start", "run.kick", "node.finished"]
    run_id: str
    node_run_id: str | None = None
    correlation_id: str


class AgentTask(BaseModel):
    """Orchestrator -> agent worker contract (A2A-ready envelope)."""

    schema_version: Literal[1] = SCHEMA_VERSION
    message_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    workflow_id: str
    execution_id: str
    task_id: str  # node run id; also the idempotency key
    node_id: str
    source_agent: str = "orchestrator"
    target_agent: str
    correlation_id: str
    deadline: datetime
    input_payload: dict[str, Any] = {}


class AgentTaskResult(BaseModel):
    """Agent worker -> orchestrator contract, published as node.finished."""

    schema_version: Literal[1] = SCHEMA_VERSION
    execution_id: str
    task_id: str
    correlation_id: str
    status: Literal["COMPLETED", "FAILED"]
    result_payload: dict[str, Any] | None = None
    error: dict[str, Any] | None = None  # {"type": str, "message": str}
