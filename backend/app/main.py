import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded

from app.core.config import settings
from app.core.logging_config import configure_logging
from app.core.rate_limit import limiter

configure_logging(json_logs=os.getenv("APP_ENV", "development") != "development")
_logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.services.pg_pubsub import listen_loop
    task = asyncio.create_task(listen_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


from app.routers import account, activity_logs, agent_deployments, agent_inbox, agent_personas, agent_routing_rules, agent_runs, agent_sessions, analytics, api_keys, audit_logs, auth, bridge, channel, conversations, cron, current_project, dashboard, dispatch, docs, entities, epics, event_notifications, events, file_locks, health, hitl, integrations, invite_accept, invitations, me, meetings, members, mockups, notification_preferences, notifications, open_api_keys, org_invites, org_members, organizations, oss, plan_features, policy_documents, presence, project_access, project_settings, projects, retros, rewards, sprints, standups, stories, subscription, tasks, team_members, webhooks, workflow_executions, workflow_recipes, workflow_report, workflow_templates, workflow_trigger, workflow_trigger_types, workflow_versions, ws_chat

app = FastAPI(
    title="Sprintable API v2",
    description="FastAPI backend — Phase B migration layer",
    version="0.1.0",
    docs_url="/api/v2/_swagger" if settings.debug else None,
    redoc_url=None,
    lifespan=lifespan,
)

_HTTP_CODE_MAP: dict[int, str] = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    422: "UNPROCESSABLE_ENTITY",
    429: "RATE_LIMITED",
}


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    code = _HTTP_CODE_MAP.get(exc.status_code, f"HTTP_{exc.status_code}")
    return JSONResponse(
        status_code=exc.status_code,
        content={"data": None, "error": {"code": code, "message": str(exc.detail)}, "meta": None},
        headers=exc.headers,
    )


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    retry_after = str(getattr(exc, "retry_after", 60))
    resp = JSONResponse(
        status_code=429,
        content={"data": None, "error": {"code": "RATE_LIMITED", "message": "Too many requests"}, "meta": None},
    )
    resp.headers["Retry-After"] = retry_after
    return resp


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """예상치 못한 500 에러 — 내부 정보는 로그에만, 클라이언트엔 일반 메시지."""
    _logger.exception("Unhandled exception on %s %s: %s", request.method, request.url.path, exc)
    detail = str(exc) if settings.debug else "Internal server error"
    return JSONResponse(
        status_code=500,
        content={"data": None, "error": {"code": "INTERNAL_ERROR", "message": detail}, "meta": None},
    )


app.state.limiter = limiter


app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "X-Org-Id",
        "X-Project-Id",
        "X-Request-ID",
    ],
)

app.include_router(auth.router)
app.include_router(health.router)
app.include_router(activity_logs.router)
app.include_router(events.router)
app.include_router(dispatch.router)
app.include_router(conversations.router)
app.include_router(presence.router)
app.include_router(sprints.router)
app.include_router(epics.router)
app.include_router(tasks.router)
app.include_router(docs.router)
app.include_router(meetings.router)
app.include_router(stories.router)
app.include_router(projects.router)
app.include_router(project_access.router)
app.include_router(team_members.router)
app.include_router(org_members.router)
app.include_router(standups.router)
app.include_router(retros.router)
app.include_router(entities.router)
app.include_router(event_notifications.router)
app.include_router(notifications.router)
app.include_router(notification_preferences.router)
app.include_router(analytics.router)
app.include_router(invitations.router)
app.include_router(rewards.router)
app.include_router(audit_logs.router)
app.include_router(dashboard.router)
app.include_router(current_project.router)
app.include_router(members.router)
app.include_router(organizations.router)
app.include_router(org_invites.router)
app.include_router(invite_accept.router)
app.include_router(me.router)
app.include_router(project_settings.router)
app.include_router(webhooks.router)
app.include_router(api_keys.router)
app.include_router(agent_runs.router)
app.include_router(agent_inbox.router)
app.include_router(policy_documents.router)
app.include_router(subscription.router)
app.include_router(account.router)
app.include_router(oss.router)
app.include_router(agent_deployments.router)
app.include_router(agent_personas.router)
app.include_router(agent_routing_rules.router)
app.include_router(agent_sessions.router)
app.include_router(bridge.router)
app.include_router(cron.router)
app.include_router(hitl.router)
app.include_router(integrations.router)
app.include_router(workflow_versions.router)
app.include_router(workflow_trigger_types.router)
app.include_router(workflow_executions.router)
app.include_router(workflow_templates.router)
app.include_router(workflow_recipes.router)
app.include_router(file_locks.router)
app.include_router(workflow_report.router)
app.include_router(workflow_trigger.router)
app.include_router(mockups.router)
app.include_router(plan_features.router)
app.include_router(open_api_keys.router)
app.include_router(channel.router)
app.include_router(ws_chat.router)

if settings.is_ee_enabled:
    from ee.routers import billing  # type: ignore[import]
    app.include_router(billing.router, prefix="/api/v2/billing")
