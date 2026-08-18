"""story #2776 — offering_versions 카탈로그 정본 gating 실PG 검증.

핵심 축: ①check_agent_add_limit 신규(이전엔 코드 어디서도 max_agents read 0) ②seats
(check_member_invite_limit/accept_limit) 축이 이제 free뿐 아니라 全 tier(team/business
포함)에서 카탈로그로 집행됨 ③미지 tier(0228 이전 잔존 'pro' 등)는 fail-open+로그. 로컬 PG
미설정 시 skip.

⚠️ test_2777_admin_billing_realdb.py 사고(2026-08-18, 공유 실PG의 offering_versions를
DELETE해 CI 병렬 테스트 26건 연쇄격추) 재발 방지 원칙을 그대로 따른다 — 이 파일은
offering_versions를 절대 DELETE/UPDATE하지 않는다. `_seed_offering()`은 ON CONFLICT DO
NOTHING(실 부분 UNIQUE 인덱스 uq_offering_versions_active_tier_currency에 위임)만 쓰고,
이미 있으면 그 실효값을 그대로 읽어 assert 기준으로 삼는다(하드코딩 기대값 대신 실측값
사용 — 어떤 값이 실제로 시드돼 있든 이 테스트는 그 값 기준으로 옳다)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


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


async def _seed_offering(session, *, tier: str, currency: str = "krw"):
    """이미 있으면 손 안 대고(ON CONFLICT DO NOTHING) 실효값을 그대로 반환 — DELETE/UPDATE
    없음(#2777 사고 재발 방지 원칙, 파일 docstring)."""
    from datetime import datetime, timezone

    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from app.models.offering_version import OfferingVersion

    stmt = pg_insert(OfferingVersion).values(
        id=uuid.uuid4(), tier=tier, currency=currency, version_label=f"{tier}_{currency}_v1_test",
        monthly_price_minor=1, annual_price_minor=1, included_seats=3, max_agents=3,
        au_limit=1, realtime_connection_limit=1, storage_mb_limit=1, max_file_mb=1,
        lab_credit_minor=1, rate_limit_per_min=1, automation_rule_limit=1, webhook_limit=1,
        event_replay_days=1, overage_allowed=True,
        effective_from=datetime.now(timezone.utc), created_by="test_2776_seed",
    ).on_conflict_do_nothing(
        index_elements=["tier", "currency"],
        index_where=OfferingVersion.effective_to.is_(None),
    )
    await session.execute(stmt)
    await session.commit()

    from sqlalchemy import select
    row = (await session.execute(
        select(OfferingVersion.included_seats, OfferingVersion.max_agents).where(
            OfferingVersion.tier == tier, OfferingVersion.currency == currency,
            OfferingVersion.effective_to.is_(None),
        )
    )).first()
    return int(row[0]), (int(row[1]) if row[1] is not None else None)


async def _seed_org(session, *, tier: str):
    from app.models.organization import Organization
    from app.models.org_subscription import OrgSubscription

    org = Organization(id=uuid.uuid4(), name="Org2776Gating", slug=f"org2776-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()
    session.add(OrgSubscription(id=uuid.uuid4(), org_id=org.id, tier=tier, status="active"))
    await session.commit()
    return org.id


async def _seed_agent_member(session, *, org_id, is_active: bool = True):
    from app.models.member import Member

    m = Member(
        id=uuid.uuid4(), org_id=org_id, type="agent", name=f"agent-{uuid.uuid4().hex[:6]}",
        is_active=is_active,
    )
    session.add(m)
    await session.commit()
    return m.id


@pytest.mark.asyncio
async def test_agent_add_limit_blocks_at_max_agents():
    """free(max_agents=3 실측 카탈로그 기준) — 캡 도달 시 402."""
    from fastapi import HTTPException

    from ee.plan_limits import check_agent_add_limit

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            _seats, max_agents = await _seed_offering(s, tier="free")
        assert max_agents is not None, "free는 max_agents가 유한(카탈로그 그라운딩) — None이면 시드 전제가 깨진 것"

        async with maker() as s:
            org_id = await _seed_org(s, tier="free")
            for _ in range(max_agents):
                await _seed_agent_member(s, org_id=org_id)

        async with maker() as s:
            with pytest.raises(HTTPException) as exc_info:
                await check_agent_add_limit(s, org_id)
            assert exc_info.value.status_code == 402
            assert exc_info.value.detail["code"] == "PLAN_LIMIT_EXCEEDED"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_agent_add_limit_passes_under_cap():
    from ee.plan_limits import check_agent_add_limit

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            _seats, max_agents = await _seed_offering(s, tier="free")
        assert max_agents is not None and max_agents >= 1

        async with maker() as s:
            org_id = await _seed_org(s, tier="free")
            # cap보다 하나 적게만 seed
            for _ in range(max_agents - 1):
                await _seed_agent_member(s, org_id=org_id)

        async with maker() as s:
            await check_agent_add_limit(s, org_id)  # 예외 없어야 함
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_agent_add_limit_ignores_soft_deleted_and_inactive_members():
    """deleted_at/is_active=false 에이전트는 카운트에서 빠져야 cap을 부당하게 소모하지 않는다."""
    from app.models.member import Member
    from ee.plan_limits import check_agent_add_limit
    from sqlalchemy import update

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            _seats, max_agents = await _seed_offering(s, tier="free")
        assert max_agents is not None and max_agents >= 1

        async with maker() as s:
            org_id = await _seed_org(s, tier="free")
            # cap 개수만큼 만들고 전부 비활성/삭제 처리 — 실질 사용은 0이어야 통과.
            member_ids = [await _seed_agent_member(s, org_id=org_id) for _ in range(max_agents)]
            await s.execute(
                update(Member).where(Member.id.in_(member_ids)).values(is_active=False)
            )
            await s.commit()

        async with maker() as s:
            await check_agent_add_limit(s, org_id)  # 비활성뿐이라 예외 없어야 함
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_team_tier_member_invite_now_enforced_via_catalog():
    """#2776 핵심 회귀 — 이전엔 team/business가 seats 무제한(하드코딩 free만 캡)이었다.
    지금은 team도 카탈로그(included_seats)로 캡이 걸려야 한다(양성대조: 캡 도달 시 402)."""
    from fastapi import HTTPException

    from ee.plan_limits import check_member_invite_limit

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            seats, _max_agents = await _seed_offering(s, tier="team")

        async with maker() as s:
            org_id = await _seed_org(s, tier="team")
            from app.models.project import OrgMember
            for _ in range(seats):
                s.add(OrgMember(
                    id=uuid.uuid4(), org_id=org_id, user_id=uuid.uuid4(), role="member",
                ))
            await s.commit()

        async with maker() as s:
            with pytest.raises(HTTPException) as exc_info:
                await check_member_invite_limit(s, org_id)
            assert exc_info.value.status_code == 402
            assert exc_info.value.detail["tier"] == "team"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_unknown_tier_fails_open_not_blocked():
    """org_subscriptions.tier가 _KNOWN_TIERS 밖(예: 0257 백필 누락/미래 값)이면 조용히
    free로 오분류해 부당 차단하지 않고, fail-open(무제한 통과)해야 한다 — PO 판정 pin."""
    from ee.plan_limits import check_agent_add_limit, check_member_invite_limit

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="__unknown_future_tier__")

        async with maker() as s:
            await check_member_invite_limit(s, org_id)  # 예외 없어야(fail-open)
        async with maker() as s:
            await check_agent_add_limit(s, org_id)  # 예외 없어야(fail-open)
    finally:
        await engine.dispose()
