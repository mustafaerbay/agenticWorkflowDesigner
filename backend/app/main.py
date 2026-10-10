import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import routes_admin, routes_business, routes_executions, routes_org, routes_workflows
from app.core.config import get_settings
from app.core.db import dispose_engine, session_factory
from app.core.logging import configure_logging
from app.core.tracing import configure_tracing
from app.orchestration.bus import RabbitRedisBus
from app.services.seed import seed

settings = get_settings()
configure_logging(settings.service_name, settings.log_level)
log = logging.getLogger("api")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    if settings.jwt_secret.startswith("change-me"):
        log.warning("JWT_SECRET is using the insecure default; set it in .env")
    app.state.bus = RabbitRedisBus()
    async with session_factory()() as session:
        await seed(session)
    log.info("api started", extra={"environment": settings.environment})
    yield
    await app.state.bus.close()
    await dispose_engine()


app = FastAPI(
    title="Agentic SDLC Platform API",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url=None,
)
if settings.cors_origins:
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=False,
                       allow_methods=["*"], allow_headers=["Authorization", "Content-Type"])
app.include_router(routes_admin.router)
app.include_router(routes_workflows.router)
app.include_router(routes_executions.router)
app.include_router(routes_business.router)
app.include_router(routes_org.router)
configure_tracing(app)
