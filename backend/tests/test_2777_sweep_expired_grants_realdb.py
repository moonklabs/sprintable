"""story #2777 PR2 — sweep_expired_grants(어드민 credit_grant 자가회수) realdb 검증.
핵심 축: ①정상 되돌림 ②음성대조(그 사이 tier가 바뀐 케이스는 손 안 댐, PO 판정 필수 요구)
③미만료는 무시 ④org별 가장 최근 grant만 후보(오래된 grant 무시). 로컬 PG 미설정 시 skip.

⚠️ 이 파일은 (test_2777_admin_billing_realdb.py를 실사고로 낸 뒤 교훈) 더 이상 어떤
공유 테이블도 DELETE하지 않는다 — `sweep_expired_grants`는 org 스코프 없이 전체
`billing_ledger_entries`를 스캔하므로(프로덕션에서 옳은 설계), 같은 세션에서 먼저 도는
다른 테스트가 남긴 credit_grant 행이 `grants_seen`/`reverted` 등 **집계** 카운트에 함께
잡힐 수 있다. 그래서 집계값 단정은 `>=`로만 하고, 실제 판정은 **이 테스트가 만든 그
org의 subscription 상태를 직접 재조회**하는 것으로 한다(다른 org의 존재/부재와 무관하게
항상 옳다)."""
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
            assert result["reverted"] >= 1  # 다른 세션-공존 org가 있을 수 있어 하한만(§파일 docstring)

        async with maker() as s:
            sub = (await s.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))).scalar_one()
            assert sub.tier == "free"
            assert sub.status == "active"
            assert sub.current_period_end is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_rerun_after_revert_excludes_grant_via_companion_marker():
    """카디르군 QA fix(2026-08-18, PR2 head c47db6dd5) — 값-비교 휴리스틱(current_tier==
    prev_tier)을 폐기하고 companion 원장 마커(entry_type='adjustment'·metadata.kind=
    'tier_grant_revert'·reverted_entry_id)로 바꾼 뒤: 되돌린 grant는 재조회 SQL의 NOT
    EXISTS가 후보에서 원천 제외한다는 것을 직접 확認 — companion이 정확히 1건만 존재하고
    (재실행해도 중복 생성 안 됨, provider_ref 결정적 유도로 멱등), 재실행이 tier를 다시
    건드리지 않는다."""
    from app.services.billing_scheduler import sweep_expired_grants
    from app.models.org_subscription import OrgSubscription
    from app.models.billing_ledger_entry import BillingLedgerEntry
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
            first = await sweep_expired_grants(s, now=NOW)
            assert first["reverted"] >= 1

        async with maker() as s:
            sub = (await s.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))).scalar_one()
            assert sub.tier == "free"  # 첫 스윕에서 되돌려짐

        # 다음 주기(같은 grant, 아직 새 grant 없음) — companion 마커로 후보에서 원천 제외되니
        # reverted/skipped_* 어느 쪽으로도 재집계되지 않아야 한다(이제 이 org는 latest_grants
        # 쿼리 결과에 아예 안 잡힌다 — 값 비교가 아니라 마커 존재로 판정하므로).
        async with maker() as s:
            await sweep_expired_grants(s, now=NOW + timedelta(days=1))
        async with maker() as s:
            sub = (await s.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))).scalar_one()
            assert sub.tier == "free"  # 재반복 실행에도 불변(이중 되돌림/오염 없음)

        async with maker() as s:
            companions = (await s.execute(
                select(BillingLedgerEntry).where(
                    BillingLedgerEntry.org_id == org_id,
                    BillingLedgerEntry.entry_type == "adjustment",
                )
            )).scalars().all()
            assert len(companions) == 1, "companion이 재실행마다 중복 생성되면 원장 오염 — 정확히 1건"
            assert companions[0].entry_metadata["kind"] == "tier_grant_revert"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_same_tier_regrant_reverted_exactly_once_not_every_sweep():
    """카디르군 QA 실PG 재현(2026-08-18) — 이미 team인 org에 team 사용권을 재부여(정상 CS
    유스케이스)하면 target_tier == prev_tier == 'team'이 된다. 구 버전은 되돌리기 전부터
    이미 current_tier==prev_tier가 참이라 "이미 되돌려짐" 휴리스틱이 원천 무력화돼, 스윕을
    3연속 돌리면 매번 reverted+1·current_period_*를 계속 None으로 재설정했다(카디르군
    fresh PG 재현). 이 테스트는 그 정확한 시나리오를 3연속 스윕으로 재현해 정확히 1회만
    되돌려지는지 pin한다."""
    from app.services.billing_scheduler import sweep_expired_grants
    from app.models.org_subscription import OrgSubscription
    from app.models.billing_ledger_entry import BillingLedgerEntry
    from sqlalchemy import select, update

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="team")
            # 동일 tier 재부여 — target_tier == prev_tier == "team"(핵심 시나리오).
            await _seed_grant_entry(
                s, org_id=org_id, target_tier="team", prev_tier="team",
                expires_at=NOW - timedelta(days=1), created_at=NOW - timedelta(days=31),
            )

        # 1회차 — 실제로 되돌려져야 한다(period가 None화).
        async with maker() as s:
            await sweep_expired_grants(s, now=NOW)
        async with maker() as s:
            sub = (await s.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))).scalar_one()
            assert sub.tier == "team"  # 동일 tier라 값 자체는 관찰 불가 축(의도된 시나리오)
            assert sub.current_period_end is None  # 1회차 되돌림으로 null화

        # None은 "재발동 없음"과 "재발동으로 다시 null화"를 구분 못 하는 위장 신호라, 매
        # 라운드 사이 **감시용 sentinel 값**을 직접 심어 둔다 — fix가 옳다면(companion
        # 마커로 후보 제외) 2·3회차 스윕이 이 org를 아예 안 건드려 sentinel이 그대로 남고,
        # 구 휴리스틱 버그가 재현되면 스윕이 다시 None으로 덮어써 sentinel이 사라진다.
        sentinel = NOW.replace(year=2030)
        for i in range(1, 3):
            async with maker() as s:
                await s.execute(
                    update(OrgSubscription)
                    .where(OrgSubscription.org_id == org_id)
                    .values(current_period_end=sentinel)
                )
                await s.commit()

            async with maker() as s:
                await sweep_expired_grants(s, now=NOW + timedelta(days=i))

            async with maker() as s:
                sub = (await s.execute(
                    select(OrgSubscription).where(OrgSubscription.org_id == org_id)
                )).scalar_one()
                assert sub.current_period_end == sentinel, (
                    f"라운드 {i+1}: 이미 되돌려진 grant가 재발동돼 sentinel을 덮어씀 — "
                    f"동일 tier 재부여 무한 재되돌림 버그 재현(companion 마커 필터 실패)"
                )

        async with maker() as s:
            companions = (await s.execute(
                select(BillingLedgerEntry).where(
                    BillingLedgerEntry.org_id == org_id,
                    BillingLedgerEntry.entry_type == "adjustment",
                    BillingLedgerEntry.entry_metadata["kind"].astext == "tier_grant_revert",
                )
            )).scalars().all()
            assert len(companions) == 1, (
                f"동일 tier 재부여가 매 스윕마다 재되돌려지면 companion이 반복 생성된다 — "
                f"3연속 스윕 후 companion={len(companions)}건(1건이어야 fix 성공)"
            )
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
            assert result["skipped_tier_changed"] >= 1  # 분류 동작 확認(하한)

        async with maker() as s:
            sub = (await s.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))).scalar_one()
            assert sub.tier == "business"  # 손 안 댐 — 그대로 유지(핵심 판정)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_not_yet_expired_grant_is_ignored():
    from app.services.billing_scheduler import sweep_expired_grants
    from app.models.org_subscription import OrgSubscription
    from sqlalchemy import select

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
            assert result["skipped_not_expired"] >= 1  # 분류 동작 확認(하한)

        async with maker() as s:
            sub = (await s.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))).scalar_one()
            assert sub.tier == "team"  # 손 안 댐 — 핵심 판정
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_only_most_recent_grant_per_org_considered():
    """오래된(이미 만료+되돌려졌어야 할) grant가 org에 여러 건 있어도 가장 최근 것만
    본다 — 오래된 grant(target_tier='starter')는 지금 tier(business)와 안 맞아 매칭됐다면
    그 자체가 skipped_tier_changed감이지만, DISTINCT ON org_id가 최신 것(target_tier=
    'business', 아직 안 만료)만 후보로 잡으므로 실제로는 skipped_not_expired여야 하고,
    무엇보다 **tier가 그대로 business로 유지**돼야 한다(오래된 grant 기준으로 잘못
    되돌려지면 안 됨 — 이게 이 테스트의 핵심 판정)."""
    from app.services.billing_scheduler import sweep_expired_grants
    from app.models.org_subscription import OrgSubscription
    from sqlalchemy import select

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
            await sweep_expired_grants(s, now=NOW)

        async with maker() as s:
            sub = (await s.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))).scalar_one()
            assert sub.tier == "business"  # 오래된 grant 기준으로 되돌려지지 않음(핵심 판정)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_stacked_grants_superseded_grant_never_becomes_candidate_after_latest_reverted():
    """카디르군 QA 3차(2026-08-18, PR2 head 03a42af35 재현) — companion 필터가 DISTINCT ON
    보다 먼저 걸리면(1차 시도), 순차 grant(A: free→team 만료·B: team→business 만료, B가
    A보다 최신)에서 스윕1이 B를 정확히 회수한 뒤 스윕2가 B를 후보에서 빼자 **DISTINCT ON이
    남은 A를 "org의 최신 grant"로 오판**해 tier가 free로 붕괴했다(A.target_tier==team이
    스윕1 이후 현재 tier와 우연히 일치해 tier 가드도 못 막음).

    이 테스트는 그 정확한 스택 시나리오를 재현한다 — 음성대조: 스윕1=B만 회수, 스윕2=완전
    no-op(A는 「최신이 아니므로 회수 여부와 무관하게 영원히 후보가 아니다」라는 불변식이
    실제로 지켜지는지 pin)."""
    from app.services.billing_scheduler import sweep_expired_grants
    from app.models.org_subscription import OrgSubscription
    from sqlalchemy import select

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="business")
            # A(구) — 먼저 생성·먼저 만료. superseded 대상.
            await _seed_grant_entry(
                s, org_id=org_id, target_tier="team", prev_tier="free",
                expires_at=NOW - timedelta(days=20), created_at=NOW - timedelta(days=60),
            )
            # B(신) — A보다 나중에 생성·A보다 나중에(하지만 NOW 기준으론 이미) 만료.
            # 「절대 최신」은 항상 B — companion 유무와 무관하게 ts만으로 결정돼야 한다.
            await _seed_grant_entry(
                s, org_id=org_id, target_tier="business", prev_tier="team",
                expires_at=NOW - timedelta(days=1), created_at=NOW - timedelta(days=30),
            )

        # 스윕1 — 절대 최신인 B가 되돌려져야 한다(business→team).
        async with maker() as s:
            result1 = await sweep_expired_grants(s, now=NOW)
            assert result1["reverted"] >= 1
        async with maker() as s:
            sub = (await s.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))).scalar_one()
            assert sub.tier == "team"  # B가 되돌려짐(business→team) — A는 아직 손 안 됨

        # 스윕2 — B에 companion이 붙어 후보에서 빠져도, A가 "새 최신"으로 승격돼선 안
        # 된다(핵심 판정 — 버그 재현시 tier가 free로 붕괴).
        async with maker() as s:
            await sweep_expired_grants(s, now=NOW + timedelta(days=1))
        async with maker() as s:
            sub = (await s.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))).scalar_one()
            assert sub.tier == "team", (
                f"A(superseded)가 스윕2에서 되돌려져 tier가 {sub.tier!r}로 붕괴 — "
                f"«최신 아닌 grant는 영원히 후보 아님» 불변식 위반(카디르군 3차 QA 재현)"
            )
    finally:
        await engine.dispose()
