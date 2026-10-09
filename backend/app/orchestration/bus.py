"""Message bus abstraction: RabbitMQ for commands/tasks, Redis pub/sub for events."""

import json
import logging
from typing import Any, Protocol

import aio_pika
import redis.asyncio as aioredis

from app.core.config import get_settings

log = logging.getLogger(__name__)


def event_channel(run_id: str) -> str:
    return f"run-events:{run_id}"


class Bus(Protocol):
    async def send_command(self, message: dict[str, Any]) -> None: ...
    async def send_task(self, message: dict[str, Any]) -> None: ...
    async def publish_event(self, event: dict[str, Any]) -> None: ...


class RabbitRedisBus:
    def __init__(self) -> None:
        self.settings = get_settings()
        self._connection: aio_pika.abc.AbstractRobustConnection | None = None
        self._channel: aio_pika.abc.AbstractChannel | None = None
        self.redis: aioredis.Redis = aioredis.from_url(self.settings.redis_url, decode_responses=True)

    async def connect(self) -> None:
        if self._connection is None or self._connection.is_closed:
            self._connection = await aio_pika.connect_robust(self.settings.rabbitmq_url)
            self._channel = await self._connection.channel(publisher_confirms=True)
            for queue in (self.settings.orchestrator_queue, self.settings.agent_task_queue):
                await self._channel.declare_queue(queue, durable=True)

    @property
    def connection(self) -> aio_pika.abc.AbstractRobustConnection | None:
        return self._connection

    async def _publish(self, queue: str, message: dict[str, Any]) -> None:
        await self.connect()
        assert self._channel is not None
        await self._channel.default_exchange.publish(
            aio_pika.Message(
                body=json.dumps(message, default=str).encode(),
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                content_type="application/json",
                message_id=str(message.get("message_id", "")),
                correlation_id=str(message.get("correlation_id", "")),
            ),
            routing_key=queue,
        )

    async def send_command(self, message: dict[str, Any]) -> None:
        await self._publish(self.settings.orchestrator_queue, message)

    async def send_task(self, message: dict[str, Any]) -> None:
        await self._publish(self.settings.agent_task_queue, message)

    async def publish_event(self, event: dict[str, Any]) -> None:
        try:
            await self.redis.publish(event_channel(str(event["run_id"])), json.dumps(event, default=str))
        except Exception:  # events are persisted; live push is best-effort
            log.warning("event publish failed", exc_info=True)

    async def close(self) -> None:
        if self._connection is not None:
            await self._connection.close()
        await self.redis.aclose()


class InMemoryBus:
    """Test double that records outgoing messages."""

    def __init__(self) -> None:
        self.commands: list[dict[str, Any]] = []
        self.tasks: list[dict[str, Any]] = []
        self.events: list[dict[str, Any]] = []

    async def send_command(self, message: dict[str, Any]) -> None:
        self.commands.append(message)

    async def send_task(self, message: dict[str, Any]) -> None:
        self.tasks.append(message)

    async def publish_event(self, event: dict[str, Any]) -> None:
        self.events.append(event)
