"""story #4332 — 요청 한 번의 DB 몫 계측(app/core/request_db_timing.py)이 실 Postgres에서 맞게 세는지.

① SQL 수 · 체크아웃 수가 그 요청이 실제로 던진 만큼(로그 한 줄) — 다른 요청의 SQL이 섞이지 않는다.
② 풀이 다 찼을 때 기다린 시간이 wait_ms로 잡힌다(연결 1개짜리 풀을 다른 task가 쥔 채 · 대기 ≥ 쥔 시간 근처).
③ 응답 헤더엔 계측이 없다(Server-Timing 0 · 로그 켬/끔 둘 다) — SQL 수 · 처리 시간이 응답에 실리면 «남의 자원 vs 없는 자원»이
   헤더로 갈려 존재 여부가 샌다(test_2261_c3 참조 누출 0 절차가 PR 4697 CI에서 잡음).
"""
from __future__ import annotations

import asyncio
import logging
import os
import re

import pytest
from fastapi import BackgroundTasks  # 모듈 수준 — `from __future__ import annotations`에서 핸들러 주석을 풀 수 있게
from sqlalchemy import text

# 앱 엔진은 수집 때 실제 플래그로 만든다 — 아래 테스트들이 플래그를 켠 채 처음 import되면 그 값으로 계측이 달려 «꺼짐» 판정이 흐려진다.
import app.core.database  # noqa: E402, F401

_REAL_DB_URL = os.environ.get("PARITY_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL")
pytestmark = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")


def _async_url() -> str:
    url = _REAL_DB_URL or ""
    return url.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")


def _app_with(engine):
    from fastapi import FastAPI

    from app.core.request_db_timing import RequestDbTimingMiddleware

    app = FastAPI()

    @app.get("/three")
    async def three():
        async with engine.connect() as conn:
            for _ in range(3):
                await conn.execute(text("select 1"))
        return {"ok": True}

    @app.get("/one")
    async def one():
        async with engine.connect() as conn:
            await conn.execute(text("select 1"))
        return {"ok": True}

    return RequestDbTimingMiddleware(app)


def _lines(caplog, path: str) -> list[dict[str, float]]:
    """로그 한 줄(`db_timing … key=value …`)을 경로별로 읽는다."""
    out = []
    for r in caplog.records:
        msg = r.getMessage()
        if r.name == "app.db_timing" and f" path={path} " in msg:
            out.append({k: float(v) for k, v in re.findall(r"(\w+)=([\d.]+)", msg) if k != "status"})
    return out


@pytest.mark.anyio
async def test_counts_only_this_requests_sql_and_checkouts(caplog, monkeypatch):
    import httpx
    from sqlalchemy.ext.asyncio import create_async_engine

    from app.core.config import settings
    from app.core.request_db_timing import TimedAsyncAdaptedQueuePool, instrument_engine

    monkeypatch.setattr(settings, "db_timing_log_enabled", True)
    engine = create_async_engine(_async_url(), poolclass=TimedAsyncAdaptedQueuePool, pool_size=2, max_overflow=0)
    instrument_engine(engine.sync_engine)
    caplog.set_level(logging.INFO, logger="app.db_timing")
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app_with(engine)), base_url="http://t") as c:
            await asyncio.gather(c.get("/three"), c.get("/one"))
        (t3,), (t1,) = _lines(caplog, "/three"), _lines(caplog, "/one")
        assert (t3["sql_n"], t1["sql_n"]) == (3, 1), (t3, t1)  # 동시 요청의 SQL이 섞이지 않는다
        assert (t3["checkouts"], t1["checkouts"]) == (1, 1)
        assert t3["sql_ms"] > 0 and t1["sql_ms"] > 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pool_wait_is_measured_when_pool_is_full(caplog, monkeypatch):
    import httpx
    from sqlalchemy.ext.asyncio import create_async_engine

    from app.core.request_db_timing import TimedAsyncAdaptedQueuePool, instrument_engine

    from app.core.config import settings

    monkeypatch.setattr(settings, "db_timing_log_enabled", True)
    caplog.set_level(logging.INFO, logger="app.db_timing")
    engine = create_async_engine(
        _async_url(), poolclass=TimedAsyncAdaptedQueuePool, pool_size=1, max_overflow=0, pool_timeout=10,
    )
    instrument_engine(engine.sync_engine)
    held_s = 0.4
    try:
        async with engine.connect() as warm:  # 물리 연결을 미리 만들어 둔다(대기에 연결 시간이 섞이지 않게)
            await warm.execute(text("select 1"))

        async def hold():
            async with engine.connect() as conn:
                await conn.execute(text("select 1"))
                await asyncio.sleep(held_s)

        holder = asyncio.create_task(hold())
        await asyncio.sleep(0.05)  # 쥔 쪽이 먼저 연결을 가져가게
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app_with(engine)), base_url="http://t") as c:
            await c.get("/one")
        await holder
        (t,) = _lines(caplog, "/one")
        assert t["wait_ms"] >= (held_s - 0.05) * 1000 * 0.8, t  # 쥔 시간 근처만큼 기다렸다
        assert t["sql_n"] == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("log_enabled", [False, True])
async def test_no_timing_in_response_headers_and_log_follows_setting(caplog, monkeypatch, log_enabled):
    """③ 응답 헤더엔 계측이 없다(켬/끔 둘 다 · 존재 여부 누출 방지) · 로그 한 줄은 DB_TIMING_LOG_ENABLED일 때만."""
    import httpx
    from sqlalchemy.ext.asyncio import create_async_engine

    from app.core.config import settings
    from app.core.request_db_timing import TimedAsyncAdaptedQueuePool, instrument_engine

    monkeypatch.setattr(settings, "db_timing_log_enabled", log_enabled)
    engine = create_async_engine(_async_url(), poolclass=TimedAsyncAdaptedQueuePool, pool_size=1, max_overflow=0)
    instrument_engine(engine.sync_engine)
    caplog.set_level(logging.INFO, logger="app.db_timing")
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app_with(engine)), base_url="http://t") as c:
            r = await c.get("/one")
        assert r.status_code == 200
        assert "server-timing" not in {k.lower() for k in r.headers.keys()}, dict(r.headers)
        assert len(_lines(caplog, "/one")) == (1 if log_enabled else 0)
    finally:
        await engine.dispose()


# ── 까디르 4697 ①~③ ──────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("enabled", [False, True])
def test_instrumentation_attaches_only_when_flag_is_on(monkeypatch, enabled):
    """① 꺼져 있으면 비용 0 — 계측 풀도 cursor 리스너도 없다(쿼리마다 perf_counter · conn.info · ContextVar 조회 0)."""
    from sqlalchemy import create_engine

    from app.core.config import settings
    from app.core.request_db_timing import TimedAsyncAdaptedQueuePool, engine_pool_kwargs, instrument_if_enabled

    monkeypatch.setattr(settings, "db_timing_log_enabled", enabled)
    eng = create_engine("sqlite://")
    try:
        assert instrument_if_enabled(eng) is enabled
        assert len(eng.dispatch.after_cursor_execute) == (1 if enabled else 0)
        assert len(eng.dispatch.before_cursor_execute) == (1 if enabled else 0)
        assert (engine_pool_kwargs().get("poolclass") is TimedAsyncAdaptedQueuePool) is enabled
    finally:
        eng.dispose()


def test_app_engine_and_middleware_are_bare_when_flag_is_off():
    """① 실제 앱(테스트 기본 = 꺼짐): 요청 엔진 · 읽기 엔진에 리스너 0 · 계측 미들웨어 미등록 · 기본 풀."""
    from app.core import request_db_timing as rdt
    from app.core.config import settings
    from app.core.database import engine, read_engine
    from app.main import app

    assert settings.db_timing_log_enabled is False
    for e in (engine, read_engine):
        # 앱엔 다른 cursor 리스너도 있다 — 이 계측의 리스너를 달았는지는 계측 표(_instrumented)로 본다.
        assert e.sync_engine not in rdt._instrumented
        assert not isinstance(e.sync_engine.pool, rdt.TimedAsyncAdaptedQueuePool)
    RequestDbTimingMiddleware = rdt.RequestDbTimingMiddleware
    assert all(m.cls is not RequestDbTimingMiddleware for m in app.user_middleware)


def _app_with_after_response_work(engine, background_sql: int, detached_sql: int):
    import asyncio as _asyncio

    from fastapi import FastAPI

    from app.core.request_db_timing import RequestDbTimingMiddleware

    app = FastAPI()
    done = _asyncio.Event()

    async def run_sql(n: int) -> None:
        async with engine.connect() as conn:
            for _ in range(n):
                await conn.execute(text("select 1"))

    @app.get("/bg")
    async def bg(background_tasks: BackgroundTasks):
        await run_sql(1)

        async def after_response_detached():
            await _asyncio.sleep(0.05)  # 응답이 나간 뒤에 돈다
            await run_sql(detached_sql)
            done.set()

        _asyncio.get_running_loop().create_task(after_response_detached())
        background_tasks.add_task(run_sql, background_sql)
        return {"ok": True}

    return RequestDbTimingMiddleware(app), done


@pytest.mark.anyio
async def test_sql_after_response_start_is_not_counted(caplog, monkeypatch):
    """② 응답 시작에서 요청 몫을 닫는다 — BackgroundTasks · 요청 중 떼어 낸 태스크의 SQL이 요청 수에 섞이지 않는다."""
    import httpx
    from sqlalchemy.ext.asyncio import create_async_engine

    from app.core.config import settings
    from app.core.request_db_timing import TimedAsyncAdaptedQueuePool, instrument_engine

    monkeypatch.setattr(settings, "db_timing_log_enabled", True)
    engine = create_async_engine(_async_url(), poolclass=TimedAsyncAdaptedQueuePool, pool_size=3, max_overflow=0)
    instrument_engine(engine.sync_engine)
    caplog.set_level(logging.INFO, logger="app.db_timing")
    app, done = _app_with_after_response_work(engine, background_sql=4, detached_sql=5)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/bg")
        assert r.status_code == 200
        await asyncio.wait_for(done.wait(), timeout=5)  # 떼어 낸 태스크의 SQL까지 다 돈 뒤에
        (t,) = _lines(caplog, "/bg")
        assert t["sql_n"] == 1, t  # 핸들러 몫 1만 · BackgroundTasks 4 · 떼어 낸 5는 0
        assert t["checkouts"] == 1, t
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unmatched_route_logs_fixed_label_not_raw_path(caplog, monkeypatch):
    """③ 매칭 라우트가 없으면(404) 경로 원문(속 id) 대신 고정 라벨."""
    import httpx
    from sqlalchemy.ext.asyncio import create_async_engine

    from app.core.config import settings
    from app.core.request_db_timing import UNMATCHED_ROUTE_LABEL

    monkeypatch.setattr(settings, "db_timing_log_enabled", True)
    engine = create_async_engine(_async_url(), pool_size=1, max_overflow=0)
    caplog.set_level(logging.INFO, logger="app.db_timing")
    secret_id = "7f3a9c1e-0000-4000-8000-00000000abcd"
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app_with(engine)), base_url="http://t") as c:
            r = await c.get(f"/no-such-route/{secret_id}")
        assert r.status_code == 404
        msgs = [rec.getMessage() for rec in caplog.records if rec.name == "app.db_timing"]
        assert len(msgs) == 1 and f" path={UNMATCHED_ROUTE_LABEL} " in msgs[0], msgs
        assert secret_id not in msgs[0]
    finally:
        await engine.dispose()
