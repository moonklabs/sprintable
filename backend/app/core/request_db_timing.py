"""story #4332 — 요청 한 번의 DB 몫을 가른다: **풀 체크아웃 대기 ms · SQL 수 · SQL 합계 ms**.

왜: `/api/v2/gates`가 서버 로그 중앙 483ms인데, 같은 핸들러를 dev 데이터로 직접 돌리면 따뜻할 때 55~59ms(SQL 19개 · 40ms)였다.
남는 몫이 «연결을 기다림»(인스턴스당 풀 4 · 폴링이 계속 드나듦)인지 «풀 경로 왕복이 느림»인지 «조립»인지를 요청마다 로그로 가른다.

- SQL 수 · 합계: 엔진 cursor 이벤트(before/after_cursor_execute) — 요청 범위 contextvar에 더한다. SQLAlchemy async의 greenlet은
  드라이버 context를 그대로 쓴다(`gr_context = driver.gr_context`) — 요청 task의 contextvar가 보인다.
- 풀 대기: 풀 클래스 `_do_get`(연결 하나를 내줄 때까지 · 새 물리 연결이면 연결 시간 포함)을 잰다.
- 노출: 요청마다 로그 한 줄(`db_timing ...` · 키=값 · `DB_TIMING_LOG_ENABLED`일 때만 — 폴링 경로 때문에 양이 크다).
  **응답 헤더에는 싣지 않는다**(Server-Timing 0): SQL 수 · 처리 시간이 응답에 실리면 «남의 자원 vs 없는 자원»이 헤더로
  갈려 존재 여부가 샌다(test_2261_c3 참조 누출 0 절차가 잡음 · PR 4697 CI).

계측 실패는 요청에 영향 0(fail-open) — 모든 기록은 try 안에서만.
"""
from __future__ import annotations

import logging
import time
import weakref
from contextvars import ContextVar
from typing import Any

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.pool import AsyncAdaptedQueuePool

logger = logging.getLogger("app.db_timing")


class _Stats:
    __slots__ = ("sql_n", "sql_ms", "wait_ms", "checkouts")

    def __init__(self) -> None:
        self.sql_n = 0
        self.sql_ms = 0.0
        self.wait_ms = 0.0
        self.checkouts = 0


_current: ContextVar[_Stats | None] = ContextVar("request_db_timing", default=None)
_instrumented: "weakref.WeakSet[Engine]" = weakref.WeakSet()


def current_stats() -> _Stats | None:
    return _current.get()


def begin() -> tuple[_Stats, Any]:
    """요청 범위를 연다(테스트 · 미들웨어). 돌려받은 토큰으로 `end`."""
    stats = _Stats()
    return stats, _current.set(stats)


def end(token: Any) -> None:
    _current.reset(token)


class TimedAsyncAdaptedQueuePool(AsyncAdaptedQueuePool):
    """연결을 내줄 때까지(대기 + 필요하면 새 연결)를 요청 범위에 더한다. 동작은 부모와 같다."""

    def _do_get(self):  # noqa: ANN202 — SQLAlchemy 내부 서명 그대로
        start = time.perf_counter()
        try:
            return super()._do_get()
        finally:
            stats = _current.get()
            if stats is not None:
                stats.wait_ms += (time.perf_counter() - start) * 1000
                stats.checkouts += 1


def instrument_engine(sync_engine: Engine) -> None:
    """엔진 하나에 SQL 수 · 시간 이벤트를 단다(같은 엔진에 두 번 달지 않는다)."""
    if sync_engine in _instrumented:
        return
    _instrumented.add(sync_engine)

    @event.listens_for(sync_engine, "before_cursor_execute")
    def _before(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
        conn.info["db_timing_t0"] = time.perf_counter()

    @event.listens_for(sync_engine, "after_cursor_execute")
    def _after(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
        stats = _current.get()
        t0 = conn.info.pop("db_timing_t0", None)
        if stats is not None and t0 is not None:
            stats.sql_n += 1
            stats.sql_ms += (time.perf_counter() - t0) * 1000

    @event.listens_for(sync_engine, "handle_error")
    def _error(ctx):  # noqa: ANN001 — 실패한 문장도 센다(시간은 실패까지)
        conn = ctx.connection
        stats = _current.get()
        t0 = conn.info.pop("db_timing_t0", None) if conn is not None else None
        if stats is not None and t0 is not None:
            stats.sql_n += 1
            stats.sql_ms += (time.perf_counter() - t0) * 1000


class _SkipLog(Exception):
    pass


class RequestDbTimingMiddleware:
    """순수 ASGI — BaseHTTPMiddleware는 핸들러를 다른 task에서 돌려 contextvar가 끊길 수 있다."""

    def __init__(self, app) -> None:  # noqa: ANN001
        self.app = app

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        stats, token = begin()
        start = time.perf_counter()
        status = 500
        try:
            # 응답은 손대지 않고 그대로 보낸다(헤더 0) — 상태 코드만 로그용으로 읽는다.
            async def send_and_capture(message):  # noqa: ANN001
                nonlocal status
                if message.get("type") == "http.response.start":
                    status = message.get("status", status)
                await send(message)

            await self.app(scope, receive, send_and_capture)
        finally:
            try:
                from app.core.config import settings  # 읽는 때에 본다(테스트가 값을 바꿀 수 있게)

                if not settings.db_timing_log_enabled:
                    raise _SkipLog
                total_ms = (time.perf_counter() - start) * 1000
                route = scope.get("route")
                path = getattr(route, "path", None) or scope.get("path", "")
                logger.info(
                    "db_timing method=%s path=%s status=%s total_ms=%.1f wait_ms=%.1f checkouts=%d sql_n=%d sql_ms=%.1f app_ms=%.1f",
                    scope.get("method"), path, status, total_ms, stats.wait_ms, stats.checkouts, stats.sql_n,
                    stats.sql_ms, max(total_ms - stats.sql_ms - stats.wait_ms, 0.0),
                )
            except _SkipLog:
                pass
            except Exception:  # noqa: BLE001
                pass
            end(token)
