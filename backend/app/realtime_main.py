"""story #2089(2026-07-25) — realtime 전용 entrypoint, stage 2 시제품.

⛔ 이 파일은 기존 app/main.py를 대체하지 않는다(무터치). 목적은 «SSE router + 그 의존만
마운트한 별도 앱을 실제로 띄워서 진짜 필요한 모듈이 뭔지 측정하는 것»이다(오르테가군 지시
2026-07-25) — 정적 import 그래프만으로는 app/main.py:368의 `is_ee_enabled` 게이트처럼
"조건부지만 지금 실제로 실행되는" 배선을 놓친다는 것이 오늘 실물로 드러났다.

전략 — "처음엔 넉넉히 잡고 측정 결과로 깎는다": app.main.lifespan()의 로직 중 realtime의
실제 역할(cross-node event 수신 → SSE로 fan-out)에 관련된 부분은 그대로 가져오고, 다른
89개 REST 라우터는 마운트하지 않는다. ee 게이트(app.main:368의 billing/push_devices
include_router)는 아예 옮기지 않는다 — realtime은 그 라우트를 서빙할 이유가 없으므로
"빼는" 게 아니라 "처음부터 안 부르는" 것(오르테가군 판단 그대로).

⚠️ 미해결 — a2a.router(JSON-RPC SendStreamingMessage, 자체 SSE형 무기한 스트림)를 여기
포함해야 하는지 판단 보류. 이 세션에서 "SSE router"로 계속 지칭해 온 것은 events.py/
agent_gateway.py 둘뿐이라(오늘 _SSE_LIFESPAN_SEC/_AGENT_SSE_LIFESPAN_SEC로 다룬 그 둘) 이
둘만 마운트했다 — a2a는 별도 판단이 필요하면 그때 추가.

a2a.router 판단 확定(2026-07-25, 오르테가군 실측) — 제외:
  ① 24시간 a2a 트래픽 실측: 50건 전부 backend-dev · realtime-dev 0건 — a2a는 지금
     backend에서만 서빙되고 realtime으로 라우팅되지 않는다.
  ② a2a는 이미 자체 _A2A_RPC_TIMEOUT_SECONDS=280s 상한을 갖고 있다 — 오늘 고친 SSE
     wall-clock 캡 결함군(감지 실패로 인한 무기한 점유)이 아니다.
  넣으면 "라우팅이 없는 것을 이미지에만 얹는" 것이라 표면만 늘어난다.
  무너지는 조건: a2a 스트리밍을 realtime으로 라우팅하기로 결정하면 그때 이 entrypoint에
  편입한다 — ①(라우팅이 backend로 감) 또는 ②(자체 280s 상한이 이 결함군과 무관함) 중
  하나라도 바뀌면 재검토.
"""
from __future__ import annotations

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
async def realtime_lifespan(app: FastAPI):
    """app.main.lifespan()의 부분집합 — realtime이 실제로 쓰는 축만.

    제외한 것과 이유(넉넉히 잡되 명백히 무관한 것만 뺌):
    - check_internal_secret_config/check_cron_secret_config/check_mobile_app_check_config:
      auth_firebase_internal(웹뷰 핸드오프)·cron(REST 엔드포인트)·mobile app check(REST 인증) —
      전부 realtime이 서빙 안 하는 REST 표면의 설정 가드. 측정 단계에서 굳이 끌고 오지 않음.
    - warn_if_webhook_secret_misconfigured: 웹훅 발송은 dispatch.router(REST) 쪽 관심사.
    포함한 것:
    - shutdown_event 리셋 — events.py/agent_gateway.py 둘 다 이 신호를 구독해 정상 종료함(필수).
    - backplane 해석 + PG LISTEN 또는 Redis consume 루프 — realtime의 존재 이유(cross-node
      event 수신) 그 자체.
    - #2138 outbox+dual_publish 동시활성화 fail-closed 가드 — 부팅 안전성 가드라 값이 쌈.
    - outbox_dispatcher_loop — event_broker_outbox_enabled 조합에서 realtime도 관련될 수 있어
      우선 포함(측정 결과로 불필요하면 뺀다).
    - engine.dispose() — 좀비 커넥션 방지, 다른 서비스와 동형으로 필수.
    """
    from app.core import shutdown as shutdown_module
    from app.core.database import engine
    from app.services.event_broker import (
        check_outbox_dual_publish_config,
        outbox_dispatcher_loop,
        redis_consume_loop,
        resolve_backplane,
    )
    from app.services.pg_pubsub import check_listen_config, listen_loop

    shutdown_module.reset_shutdown_event()
    check_outbox_dual_publish_config()

    backplane = resolve_backplane(log_conflict=True)
    if backplane == "redis" and not (
        settings.event_broker_redis_dual_publish_enabled
        and settings.event_broker_redis_consume_enabled
    ):
        _logger.error(
            "REALTIME_BACKPLANE=redis(또는 dispatch_enabled)인데 consume loop 미기동"
            "(dual_publish/consume off) = dispatcher 0. PG listen 으로 폴백. (#2122 정합성 가드)"
        )
        backplane = "pg"
    if backplane == "pg":
        check_listen_config()

    listen_task = asyncio.create_task(listen_loop()) if backplane == "pg" else None

    redis_shadow_task = None
    if settings.event_broker_redis_dual_publish_enabled and settings.event_broker_redis_consume_enabled:
        redis_shadow_task = asyncio.create_task(redis_consume_loop())

    outbox_dispatcher_task = None
    if settings.event_broker_outbox_enabled:
        outbox_dispatcher_task = asyncio.create_task(outbox_dispatcher_loop())

    try:
        yield
    finally:
        shutdown_module.shutdown_event.set()
        for t in (listen_task, redis_shadow_task, outbox_dispatcher_task):
            if t is not None:
                t.cancel()
        for t in (listen_task, redis_shadow_task, outbox_dispatcher_task):
            if t is not None:
                try:
                    await t
                except asyncio.CancelledError:
                    pass
        await engine.dispose()


# story #2089 핵심 — 여기서 딱 두 라우터만 import한다. app.main.py:147의 90+ 모듈
# 일괄 import(alembic·ee·mcp 게이트를 함께 끌고 오는 그 배선)를 반복하지 않는 것이
# 이 entrypoint의 전체 목적이다.
from app.routers import agent_gateway, events  # noqa: E402

app = FastAPI(
    title="Sprintable Realtime Gateway (stage2 측정용 시제품)",
    description="SSE router만 서빙 — app.main과 별개 entrypoint(#2089)",
    version="0.1.0-stage2",
    docs_url=None,
    redoc_url=None,
    lifespan=realtime_lifespan,
)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    mapped = {
        400: "BAD_REQUEST", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND",
        409: "CONFLICT", 422: "UNPROCESSABLE_ENTITY", 429: "RATE_LIMITED",
    }.get(exc.status_code, f"HTTP_{exc.status_code}")
    detail = exc.detail
    if isinstance(detail, dict):
        error = {"code": detail.get("code", mapped), "message": detail.get("message", "")}
        for k, v in detail.items():
            if k not in ("code", "message"):
                error[k] = v
    else:
        error = {"code": mapped, "message": str(detail)}
    return JSONResponse(status_code=exc.status_code, content={"data": None, "error": error, "meta": None}, headers=exc.headers)


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    resp = JSONResponse(status_code=429, content={"data": None, "error": {"code": "RATE_LIMITED", "message": "Too many requests"}, "meta": None})
    resp.headers["Retry-After"] = str(getattr(exc, "retry_after", 60))
    return resp


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    _logger.exception("Unhandled exception on %s %s: %s", request.method, request.url.path, exc)
    detail = str(exc) if settings.debug else "Internal server error"
    return JSONResponse(status_code=500, content={"data": None, "error": {"code": "INTERNAL_ERROR", "message": detail}, "meta": None})


app.state.limiter = limiter

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Org-Id", "X-Project-Id", "X-Request-ID"],
)

app.include_router(events.router)
app.include_router(agent_gateway.router)
