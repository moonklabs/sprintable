"""story #2777 PR2 — sweep_expired_grants(어드민 credit_grant 자가회수) realdb 검증.
핵심 축: ①정상 되돌림 ②음성대조(그 사이 tier가 바뀐 케이스는 손 안 댐, PO 판정 필수 요구)
③미만료는 무시 ④org별 가장 최근 grant만 후보(오래된 grant 무시). 로컬 PG 미설정 시 skip."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

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


@pytest.fixture(autouse=True)
async def _clear_billing_ledger_entries_before_test():
    """sweep_expired_grants는 전 org의 billing_ledger_entries를 스캔한다(org 스코프 없는
    쿼리) — 같은 공유 create_all DB에서 다른 테스트 파일(test_2777_admin_billing_realdb.py
    등)이 남긴 credit_grant 행이 섞이면 grants_seen/reverted 등 정확 개수 assert가 깨진다.
    매 테스트 시작 전 비운다(org_subscriptions는 그대로 — 이 파일 각 테스트가 자기
    org만 새로 만들어 씀)."""
    from sqlalchemy import text
    engine, maker = await _session_factory()
    async with maker() as s:
        await s.execute(text("DELETE FROM billing_ledger_entries"))
        await s.commit()
    await engine.dispose()
    yield


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


async def _seed_org(session, *, tier: str):
    from app.models.organization import Organization
    from app.models.org_subscription import OrgSubscription

    org = Organization(id=uuid.uuid4(), name="Org2777Sweep", slug=f"org2777sweep-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()
    session.add(OrgSubscription(id=uuid.uuid4(), org_id=org.id, tier=tier, status="active"))
    await session.commit()
    return org.id


async def _seed_grant_entry(session, *, org_id, target_tier, prev_tier, expires_at, created_at):
    from app.models.billing_ledger_entry import BillingLedgerEntry

    session.add(BillingLedgerEntry(
        id=uuid.uuid4(), org_id=org_id, entry_type="credit_grant",
        amount_minor=59000, currency="krw", direction="credit",
        provider="toss", provider_ref=f"idem-{uuid.uuid4()}",
        entry_metadata={
            "kind": "tier_grant", "target_tier": target_tier, "prev_tier": prev_tier,
            "grant_expires_at": expires_at.isoformat(), "months": 1,
            "granted_by": "operator@moonklabs.com", "reason": "test seed",
        },
        ts=created_at,
    ))
    await session.commit()


NOW = datetime(2026, 8, 18, 12, 0, 0, tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_reverts_tier_when_grant_expired_and_tier_unchanged():
    from app.services.billing_scheduler import sweep_expired_grants
    from app.models.org_subscription import OrgSubscription
    from sqlalchemy import select

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="team")
            await _seed_grant_entry(
                s, org_id=org_id, target_tier="team", prev_tier="free",
                expires_at=NOW - timedelta(days=1), created_at=NOW - timedelta(days=31),
            )

        async with maker() as s:
            result = await sweep_expired_grants(s, now=NOW)
            assert result["reverted"] == 1
            assert result["skipped_tier_changed"] == 0

        async with maker() as s:
            sub = (await s.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))).scalar_one()
            assert sub.tier == "free"
            assert sub.status == "active"
            assert sub.current_period_end is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_rerun_after_revert_reports_already_reverted_not_tier_changed():
    """PO AC 리뷰 CHANGES(head 62f44bdd) — 되돌린 grant가 다음 스윕 실행마다 매번
    "tier_changed_since_grant"로 오집계(신호 죽음)되던 것을 skipped_already_reverted로
    분리했는지 재실행으로 직접 확認."""
    from app.services.billing_scheduler import sweep_expired_grants

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="team")
            await _seed_grant_entry(
                s, org_id=org_id, target_tier="team", prev_tier="free",
                expires_at=NOW - timedelta(days=1), created_at=NOW - timedelta(days=31),
            )

        async with maker() as s:
            first = await sweep_expired_grants(s, now=NOW)
            assert first["reverted"] == 1

        # 다음 주기(같은 grant, 아직 새 grant 없음) — 되돌림도 재실측도 아니어야 함.
        async with maker() as s:
            second = await sweep_expired_grants(s, now=NOW + timedelta(days=1))
            assert second["reverted"] == 0
            assert second["skipped_tier_changed"] == 0  # 「변경 감지」로 오분류되면 안 됨
            assert second["skipped_already_reverted"] == 1
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_negative_control_skips_when_tier_changed_since_grant():
    """PO 판정 필수 요구 — 그 사이 실결제 등으로 tier가 바뀐 케이스는 스윕이 손 안 댐을
    직접 assert(과잉살상 방지 가드의 존재 증명)."""
    from app.services.billing_scheduler import sweep_expired_grants
    from app.models.org_subscription import OrgSubscription
    from sqlalchemy import select

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            # grant는 team→free 되돌림용으로 심었지만, 현재 실제 tier는 business(다른 경로로
            # 이미 업그레이드됨) — target_tier(team)와 안 맞으므로 스윕이 손대면 안 된다.
            org_id = await _seed_org(s, tier="business")
            await _seed_grant_entry(
                s, org_id=org_id, target_tier="team", prev_tier="free",
                expires_at=NOW - timedelta(days=1), created_at=NOW - timedelta(days=31),
            )

        async with maker() as s:
            result = await sweep_expired_grants(s, now=NOW)
            assert result["reverted"] == 0
            assert result["skipped_tier_changed"] == 1

        async with maker() as s:
            sub = (await s.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))).scalar_one()
            assert sub.tier == "business"  # 손 안 댐 — 그대로 유지
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_not_yet_expired_grant_is_ignored():
    from app.services.billing_scheduler import sweep_expired_grants

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="team")
            await _seed_grant_entry(
                s, org_id=org_id, target_tier="team", prev_tier="free",
                expires_at=NOW + timedelta(days=10), created_at=NOW - timedelta(days=1),
            )

        async with maker() as s:
            result = await sweep_expired_grants(s, now=NOW)
            assert result["reverted"] == 0
            assert result["skipped_not_expired"] == 1
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_only_most_recent_grant_per_org_considered():
    """오래된(이미 만료+되돌려졌어야 할) grant가 org에 여러 건 있어도 가장 최근 것만
    본다 — 오래된 grant의 target_tier가 현재 tier와 달라도(당연히 다름) 그건 무시 대상이지
    스킵 카운트에 안 잡혀야 한다(최근 것 하나만 후보이므로)."""
    from app.services.billing_scheduler import sweep_expired_grants

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="business")
            # 오래된 grant(2달 전, starter→free) — 이미 무의미.
            await _seed_grant_entry(
                s, org_id=org_id, target_tier="starter", prev_tier="free",
                expires_at=NOW - timedelta(days=40), created_at=NOW - timedelta(days=70),
            )
            # 최신 grant(business→team, 아직 안 만료) — 이게 유일한 후보여야 한다.
            await _seed_grant_entry(
                s, org_id=org_id, target_tier="business", prev_tier="team",
                expires_at=NOW + timedelta(days=5), created_at=NOW - timedelta(days=1),
            )

        async with maker() as s:
            result = await sweep_expired_grants(s, now=NOW)
            assert result["grants_seen"] == 1  # org당 1건만(DISTINCT ON org_id) 후보로 잡힘
            assert result["reverted"] == 0
            assert result["skipped_not_expired"] == 1
    finally:
        await engine.dispose()
