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
    from app.core.database import engine
    from app.routers.verdict_capture import warn_if_webhook_secret_misconfigured
    from app.services.pg_pubsub import listen_loop

    warn_if_webhook_secret_misconfigured()  # Bot-M.2 P3: 웹훅 secret misconfig 를 트래픽 前 경고.
    task = asyncio.create_task(listen_loop())
    # E-L2 S5: 휴리스틱 트리거 워커는 default-off — 명시 활성화 시에만 task 생성(AC①).
    l2_task = None
    if settings.l2_trigger_enabled:
        from app.services.l2_trigger_worker import L2TriggerWorker

        l2_task = asyncio.create_task(L2TriggerWorker().run())
    try:
        yield
    finally:
        task.cancel()
        if l2_task is not None:
            l2_task.cancel()
        try:
            try:
                await task
            except asyncio.CancelledError:
                pass
            if l2_task is not None:
                try:
                    await l2_task
                except asyncio.CancelledError:
                    pass
        finally:
            # 좀비 연결 박멸(S:33e0c681): SIGTERM(Cloud Run 인스턴스 교체·스케일다운·리비전 삭제)
            # 시 SQLAlchemy 풀의 전 DB 연결을 정상 종료. dispose 누락 시 구 인스턴스가 연결을 안
            # 놓아 좀비 누적 → prod 100 cap 초과 → TooManyConnections(전 엔드포인트 500). lifespan
            # shutdown 은 in-flight 요청 drain 이후 실행되므로 dispose 순서 안전(AC3). pg_pubsub
            # raw 커넥션은 task.cancel→listen_loop finally 에서 이미 close. L2 워커는
            # l2_task.cancel→run finally 에서 advisory lock 해제·전용 커넥션 close.
            await engine.dispose()


from app.routers import account, activity_logs, activity_stream, agent_deployments, agent_gateway, agent_inbox, agent_message_policy, agent_personas, agent_routing_rules, agent_runs, agent_sessions, agents, analytics, api_keys, gate_config, gate_metrics, attachments, audit_logs, auth, bridge, channel, command_center, conversations, cron, current_project, dashboard, dependencies, dispatch, docs, entities, epics, event_notifications, events, exclusion, file_locks, gates, github_integration, health, hitl, hitl_config, hypotheses, integrations, invite_accept, labels, mcp, me, meetings, members, merge_gate, mockups, notification_preferences, notifications, onboarding, open_api_keys, org_invites, org_members, organizations, oss, participation, plan_features, policy_documents, presence, project_access, project_settings, projects, public_docs, retros, rewards, sprints, standups, stories, subscription, tasks, team_members, team_presence, trust_scores, verdict_capture, verdicts, webhooks, workflow_executions, workflow_line_config, workflow_recipes, workflow_report, workflow_templates, workflow_trigger, workflow_trigger_types, workflow_versions, ws_chat

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
    mapped = _HTTP_CODE_MAP.get(exc.status_code, f"HTTP_{exc.status_code}")
    detail = exc.detail
    # dict detail 은 구조화 에러 의도(code/message/suggestion·retry_after 등) → error 객체로 패스스루.
    # 기존 str(detail) 은 dict 를 Python repr 로 직렬화해 FE JSON.parse 불가 + 의도한 code 유실
    # (SLUG_TAKEN/SLUG_INVALID/USER_NOT_IN_ORG/RATE_LIMITED 4곳 동일 교정). 문자열 detail(대다수)은
    # 기존 shape 그대로 — 회귀 0.
    if isinstance(detail, dict):
        error = {"code": detail.get("code", mapped), "message": detail.get("message", "")}
        for k, v in detail.items():
            if k not in ("code", "message"):
                error[k] = v
    else:
        error = {"code": mapped, "message": str(detail)}
    return JSONResponse(
        status_code=exc.status_code,
        content={"data": None, "error": error, "meta": None},
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
app.include_router(activity_stream.router)
app.include_router(events.router)
app.include_router(agent_gateway.router)
app.include_router(dispatch.router)
app.include_router(conversations.router)
app.include_router(presence.router)
app.include_router(sprints.router)
app.include_router(epics.router)
app.include_router(hypotheses.router)
app.include_router(dependencies.router)
app.include_router(labels.router)
app.include_router(labels.item_label_router)
app.include_router(participation.router)
app.include_router(verdicts.router)
app.include_router(exclusion.router)
app.include_router(verdict_capture.router)
app.include_router(trust_scores.router)
app.include_router(hitl_config.router)
app.include_router(gates.router)
app.include_router(github_integration.router)
app.include_router(gate_config.router)
app.include_router(gate_config.org_router)
app.include_router(gate_metrics.router)
app.include_router(workflow_line_config.router)
app.include_router(tasks.router)
app.include_router(docs.router)
app.include_router(public_docs.router)
app.include_router(meetings.router)
app.include_router(stories.router)
app.include_router(projects.router)
app.include_router(project_access.router)
app.include_router(team_members.router)
app.include_router(agents.router)
app.include_router(team_presence.router)
app.include_router(org_members.router)
app.include_router(standups.router)
app.include_router(retros.router)
app.include_router(entities.router)
app.include_router(event_notifications.router)
app.include_router(notifications.router)
app.include_router(onboarding.router)
app.include_router(attachments.router)
app.include_router(notification_preferences.router)
app.include_router(analytics.router)
app.include_router(command_center.router)
app.include_router(rewards.router)
app.include_router(audit_logs.router)
app.include_router(dashboard.router)
app.include_router(current_project.router)
app.include_router(members.router)
app.include_router(merge_gate.router)
app.include_router(organizations.router)
app.include_router(org_invites.router)
app.include_router(invite_accept.router)
app.include_router(me.router)
app.include_router(mcp.router)  # E-MCP S2: toolset 매니페스트
app.include_router(project_settings.router)
app.include_router(webhooks.router)
app.include_router(api_keys.router)
app.include_router(agent_message_policy.router)  # E-MSG-POLICY S3: 메시징 정책 관리
app.include_router(agent_runs.router)
app.include_router(agent_inbox.router)
app.include_router(policy_documents.router)
app.include_router(subscription.router)
app.include_router(account.router)
app.include_router(account.accounts_router)
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
