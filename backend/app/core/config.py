from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-driven configuration. Every value can be overridden via env vars."""

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    environment: str = "development"
    log_level: str = "INFO"
    service_name: str = "agentic-api"

    database_url: str = "postgresql+asyncpg://agentic:agentic@postgres:5432/agentic"
    redis_url: str = "redis://redis:6379/0"
    rabbitmq_url: str = "amqp://agentic:agentic@rabbitmq:5672/"

    jwt_secret: str = Field(default="change-me-in-env", min_length=16)
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 720

    admin_email: str = "admin@example.com"
    admin_password: str | None = None
    admin_name: str = "Administrator"

    cors_origins: list[str] = []

    # Default OpenAI-compatible provider seeded at startup (optional).
    llm_base_url: str | None = None
    llm_model: str | None = None
    llm_api_key_ref: str = "LLM_API_KEY"  # name of the env var holding the key

    # Sandbox / workspaces
    sandbox_url: str = "http://sandbox:8100"
    sandbox_token: str = Field(default="change-me-sandbox-token", min_length=16)
    workspaces_dir: str = "/workspaces"
    artifacts_dir: str = "/artifacts"
    templates_dir: str = "/app/workspace_templates"
    sandbox_allowed_commands: list[str] = [
        "python",
        "python3",
        "pytest",
        "git",
        "ls",
        "cat",
        "head",
        "tail",
        "wc",
        "grep",
        "find",
        "diff",
    ]
    sandbox_command_timeout: int = 120

    # git_clone tool: public HTTPS repositories from these hosts only (comma-separated).
    git_clone_allowed_hosts: str = "github.com,gitlab.com,bitbucket.org"
    git_clone_max_mb: int = 200
    git_clone_max_files: int = 20_000
    git_clone_timeout: int = 180

    @property
    def git_clone_hosts(self) -> set[str]:
        return {h.strip().lower() for h in self.git_clone_allowed_hosts.split(",") if h.strip()}
    sandbox_max_output_bytes: int = 200_000

    # Engine
    orchestrator_queue: str = "orchestrator.commands"
    agent_task_queue: str = "agent.tasks"
    worker_concurrency: int = 4
    heartbeat_interval_seconds: int = 10
    heartbeat_stale_seconds: int = 60
    sweep_interval_seconds: float = 1.0

    otel_exporter_otlp_endpoint: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
