"""Business Plan schema (bp/1): the canonical, editable representation of business workflows."""

import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

PLAN_SCHEMA = "bp/1"
STEP_ID = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
RESERVED_IDS = {"start", "end", "input", "run", "steps"}
INPUT_KEY = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FailTarget(Strict):
    fail: str = Field(min_length=1, max_length=300)


# A target is a step id, "end", or {"fail": "message"}.
Target = str | FailTarget


class Retry(Strict):
    max_attempts: int = Field(ge=1, le=10)
    backoff_seconds: float = Field(default=5, ge=0, le=600)


class InputField(Strict):
    key: str
    label: str = Field(min_length=1, max_length=200)
    type: Literal["string", "number", "boolean", "file", "email", "date", "list"] = "string"
    required: bool = True
    description: str = Field(default="", max_length=1000)
    example: Any = None

    @field_validator("key")
    @classmethod
    def _key(cls, v: str) -> str:
        if not INPUT_KEY.match(v):
            raise ValueError("input key must be lowercase letters, digits and _")
        return v


class Trigger(Strict):
    type: Literal["manual", "schedule", "api"] = "manual"
    cron: str | None = Field(default=None, max_length=100)
    timezone: str = Field(default="UTC", max_length=64)


class StepBase(Strict):
    id: str
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    next: Target | None = None
    policy_inserted: bool = False

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not STEP_ID.match(v) or v in RESERVED_IDS:
            raise ValueError(f"invalid step id {v!r}")
        return v


class OnFailureGoto(Strict):
    goto: Target


class ActionStep(StepBase):
    kind: Literal["action"] = "action"
    capability: str = Field(min_length=1, max_length=100)
    # literal value | {"from": "input.x" | "steps.<id>.<field>"}; strings may contain {{input.x}} / {{steps.id.field}}
    params: dict[str, Any] = Field(default_factory=dict)
    retry: Retry | None = None
    on_failure: Literal["stop"] | OnFailureGoto = "stop"


class Branch(Strict):
    id: str
    label: str = Field(min_length=1, max_length=200)
    when: dict[str, Any]
    goto: Target

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not re.match(r"^[a-z][a-z0-9_]{0,40}$", v) or v == "otherwise":
            raise ValueError(f"invalid branch id {v!r}")
        return v


class DecisionStep(StepBase):
    kind: Literal["decision"] = "decision"
    branches: list[Branch] = Field(min_length=1, max_length=10)
    otherwise: Target = "end"


class Approver(Strict):
    role: Literal["approver", "dept_admin"] = "approver"
    department: str | None = None


class ApprovalStep(StepBase):
    kind: Literal["approval"] = "approval"
    approver: Approver = Field(default_factory=Approver)
    instructions: str = Field(default="", max_length=2000)
    on_reject: Target = Field(default_factory=lambda: FailTarget(fail="Rejected by approver"))
    separation_of_duties: bool = False


class WaitStep(StepBase):
    kind: Literal["wait"] = "wait"
    seconds: float = Field(ge=0, le=86400)


Step = Annotated[ActionStep | DecisionStep | ApprovalStep | WaitStep, Field(discriminator="kind")]


class Settings(Strict):
    max_loop_iterations: int = Field(default=5, ge=1, le=100)
    max_total_steps: int = Field(default=100, ge=1, le=1000)
    max_duration_seconds: int = Field(default=3600, ge=10, le=86400)


class BusinessPlan(Strict):
    schema_: Literal["bp/1"] = Field(default=PLAN_SCHEMA, alias="schema")
    title: str = Field(min_length=1, max_length=200)
    summary: str = Field(default="", max_length=4000)
    department: str | None = None
    trigger: Trigger = Field(default_factory=Trigger)
    inputs: list[InputField] = Field(default_factory=list, max_length=30)
    steps: list[Step] = Field(min_length=1, max_length=60)
    settings: Settings = Field(default_factory=Settings)
    ui: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    def step(self, step_id: str) -> ActionStep | DecisionStep | ApprovalStep | WaitStep | None:
        return next((s for s in self.steps if s.id == step_id), None)

    def dump(self) -> dict[str, Any]:
        return self.model_dump(mode="json", by_alias=True, exclude_none=False)


def parse_plan(data: Any) -> BusinessPlan:
    return BusinessPlan.model_validate(data)


def target_key(target: Target | None) -> str | None:
    if target is None:
        return None
    if isinstance(target, FailTarget):
        return f"fail:{target.fail}"
    return target


def step_targets(plan: BusinessPlan, index: int) -> list[tuple[str, Target]]:
    """(handle, target) pairs leaving a step, with default `next` resolved to the following step."""
    step = plan.steps[index]
    default_next: Target = step.next if step.next is not None else (
        plan.steps[index + 1].id if index + 1 < len(plan.steps) else "end")
    if isinstance(step, DecisionStep):
        return [*[(b.id, b.goto) for b in step.branches], ("otherwise", step.otherwise)]
    if isinstance(step, ApprovalStep):
        return [("approved", default_next), ("rejected", step.on_reject)]
    pairs: list[tuple[str, Target]] = [("out", default_next)]
    if isinstance(step, ActionStep) and isinstance(step.on_failure, OnFailureGoto):
        pairs.append(("error", step.on_failure.goto))
    return pairs
