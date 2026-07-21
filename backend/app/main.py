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
    from app.core import shutdown as shutdown_module
    from app.core.database import engine
    from app.routers.auth_firebase_internal import check_internal_secret_config
    from app.routers.cron import check_cron_secret_config
    from app.routers.verdict_capture import warn_if_webhook_secret_misconfigured
    from app.services.firebase_verifier import check_mobile_app_check_config
    from app.services.pg_pubsub import check_listen_config, listen_loop

    # story c4c72eb1(E-ARCH GCE 이전) PR-A: asyncio.Event는 최초 .wait()/.set() 시점의 실행
    # 루프에 바인딩된다 — 테스트가 TestClient(app)로 lifespan을 여러 번(서로 다른 루프로) 태우는
    # 이 코드베이스 관례(story bea25062 주석 참조) 아래에서 단순 `.clear()`는 이전 루프에 바인딩된
    # 채로 남아 다음 루프에서 RuntimeError를 낸다(뮤테이션 셀프체크로 직접 재현). startup마다
    # 객체 자체를 재생성(shutdown.py의 reset_shutdown_event 참조 — 모듈 속성 접근으로 최신
    # 객체를 읽어야 하므로 아래도 `shutdown_module.shutdown_event`로 접근, 정적 import 금지).
    shutdown_module.reset_shutdown_event()
    warn_if_webhook_secret_misconfigured()  # Bot-M.2 P3: 웹훅 secret misconfig 를 트래픽 前 경고.
    # E-ARCH S1: PG_LISTEN_ENABLED=false인 서비스(api)는 이 검증 자체가 무의미 — LISTEN을 절대
    # 안 켜므로 DB_PGBOUNCER/DATABASE_URL_DIRECT 정합을 강제할 이유가 없다(무해·불필요 fail 방지).
    if settings.pg_listen_enabled:
        check_listen_config()  # ee7794eb ③ fail-closed: DB_PGBOUNCER on + DATABASE_URL_DIRECT 없으면 startup raise.
    check_internal_secret_config()  # 산티아고 §9 finding 4: non-local + 시크릿 미설정 fail-closed.
    check_cron_secret_config()  # story #2072: non-local + CRON_SECRET 미설정 fail-closed.
    check_mobile_app_check_config()  # 산티아고 §9 finding 1: mobile 발급 on + App Check 미필수 fail-closed.
    # story bea25062: cutover 존재-캐시는 의도적으로 startup에서 warm 안 함(자체 발견 —
    # TestClient(app)로 lifespan을 태우는 기존 SSE 테스트들이 라우트 전용으로 짜둔 유한한
    # mock db.execute() 순서-큐를 startup 시점의 이 캐시 조회가 몰래 하나 소비해 실패시켰다).
    # 지연 초기화(첫 실 요청에서 채워짐)만으로 충분 — check_any_cutover_epoch_exists() 자체가
    # DB 접속 불가/미준비 시에도 fail-safe라 startup에서 먼저 확인해둘 실익이 크지 않다.
    # E-ARCH S1(2026-07-21, #2074 근본 — REST/실시간 서비스 분리 1단계): default=True(무회귀) —
    # api 서비스에 PG_LISTEN_ENABLED=false를 배선하면 이 인스턴스는 RAW_LISTEN 커넥션을 전혀
    # 안 잡는다(커넥션 예산 산식에서 이 항이 빠짐). realtime 서비스만 true로 유지.
    task = asyncio.create_task(listen_loop()) if settings.pg_listen_enabled else None
    # E-L2 S5: 휴리스틱 트리거 워커는 default-off — 명시 활성화 시에만 task 생성(AC①).
    l2_task = None
    if settings.l2_trigger_enabled:
        from app.services.l2_trigger_worker import L2TriggerWorker

        l2_task = asyncio.create_task(L2TriggerWorker().run())
    # E-ARCH S2/S3(story #2078): redis_consume_loop은 dual_publish_enabled AND
    # redis_consume_enabled 둘 다 켜져야 task 생성 — Memorystore 미배선 상태(redis_url=None)
    # 에서도 이 브랜치 자체가 안 돌아 무해. consume_enabled는 "이 서비스가 Redis를 구독해
    # dispatch하는 역할인가"(SSE를 실제로 서빙하는 realtime만 True — api는 발행만 하고 구독은
    # 불필요, GHA per-env override로 false 배선) — dual_publish_enabled(발행, 모든 인스턴스
    # 필요)와 독립적인 축이다(2026-07-21 정리, PG_LISTEN_ENABLED durable 분리와 동일 패턴).
    # ⚠️이 loop은 두 가지 일을 한다 — (1) 항상: PG 도착 기록과 대조해 지연Δ 로그(관측)
    # (2) event_broker_redis_dispatch_enabled(default False, 별개 게이트)도 켜지면
    # publish_event()/_push_to_agent()를 실제로 호출해 SSE로 전달(실 dispatch).
    redis_shadow_task = None
    if settings.event_broker_redis_dual_publish_enabled and settings.event_broker_redis_consume_enabled:
        from app.services.event_broker import redis_consume_loop

        redis_shadow_task = asyncio.create_task(redis_consume_loop())
    # E-ARCH S3(story #2078) 3a단계: outbox dispatcher는 event_broker_outbox_enabled(default
    # False)일 때만 task 생성 — 꺼져 있으면 event_outbox row 자체가 안 쌓이니(OutboxEventBroker
    # 가 insert를 스킵) 폴링할 게 없다. redis_shadow_task와 별개 게이트(outbox insert가 켜졌다고
    # 즉시 dual-publish shadow까지 켜지는 건 아니다 — 두 플래그는 독립적으로 rollout 가능).
    outbox_dispatcher_task = None
    if settings.event_broker_outbox_enabled:
        from app.services.event_broker import outbox_dispatcher_loop

        outbox_dispatcher_task = asyncio.create_task(outbox_dispatcher_loop())
    try:
        yield
    finally:
        # story c4c72eb1(E-ARCH GCE 이전) PR-A: SSE 생성기(events.py/agent_gateway.py)가
        # 이 신호를 구독해 강제 CancelledError를 기다리지 않고 스스로 정상 종료한다 — 다른
        # 정리 작업(태스크 cancel 등)보다 먼저 set해 SSE 스트림이 최대한 빨리 반응하게 한다.
        shutdown_module.shutdown_event.set()
        if task is not None:
            task.cancel()
        if l2_task is not None:
            l2_task.cancel()
        if redis_shadow_task is not None:
            redis_shadow_task.cancel()
        if outbox_dispatcher_task is not None:
            outbox_dispatcher_task.cancel()
        try:
            if task is not None:
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            if l2_task is not None:
                try:
                    await l2_task
                except asyncio.CancelledError:
                    pass
            if redis_shadow_task is not None:
                try:
                    await redis_shadow_task
                except asyncio.CancelledError:
                    pass
            if outbox_dispatcher_task is not None:
                try:
                    await outbox_dispatcher_task
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


from app.routers import a2a, account, activity_logs, activity_stream, agent_deployments, agent_gateway, agent_inbox, agent_message_policy, agent_personas, agent_routing_rules, agent_runs, agent_sessions, agents, analytics, api_keys, assets, context_pack, deeplink_manifest, gate_config, gate_metrics, attachments, audit_logs, auth, auth_firebase_internal, auth_native_bootstrap, bridge, channel, command_center, conversations, cron, current_project, dashboard, dependencies, device_installations, dispatch, docs, entities, goals, event_notifications, events, evidence, exclusion, file_locks, gates, github_integration, glance, health, hitl, hitl_config, hypotheses, integrations, invite_accept, labels, loops, mcp, me, meetings, members, merge_gate, mockups, notification_preferences, notifications, onboarding, open_api_keys, org_invites, org_members, organizations, oss, participation, plan_features, policy_documents, presence, project_access, project_settings, projects, public_docs, release_notes, resolve, retros, rewards, role_templates, runtime_capabilities, sprints, standups, stories, subscription, tasks, team_members, team_presence, trust_scores, verdict_capture, verdicts, visual_artifacts, webhooks, workflow_executions, workflow_line_config, workflow_recipes, workflow_report, workflow_templates, workflow_trigger, workflow_trigger_types, workflow_versions, ws_chat

# 도메인 축 B(org-1st-class-surface-ia-design-b §3): OpenAPI 태그 조직-우선 위계.
# 개별 라우터는 기존 세부 tag(예 "stories")를 그대로 유지하고 이 4축 태그를 추가로 보유(다중
# tags·additive) — FastAPI가 이 openapi_tags 순서대로 문서를 그룹핑하고, 여기 없는 세부 tag는
# 뒤이어 처음 등장한 순서로 노출된다. URL·오퍼레이션·세부 tag 값 불변(하위호환 100%).
_OPENAPI_TAGS = [
    {"name": "Organization", "description": "조직 — 구성원·역할·워크포스·신뢰 프로필·설정·통신"},
    {"name": "Work", "description": "작업 — 스토리·에픽·스프린트·워크플로우·산출물"},
    {"name": "Trust", "description": "신뢰 — 게이트·검증·감사 로그"},
    {"name": "Knowledge", "description": "지식 — 문서·스토리지·조직 학습(loop)"},
]

app = FastAPI(
    title="Sprintable API v2",
    description="FastAPI backend — Phase B migration layer",
    version="0.1.0",
    docs_url="/api/v2/_swagger" if settings.debug else None,
    redoc_url=None,
    lifespan=lifespan,
    openapi_tags=_OPENAPI_TAGS,
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
    # story #2003(Phase B P1-a, E-A2A-PROTO): /rpc는 JSON-RPC 2.0 엔드포인트라 auth 실패
    # (get_verified_org_id/get_current_user Depends)와 agent-not-found(_get_agent_member)가
    # 핸들러 try/except 밖(dependency 단계/조기 호출)에서 raise 돼 REST 엔벨로프 대신 JSON-RPC
    # error envelope으로 렌더해야 한다. 경로 정밀 매치(`is_a2a_rpc_path`)라 이 파일의 다른 라우트
    # (agent-card.json 등)는 전혀 영향받지 않는다 — 아래 mapped/REST 분기는 그대로 유지.
    if a2a.is_a2a_rpc_path(request.url.path):
        message = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        return await a2a.build_rpc_error_response(request, exc.status_code, message)

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

    # story #2003: /rpc의 미처리 예외도 JSON-RPC envelope으로(code=-32603 표준 Internal error,
    # retryable=True — 5xx 분류). http_exception_handler와 동일 경로-정밀 매치.
    if a2a.is_a2a_rpc_path(request.url.path):
        return await a2a.build_rpc_error_response(request, 500, detail)

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
app.include_router(assets.router)
app.include_router(release_notes.router)
app.include_router(conversations.router)
app.include_router(presence.router)
app.include_router(sprints.router)
# 계층 리네이밍 B1(story 1925): 목표(구 에픽) 전면 rename — 같은 router 객체를 신(primary)+구
# (deprecated alias) 두 prefix로 include(hierarchy-rename-alias-mechanism-design §2). FastAPI가
# 동일 APIRouter 인스턴스의 다중 prefix include를 표준 지원 — 핸들러 완전 동일, 로직 복제 0.
app.include_router(goals.router, prefix="/api/v2/goals", tags=["goals", "Work"])
app.include_router(goals.router, prefix="/api/v2/epics", tags=["epics-deprecated"], deprecated=True)
app.include_router(hypotheses.router)
app.include_router(loops.router)
app.include_router(context_pack.router)
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
app.include_router(evidence.router)
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
app.include_router(a2a.router)
app.include_router(team_presence.router)
app.include_router(org_members.router)
app.include_router(standups.router)
app.include_router(retros.router)
app.include_router(role_templates.router)
app.include_router(entities.router)
app.include_router(event_notifications.router)
app.include_router(notifications.router)
app.include_router(deeplink_manifest.router)  # story #1951: 딥링크 계약 매니페스트 v1 서빙
app.include_router(onboarding.router)
app.include_router(attachments.router)
app.include_router(notification_preferences.router)
app.include_router(analytics.router)
app.include_router(command_center.router)
app.include_router(rewards.router)
app.include_router(audit_logs.router)
app.include_router(dashboard.router)
app.include_router(glance.router)
app.include_router(current_project.router)
app.include_router(runtime_capabilities.router)
app.include_router(members.router)
app.include_router(merge_gate.router)
app.include_router(organizations.router)
app.include_router(resolve.router)
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
app.include_router(auth_firebase_internal.router)
app.include_router(auth_native_bootstrap.router)
app.include_router(device_installations.router)
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
app.include_router(visual_artifacts.router)
app.include_router(plan_features.router)
app.include_router(open_api_keys.router)
app.include_router(channel.router)
app.include_router(ws_chat.router)

if settings.is_ee_enabled:
    from ee.routers import billing  # type: ignore[import]
    app.include_router(billing.router, prefix="/api/v2/billing")

    from ee.routers import push_devices  # type: ignore[import]
    app.include_router(push_devices.router, prefix="/api/v2/push")
