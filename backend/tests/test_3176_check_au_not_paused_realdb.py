"""story #3176(결제②-C) — `ee/plan_limits.py::check_au_not_paused()` 실PG 검증.

doc `au-limit-enforcement-grounding-3176` §1.3/§1.4·페드루 PO 승인(2026-08-28): paused
여부는 요청마다 재계산하지 않고 크론이 캐시해둔 `org_subscriptions.au_paused_at`만 읽는다.
`au_eval_at`(크론 최종 평가 시각)이 stale이면(크론이 죽은 것으로 추정) 캐시를 신뢰하지
않고 fail-open — 이게 이 파일의 핵심 pin이다(페드루 PO 명시 조건).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import text

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_subscription(session, *, tier="team", **overrides) -> uuid.UUID:
    org_id = uuid.uuid4()
    await session.execute(
        text("INSERT INTO organizations (id,name,slug,plan) VALUES (:id,:name,:slug,'free')"),
        {"id": org_id, "name": f"org-{org_id}", "slug": f"slug-{org_id}"},
    )
    cols = {"tier": tier, **overrides}
    col_names = ", ".join(cols.keys())
    col_binds = ", ".join(f":{k}" for k in cols.keys())
    await session.execute(
        text(
            f"INSERT INTO org_subscriptions (id,org_id,status,currency,provider,{col_names}) "
            f"VALUES (gen_random_uuid(),:o,'active','krw','toss',{col_binds})"
        ),
        {"o": org_id, **cols},
    )
    await session.commit()
    return org_id


@pytest.mark.anyio
async def test_no_subscription_row_fails_open_realdb():
    from ee.plan_limits import check_au_not_paused

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            await check_au_not_paused(s, uuid.uuid4())  # 구독 행 자체 없음 — 예외 없어야 함
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_paused_at_null_passes_through_realdb():
    from ee.plan_limits import check_au_not_paused

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org_subscription(s, tier="team")
            await check_au_not_paused(s, org_id)  # au_paused_at NULL — 통과
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_paused_with_fresh_eval_raises_402_realdb():
    from ee.plan_limits import check_au_not_paused

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            now = datetime.now(timezone.utc)
            org_id = await _seed_org_subscription(
                s, tier="team", au_paused_at=now, au_eval_at=now,
            )
            with pytest.raises(HTTPException) as exc_info:
                await check_au_not_paused(s, org_id)
            assert exc_info.value.status_code == 402
            assert exc_info.value.detail["code"] == "PLAN_LIMIT_EXCEEDED"
            assert exc_info.value.detail["resource"] == "automation_units"
            assert exc_info.value.detail["upgrade_required"] is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_paused_business_tier_no_upgrade_wording_realdb():
    """유나양 조건(§2906 관례 동형) — business는 더 위 tier가 없어 업그레이드 권유 문구를 뺀다."""
    from ee.plan_limits import check_au_not_paused

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            now = datetime.now(timezone.utc)
            org_id = await _seed_org_subscription(
                s, tier="business", au_paused_at=now, au_eval_at=now,
            )
            with pytest.raises(HTTPException) as exc_info:
                await check_au_not_paused(s, org_id)
            assert exc_info.value.detail["upgrade_required"] is False
            assert "업그레이드" not in exc_info.value.detail["message"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_stale_eval_fails_open_realdb():
    """핵심 pin(페드루 PO 명시 조건, 2026-08-28) — au_eval_at이 stale(크론 정지 추정)이면
    au_paused_at이 세팅돼 있어도 차단하지 않는다."""
    from ee.plan_limits import check_au_not_paused

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            now = datetime.now(timezone.utc)
            stale_eval = now - timedelta(minutes=30)  # _AU_PAUSE_CACHE_STALENESS(15분) 초과
            org_id = await _seed_org_subscription(
                s, tier="team", au_paused_at=now, au_eval_at=stale_eval,
            )
            await check_au_not_paused(s, org_id)  # 예외 없어야 함 — fail-open
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_eval_just_within_staleness_window_still_blocks_realdb():
    """경계값 반대편 — staleness 창 «안»이면 정상적으로 차단해야 함(살아있는 캐시 무시 방지)."""
    from ee.plan_limits import check_au_not_paused

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            now = datetime.now(timezone.utc)
            recent_eval = now - timedelta(minutes=5)
            org_id = await _seed_org_subscription(
                s, tier="team", au_paused_at=now, au_eval_at=recent_eval,
            )
            with pytest.raises(HTTPException):
                await check_au_not_paused(s, org_id)
    finally:
        await engine.dispose()
