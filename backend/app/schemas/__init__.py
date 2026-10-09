from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class UserOut(ORM):
    id: str
    email: str
    name: str
    role: str


class LoginIn(BaseModel):
    email: str = Field(max_length=320)
    password: str = Field(max_length=200)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class WorkflowIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=5000)
    definition: dict[str, Any] = Field(default_factory=lambda: {"nodes": [], "edges": [], "settings": {}})


class WorkflowUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    definition: dict[str, Any] | None = None


class WorkflowImport(BaseModel):
    format: str = "agentic-sdlc/workflow@1"
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    definition: dict[str, Any]


class ValidateIn(BaseModel):
    definition: dict[str, Any]


class WorkflowSummary(BaseModel):
    id: str
    name: str
    description: str
    version: int
    created_at: datetime
    updated_at: datetime
    node_count: int
    last_run_status: str | None
    is_example: bool


class WorkflowOut(WorkflowSummary):
    definition: dict[str, Any]


class ExecuteIn(BaseModel):
    input: dict[str, Any] = Field(default_factory=dict)


class RunSummary(BaseModel):
    id: str
    workflow_id: str
    workflow_name: str
    workflow_version: int
    status: str
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    steps: int
    error: str | None


class NodeRunOut(BaseModel):
    id: str
    node_id: str
    node_type: str
    label: str
    iteration: int
    attempt: int
    status: str
    input: Any
    output: Any
    error: str | None
    selected_handle: str | None
    started_at: datetime | None
    finished_at: datetime | None
    duration_ms: int | None
    logs: list[Any]
    tool_calls: list[Any]
    usage: dict[str, Any] | None
    agent_kind: str | None
    model: str | None


class ArtifactOut(BaseModel):
    id: str
    node_run_id: str | None
    name: str
    kind: str
    size_bytes: int
    sha256: str
    created_at: datetime


class RunOut(RunSummary):
    input: dict[str, Any]
    output: dict[str, Any] | None
    definition: dict[str, Any]
    node_runs: list[NodeRunOut]
    last_event_seq: int
    artifacts: list[ArtifactOut] = []


class EventOut(BaseModel):
    seq: int
    run_id: str
    type: str
    node_id: str | None
    node_run_id: str | None
    data: dict[str, Any]
    created_at: datetime | None


class AgentIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=5000)
    kind: Literal["llm", "scripted"] = "llm"
    preset: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)


class AgentOut(AgentIn):
    id: str
    version: int
    created_at: datetime
    updated_at: datetime


class ProviderIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    base_url: str = Field(min_length=1, max_length=500, pattern=r"^https?://")
    default_model: str = Field(min_length=1, max_length=200)
    api_key_ref: str | None = Field(default=None, max_length=100, pattern=r"^[A-Z][A-Z0-9_]*$")
    timeout_seconds: int = Field(default=120, ge=1, le=3600)
    temperature: float = Field(default=0.2, ge=0, le=2)
    max_tokens: int = Field(default=2048, ge=1, le=200_000)


class ProviderOut(ProviderIn):
    id: str
    api_key_configured: bool
    created_at: datetime


class ProviderTestOut(BaseModel):
    ok: bool
    detail: str
    models: list[str] = []


class ApprovalOut(BaseModel):
    id: str
    run_id: str
    node_id: str
    workflow_name: str
    title: str
    description: str
    status: str
    requested_at: datetime
    decided_at: datetime | None
    decided_by: str | None
    comment: str | None


class DecisionIn(BaseModel):
    decision: Literal["approve", "reject"]
    comment: str | None = Field(default=None, max_length=5000)


class StatsOut(BaseModel):
    workflows: int
    runs_total: int
    runs_by_status: dict[str, int]
    active_runs: int
    pending_approvals: int
    recent_runs: list[RunSummary]
