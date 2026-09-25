"""story #4332 — 요청 한 번의 DB 몫 계측(app/core/request_db_timing.py)이 실 Postgres에서 맞게 세는지.

① SQL 수 · 체크아웃 수가 그 요청이 실제로 던진 만큼(Server-Timing · 로그 한 줄) — 다른 요청의 SQL이 섞이지 않는다.
② 풀이 다 찼을 때 기다린 시간이 dbwait로 잡힌다(연결 1개짜리 풀을 다른 task가 쥔 채 · 대기 ≥ 쥔 시간 근처).
"""
from __future__ import annotations

import asyncio
import logging
import os
import re

import pytest
from sqlalchemy import text

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


def _parse(header: str) -> dict[str, float]:
    out = {k: float(v) for k, v in re.findall(r"(\w+);dur=([\d.]+)", header)}
    m = re.search(r'desc="(\d+) sql"', header)
    out["sql_n"] = float(m.group(1)) if m else -1
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
            three, one = await asyncio.gather(c.get("/three"), c.get("/one"))
        t3, t1 = _parse(three.headers["server-timing"]), _parse(one.headers["server-timing"])
        assert t3["sql_n"] == 3 and t1["sql_n"] == 1, (t3, t1)  # 동시 요청의 SQL이 섞이지 않는다
        assert t3["db"] > 0 and t1["db"] > 0
        lines = [r.getMessage() for r in caplog.records if r.name == "app.db_timing"]
        assert any("path=/three" in ln and "sql_n=3" in ln and "checkouts=1" in ln for ln in lines), lines
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pool_wait_is_measured_when_pool_is_full():
    import httpx
    from sqlalchemy.ext.asyncio import create_async_engine

    from app.core.request_db_timing import TimedAsyncAdaptedQueuePool, instrument_engine

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
            r = await c.get("/one")
        await holder
        t = _parse(r.headers["server-timing"])
        assert t["dbwait"] >= (held_s - 0.05) * 1000 * 0.8, t  # 쥔 시간 근처만큼 기다렸다
        assert t["sql_n"] == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_log_line_is_off_by_default_but_header_is_always_sent(caplog, monkeypatch):
    """로그 한 줄은 환경 값(DB_TIMING_LOG_ENABLED)으로만 — 폴링 경로 때문에 양이 크다(PO). Server-Timing은 늘."""
    import httpx
    from sqlalchemy.ext.asyncio import create_async_engine

    from app.core.config import settings
    from app.core.request_db_timing import TimedAsyncAdaptedQueuePool, instrument_engine

    monkeypatch.setattr(settings, "db_timing_log_enabled", False)
    engine = create_async_engine(_async_url(), poolclass=TimedAsyncAdaptedQueuePool, pool_size=1, max_overflow=0)
    instrument_engine(engine.sync_engine)
    caplog.set_level(logging.INFO, logger="app.db_timing")
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app_with(engine)), base_url="http://t") as c:
            r = await c.get("/one")
        assert _parse(r.headers["server-timing"])["sql_n"] == 1
        assert not [rec for rec in caplog.records if rec.name == "app.db_timing"]
    finally:
        await engine.dispose()


def test_server_timing_value_shape():
    from app.core.request_db_timing import _Stats, server_timing_value

    s = _Stats()
    s.sql_n, s.sql_ms, s.wait_ms = 19, 40.0, 5.0
    v = server_timing_value(s, 60.0)
    assert v == 'dbwait;dur=5.0, db;dur=40.0;desc="19 sql", app;dur=15.0'
