"""story #3176(결제②-C) — `cron.py::au_usage_warn()` 실PG 검증.

doc `au-limit-enforcement-grounding-3176` §1.3 3단계(80%마커·90%메일·100%+유예)를 한 크론
순회가 전부 계산해 `org_subscriptions`에 캐시하는지 확認. Free tier는 유예 없이 즉시
paused(§11.2), 유료 tier는 110% 또는 7일 유예 — 이 둘의 갈림이 이 파일의 핵심 pin이다.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
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


def _month_period(now: datetime) -> tuple[datetime, datetime]:
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)
    return start, end


async def _seed_org_with_usage(session, *, tier: str, current_value: int, **sub_overrides) -> dict:
    org_id = uuid.uuid4()
    user_id = uuid.uuid4()
    await session.execute(
        text("INSERT INTO organizations (id,name,slug,plan) VALUES (:id,:name,:slug,'free')"),
        {"id": org_id, "name": f"org-{org_id}", "slug": f"slug-{org_id}"},
    )
    await session.execute(
        text(
            "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
            "login_fail_count,totp_enabled,totp_fail_count) VALUES "
            "(:id,:email,'x','U',true,true,0,false,0)"
        ),
        {"id": user_id, "email": f"u-{org_id}@test.local"},
    )
    await session.execute(
        text("INSERT INTO org_members (id,org_id,user_id,role) VALUES (gen_random_uuid(),:org_id,:uid,'owner')"),
        {"org_id": org_id, "uid": user_id},
    )
    cols = {"tier": tier, **sub_overrides}
    col_names = ", ".join(cols.keys())
    col_binds = ", ".join(f":{k}" for k in cols.keys())
    sub_id = uuid.uuid4()
    await session.execute(
        text(
            f"INSERT INTO org_subscriptions (id,org_id,status,currency,provider,{col_names}) "
            f"VALUES (:sid,:o,'active','krw','toss',{col_binds})"
        ),
        {"sid": sub_id, "o": org_id, **cols},
    )
    now = datetime.now(timezone.utc)
    period_start, period_end = _month_period(now)
    await session.execute(
        text(
            "INSERT INTO usage_meters (id,org_id,meter_type,current_value,period_start,period_end) "
            "VALUES (gen_random_uuid(),:o,'automation_units',:v,:ps,:pe)"
        ),
        {"o": org_id, "v": current_value, "ps": period_start, "pe": period_end},
    )
    await session.commit()
    return {"org_id": org_id, "sub_id": sub_id, "owner_email": f"u-{org_id}@test.local"}


async def _sub_row(session, sub_id):
    row = (await session.execute(
        text(
            "SELECT au_warn_80_notified_at, au_warn_90_notified_at, au_grace_started_at, "
            "au_paused_at, au_eval_at FROM org_subscriptions WHERE id = :id"
        ),
        {"id": sub_id},
    )).first()
    return {
        "warn_80": row[0], "warn_90": row[1], "grace_started": row[2],
        "paused": row[3], "eval": row[4],
    }


@pytest.mark.anyio
async def test_below_80pct_no_markers_realdb():
    from app.routers import cron

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_with_usage(s, tier="team", current_value=100_000)  # 10%
            await cron.au_usage_warn(MagicMock(), session=s)
            row = await _sub_row(s, seeded["sub_id"])
            assert row["warn_80"] is None
            assert row["warn_90"] is None
            assert row["paused"] is None
            assert row["eval"] is not None, "au_eval_at은 처리된 모든 org에 무조건 갱신돼야 함"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_80pct_sets_marker_no_email_realdb(monkeypatch):
    from app.routers import cron

    sent: list = []
    monkeypatch.setattr(cron, "send_email", lambda to, subject, html: sent.append(to) or True)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_with_usage(s, tier="team", current_value=850_000)  # 85%
            await cron.au_usage_warn(MagicMock(), session=s)
            row = await _sub_row(s, seeded["sub_id"])
            assert row["warn_80"] is not None
            assert row["warn_90"] is None
            assert seeded["owner_email"] not in sent, "80%는 마커만 — 이메일 없음(§11.1, 페드루 PO 조건②)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_90pct_sends_email_and_sets_marker_realdb(monkeypatch):
    from app.routers import cron

    sent: list = []
    monkeypatch.setattr(cron, "send_email", lambda to, subject, html: sent.append(to) or True)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_with_usage(s, tier="team", current_value=950_000)  # 95%
            await cron.au_usage_warn(MagicMock(), session=s)
            row = await _sub_row(s, seeded["sub_id"])
            assert row["warn_80"] is not None
            assert row["warn_90"] is not None
            assert seeded["owner_email"] in sent
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_90pct_cooldown_no_duplicate_email_realdb(monkeypatch):
    """dedup — cooldown(7일) 내 재발송 금지(storage_usage_warn과 동형)."""
    from app.routers import cron

    sent: list = []
    monkeypatch.setattr(cron, "send_email", lambda to, subject, html: sent.append(to) or True)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            recent_notify = datetime.now(timezone.utc) - timedelta(days=1)
            seeded = await _seed_org_with_usage(
                s, tier="team", current_value=950_000, au_warn_90_notified_at=recent_notify,
            )
            await cron.au_usage_warn(MagicMock(), session=s)
            assert seeded["owner_email"] not in sent, "cooldown 내 재발송 금지"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_re_arm_below_threshold_clears_markers_realdb(monkeypatch):
    """80%/90% 미만 복귀 시 마커 re-arm(재크로싱 시 즉시 재경고 가능해야 함)."""
    from app.routers import cron

    monkeypatch.setattr(cron, "send_email", lambda to, subject, html: True)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            now = datetime.now(timezone.utc)
            seeded = await _seed_org_with_usage(
                s, tier="team", current_value=100_000,  # 10% — 임계 아래로 복귀
                au_warn_80_notified_at=now, au_warn_90_notified_at=now,
            )
            await cron.au_usage_warn(MagicMock(), session=s)
            row = await _sub_row(s, seeded["sub_id"])
            assert row["warn_80"] is None, "80% 미만 복귀 — re-arm"
            assert row["warn_90"] is None, "90% 미만 복귀 — re-arm"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_paid_tier_100pct_within_grace_not_paused_realdb():
    """team tier가 100%를 막 넘겼으면(유예 시작) 아직 paused 아님 — 7일/110% 둘 다 미달."""
    from app.routers import cron

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_with_usage(s, tier="team", current_value=1_050_000)  # 105%
            await cron.au_usage_warn(MagicMock(), session=s)
            row = await _sub_row(s, seeded["sub_id"])
            assert row["grace_started"] is not None, "100% 크로싱 — 유예 시작 시각 기록"
            assert row["paused"] is None, "105% < 110%이고 유예 7일 미경과 — 아직 paused 아님"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_paid_tier_over_110pct_paused_immediately_within_grace_window_realdb():
    """유예 «기간» 안이어도 110%를 넘기면 즉시 paused(둘 중 먼저 오는 조건, §11.2)."""
    from app.routers import cron

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            recent_grace_start = datetime.now(timezone.utc) - timedelta(hours=1)
            seeded = await _seed_org_with_usage(
                s, tier="team", current_value=1_150_000,  # 115% >= 110%
                au_grace_started_at=recent_grace_start,
            )
            await cron.au_usage_warn(MagicMock(), session=s)
            row = await _sub_row(s, seeded["sub_id"])
            assert row["paused"] is not None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_paid_tier_grace_window_expired_paused_realdb():
    """유예 7일 경과 시 110% 미달이어도 paused(둘 중 먼저 오는 조건, 반대편)."""
    from app.routers import cron

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            old_grace_start = datetime.now(timezone.utc) - timedelta(days=8)
            seeded = await _seed_org_with_usage(
                s, tier="team", current_value=1_020_000,  # 102% < 110%
                au_grace_started_at=old_grace_start,
            )
            await cron.au_usage_warn(MagicMock(), session=s)
            row = await _sub_row(s, seeded["sub_id"])
            assert row["paused"] is not None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_free_tier_100pct_paused_immediately_no_grace_realdb():
    """§11.2 "Free AU: 즉시 경고→쓰기 중지" — 유예 없이 즉시 paused."""
    from app.routers import cron

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_with_usage(s, tier="free", current_value=50_000)  # 정확히 100%
            await cron.au_usage_warn(MagicMock(), session=s)
            row = await _sub_row(s, seeded["sub_id"])
            assert row["paused"] is not None, "Free는 유예 없이 100%에서 즉시 paused"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_drop_below_100pct_clears_grace_and_pause_realdb():
    """사용량이 (다음 달 리셋 등으로) 100% 아래로 내려가면 유예·paused 둘 다 해제."""
    from app.routers import cron

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            now = datetime.now(timezone.utc)
            seeded = await _seed_org_with_usage(
                s, tier="team", current_value=100_000,  # 10% — 이미 정상 범위
                au_grace_started_at=now - timedelta(days=1), au_paused_at=now - timedelta(days=1),
            )
            await cron.au_usage_warn(MagicMock(), session=s)
            row = await _sub_row(s, seeded["sub_id"])
            assert row["grace_started"] is None
            assert row["paused"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unknown_tier_skipped_eval_at_untouched_realdb():
    """미지 tier — au_eval_at도 안 건드림(다음 요청이 stale 캐시로 자연 fail-open하도록,
    "평가했다"는 잘못된 신호를 남기지 않는다)."""
    from app.routers import cron

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_with_usage(s, tier="pro_legacy_ghost", current_value=100_000)
            await cron.au_usage_warn(MagicMock(), session=s)
            row = await _sub_row(s, seeded["sub_id"])
            assert row["eval"] is None, "미지 tier는 평가 자체를 스킵 — eval_at 안 채움"
    finally:
        await engine.dispose()
