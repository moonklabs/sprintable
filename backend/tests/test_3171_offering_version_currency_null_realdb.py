"""story #3171(P1) — 실PG 검증. `org_subscriptions.currency`가 NULL인 레거시 행(#2471
도입 시 nullable·"기존 행/어댑터 미기입 행은 NULL"이 설계상 정상 상태)에서 하향/취소
예약이 «활성 offering_version이 실재하는데도» 400으로 막히던 결함(`_offering_or_raise`가
`currency=sub.currency`를 그대로 넘겨 `OfferingVersion.currency == None` → SQLAlchemy가
`IS NULL`로 컴파일 → krw 행만 있는 카탈로그에서 매치 0건)의 회귀 가드.

커버:
  AC2/3 양성 — currency=NULL(레거시 행) 상태에서도 reserve_downgrade·cancel_subscription
             둘 다 200 상당(성공) — pending_* 예약이 실제로 걸린다.
  AC3 음성대조 — «진짜 활성 offering_version이 없는» 경우(카탈로그에 없는 통화)는 여전히
             DowngradeError(400) — 이번 수정이 조회 안전판 자체를 무력화한 게 아님을 실증.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed_org(session):
    org_id = uuid.uuid4()
    await session.execute(
        text("INSERT INTO organizations (id, name, slug, plan) VALUES (:id, :name, :slug, 'free')"),
        {"id": org_id, "name": f"test-org-{org_id}", "slug": f"slug-{org_id}"},
    )
    await session.commit()
    return org_id


async def _seed_legacy_subscription(session, org_id, *, tier="business", currency=None, provider=None, period_end=None):
    """currency/provider/offering_version_id 전부 NULL — #2471 이전(어댑터 미기입) 실제
    레거시 행 모양 그대로 재현. offering_version_id도 NULL(grandfather 미백필)이라
    org_subscription_downgrade 쪽 조회가 오직 `sub.currency`(=None) 하나에만 의존한다."""
    period_end = period_end or (datetime.now(timezone.utc) + timedelta(days=20))
    await session.execute(
        text(
            "INSERT INTO org_subscriptions "
            "(id, org_id, tier, billing_cycle, status, currency, provider, offering_version_id, "
            " current_period_start, current_period_end) "
            "VALUES (:id, :org_id, :tier, 'monthly', 'active', :currency, :provider, NULL, :ps, :pe)"
        ),
        {
            "id": uuid.uuid4(),
            "org_id": org_id,
            "tier": tier,
            "currency": currency,
            "provider": provider,
            "ps": period_end - timedelta(days=10),
            "pe": period_end,
        },
    )
    await session.commit()
    return period_end


@pytest.mark.anyio
async def test_reserve_downgrade_succeeds_with_legacy_null_currency_realdb():
    from app.services.org_subscription_downgrade import reserve_downgrade

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            await _seed_legacy_subscription(session, org_id, tier="business", currency=None, provider=None)

            sub = await reserve_downgrade(session, org_id=org_id, new_tier="starter")

            assert sub.tier == "business", "즉시 전이 없음"
            assert sub.pending_tier == "starter"
            assert sub.pending_offering_version_id is not None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cancel_subscription_succeeds_with_legacy_null_currency_realdb():
    from app.services.org_subscription_downgrade import cancel_subscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            await _seed_legacy_subscription(session, org_id, tier="team", currency=None, provider=None)

            sub = await cancel_subscription(session, org_id=org_id)

            assert sub.tier == "team", "즉시 전이 없음"
            assert sub.pending_tier == "free"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_offering_lookup_still_rejects_currency_with_no_active_catalog_row_realdb():
    """음성대조 — 카탈로그에 없는 통화(usd, 현재 krw만 존재)면 fallback도 못 구해내고
    여전히 DowngradeError. `sub.currency or "krw"`가 «항상 통과»로 바뀐 게 아님을 실증."""
    from app.services.org_subscription_downgrade import DowngradeError, reserve_downgrade

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            # currency가 명시적으로 채워져 있으므로 `or "krw"` fallback이 안 탄다 — 진짜
            # 없는 통화 그대로 조회돼 여전히 거부돼야 한다.
            await _seed_legacy_subscription(session, org_id, tier="business", currency="usd", provider="polar")

            with pytest.raises(DowngradeError, match="활성 offering_version"):
                await reserve_downgrade(session, org_id=org_id, new_tier="starter")
    finally:
        await engine.dispose()
