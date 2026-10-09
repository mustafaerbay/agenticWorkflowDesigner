"""Creating runs: validation and immutable configuration snapshots."""

import json
import re
import uuid
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.presets import PRESETS
from app.models import Agent, AgentVersion, ModelProvider, Workflow, WorkflowRun, WorkflowVersion
from app.orchestration.conditions import EvalContext, RuleError
from app.orchestration.validator import WorkflowValidator
from app.tools.registry import tool_catalog
from app.workers.messages import OrchestratorCommand

TEMPLATE = re.compile(r"\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}")


def get_validator() -> WorkflowValidator:
    return WorkflowValidator(tool_catalog(), set(PRESETS))


def _overlay(base: dict[str, Any], top: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in top.items():
        if value is not None and value != "" and not (key == "tools" and value == [] and base.get("tools")):
            merged[key] = value
    return merged


async def effective_agent_config(session: AsyncSession, node_config: dict[str, Any]) -> dict[str, Any]:
    config: dict[str, Any] = {}
    preset = node_config.get("preset")
    if preset in PRESETS:
        config = dict(PRESETS[preset]["config"])
    agent_id = node_config.get("agent_id")
    if agent_id:
        agent = await session.get(Agent, uuid.UUID(str(agent_id)))
        if agent is None or agent.deleted_at is not None:
            raise HTTPException(status_code=422, detail=f"Agent {agent_id} not found")
        version = (await session.execute(
            select(AgentVersion).where(AgentVersion.agent_id == agent.id, AgentVersion.version == agent.current_version)
        )).scalar_one()
        config = _overlay(config, {**version.config, "kind": agent.kind, "preset": agent.preset})
        config["agent_id"] = str(agent.id)
        config["agent_version"] = agent.current_version
    config = _overlay(config, node_config)
    config.setdefault("kind", "llm")
    config.setdefault("tools", [])
    if config["kind"] == "llm":
        provider: ModelProvider | None = None
        if config.get("model_provider_id"):
            provider = await session.get(ModelProvider, uuid.UUID(str(config["model_provider_id"])))
        if provider is None:
            provider = (await session.execute(select(ModelProvider).order_by(ModelProvider.created_at).limit(1))).scalar_one_or_none()
        if provider is not None:
            config["provider"] = {
                "id": str(provider.id),
                "name": provider.name,
                "base_url": provider.base_url,
                "model": config.get("model") or provider.default_model,
                "api_key_ref": provider.api_key_ref,
                "timeout_seconds": provider.timeout_seconds,
                "temperature": provider.temperature,
                "max_tokens": provider.max_tokens,
            }
        else:
            config["provider"] = None
    return config


async def create_run(
    session: AsyncSession, workflow: Workflow, version: WorkflowVersion, run_input: dict[str, Any], user_id: uuid.UUID
) -> WorkflowRun:
    definition = version.definition
    validation = get_validator().validate(definition)
    if not validation.valid:
        raise HTTPException(status_code=422, detail=validation.as_dict())
    effective: dict[str, Any] = {}
    for node in definition.get("nodes", []):
        config = (node.get("data") or {}).get("config") or {}
        if node["type"] == "agent":
            effective[node["id"]] = await effective_agent_config(session, config)
        elif node["type"] == "tool":
            effective[node["id"]] = dict(config)
    run = WorkflowRun(
        id=uuid.uuid4(),
        workflow_id=workflow.id,
        workflow_version_id=version.id,
        workflow_version=version.version,
        workflow_name=workflow.name,
        status="PENDING",
        input=run_input,
        definition=definition,
        effective_config=effective,
        state={},
        steps=0,
        event_seq=0,
        created_by=user_id,
    )
    session.add(run)
    await session.flush()
    session.info.setdefault("commands", []).append(
        OrchestratorCommand(type="run.start", run_id=str(run.id), correlation_id=str(run.id)).model_dump()
    )
    return run


def resolve_value(value: Any, ctx: EvalContext) -> Any:
    if isinstance(value, dict) and set(value.keys()) == {"ref"}:
        return ctx.resolve(value["ref"])
    if isinstance(value, dict):
        return {k: resolve_value(v, ctx) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve_value(v, ctx) for v in value]
    if isinstance(value, str) and "{{" in value:
        return render_template(value, ctx)
    return value


def resolve_refs(value: Any, ctx: EvalContext) -> Any:
    """Resolve only explicit {"ref": ...} objects; drop arguments that resolve to null."""
    if isinstance(value, dict) and set(value.keys()) == {"ref"}:
        return ctx.resolve(value["ref"])
    if isinstance(value, dict):
        resolved = {k: resolve_refs(v, ctx) for k, v in value.items()}
        return {k: v for k, v in resolved.items() if v is not None}
    if isinstance(value, list):
        return [resolve_refs(v, ctx) for v in value]
    return value


def render_template(template: str, ctx: EvalContext) -> str:
    def replace(match: re.Match[str]) -> str:
        try:
            value = ctx.resolve(match.group(1))
        except RuleError:
            return match.group(0)
        if value is None:
            return ""
        return value if isinstance(value, str) else json.dumps(value, default=str)

    return TEMPLATE.sub(replace, template)
