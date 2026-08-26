"""story #2474([결제②-A관리1·BE] 운영자 콘솔 백엔드) — offering_version/grandfather_policy
admin CRUD. AC 확定(페드루, 2026-08-21): require_admin_operator 재사용(새 게이트 발명 금지)·
append-only 불변 행이라 값 「수정」 엔드포인트는 없음(CREATE=새 버전, 기존 활성 행은 같은
트랜잭션에서 effective_to로 닫는 원자 스왑)·audit=행 자체(created_by/created_at)로 충분.

핵심 검증축: ①원자 스왑(신규 활성 등록 시 구 행이 실제로 닫히는지) ②동시 CREATE 레이스가
`pg_advisory_xact_lock`으로 직렬화되는지(마지막 커밋만 활성, 히스토리 유실 0 — ⚠️최초
설계는 "닫을 활성 행이 있을 때만" 유효한 UPDATE 행잠금이었는데, 그 스코프의 **첫 버전**을
동시 생성하면 닫을 행 자체가 없어 partial unique index가 UniqueViolationError로 직접
터지는 걸 이 테스트가 실측으로 반증 → advisory lock으로 재설계, app/services/admin_billing.py
참고) ③grandfather_policy가 실재하지 않는 offering_version_id를 거부하는지(404) ④히스토리
목록 정렬 결정성(effective_from desc, PO 보강ⓑ).

⚠️offering_versions는 migration 0228이 krw 4종(free/starter/team/business)을 이미 공유
시드해 뒀다(test_2777_admin_billing_realdb.py 경고 그대로) — 이 파일의 offering_version
테스트는 그 공유 카탈로그를 절대 안 건드리도록 **currency='usd'**(A1 스코프 밖, 실제로
비어있음이 이미 확認된 축)만 쓴다."""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone

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


async def _wipe_usd_catalog() -> None:
    """test_2777_admin_billing_realdb.py의 `test_grant_credit_fails_loud_when_no_pricing_source`
    가 「currency='usd'는 어느 tier든 원천이 없다」를 전제로 삼는다(migration 0228이 krw만
    시드) — 이 파일이 그 전제를 깨는 usd 행을 만들었다가 방치하면(공유 CI DB, 다른 테스트
    파일과 같은 세션에서 실행될 수 있음) 그 파일이 조용히 깨진다. 정확히 test_2777의
    _seed_offering docstring이 경고하는 "공유 카탈로그 오염"과 같은 사고 클래스 — usd
    카탈로그는 이 파일 전용 스코프이므로 매 테스트 앞뒤로 완전히 비운다(FK: grandfather
    먼저)."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy import text
    engine = create_async_engine(_async_url())
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "DELETE FROM grandfather_policies WHERE offering_version_id IN "
                "(SELECT id FROM offering_versions WHERE currency = 'usd')"
            ))
            await conn.execute(text("DELETE FROM offering_versions WHERE currency = 'usd'"))
    finally:
        await engine.dispose()


@pytest.fixture(autouse=True)
async def _isolate_usd_catalog():
    await _wipe_usd_catalog()
    yield
    await _wipe_usd_catalog()


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


def _offering_fields(**overrides: object) -> dict:
    base = dict(
        tier="starter", currency="usd", version_label=f"usd_test_{uuid.uuid4().hex[:8]}",
        monthly_price_minor=1900, annual_price_minor=19000, included_seats=5,
        extra_seat_price_minor=None, max_agents=None, au_limit=1000,
        realtime_connection_limit=10, storage_mb_limit=1024, max_file_mb=100,
        lab_credit_minor=0, rate_limit_per_min=60, automation_rule_limit=10,
        webhook_limit=5, event_replay_days=7, overage_allowed=True, pack_catalog=None,
    )
    base.update(overrides)
    return base


async def _seed_org(session) -> uuid.UUID:
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name="Org2474", slug=f"org2474-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()
    await session.commit()
    return org.id


@pytest.mark.asyncio
async def test_create_offering_version_atomically_closes_previous_active():
    from app.services.admin_billing import create_offering_version
    from app.models.offering_version import OfferingVersion
    from sqlalchemy import select

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            v1 = await create_offering_version(
                s, actor_email="op@moonklabs.com", **_offering_fields(tier="starter", currency="usd"),
            )
            v1_id = v1.id
            await s.commit()  # get_db() 래퍼가 요청 끝에 하는 커밋을 직접호출 테스트에서 재현

        async with maker() as s:
            v2 = await create_offering_version(
                s, actor_email="op@moonklabs.com", **_offering_fields(tier="starter", currency="usd"),
            )
            v2_id = v2.id
            await s.commit()

        async with maker() as s:
            rows = (await s.execute(
                select(OfferingVersion).where(
                    OfferingVersion.tier == "starter", OfferingVersion.currency == "usd",
                    OfferingVersion.id.in_([v1_id, v2_id]),
                )
            )).scalars().all()
            by_id = {r.id: r for r in rows}
            assert by_id[v1_id].effective_to is not None, "구 버전이 새 버전 생성 후에도 여전히 활성 — 원자 스왑 실패"
            assert by_id[v2_id].effective_to is None

            active_count = (await s.execute(
                select(OfferingVersion).where(
                    OfferingVersion.tier == "starter", OfferingVersion.currency == "usd",
                    OfferingVersion.effective_to.is_(None),
                )
            )).scalars().all()
            assert len(active_count) == 1 and active_count[0].id == v2_id
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_offering_version_created_by_is_operator_email():
    from app.services.admin_billing import create_offering_version

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            v = await create_offering_version(
                s, actor_email="operator@moonklabs.com",
                **_offering_fields(tier="team", currency="usd"),
            )
            assert v.created_by == "operator@moonklabs.com"
            assert v.effective_to is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_concurrent_offering_version_create_serializes_via_row_lock_no_history_loss():
    """동시 두 CREATE(같은 tier+currency)가 partial unique index 위반 없이 둘 다
    성공하고, 마지막 커밋만 활성으로 남으며, 히스토리(둘 다) 유실이 없는지 — 진짜
    asyncio.gather 동시성으로 확인(#2874와 동형 정신, 다만 CAS가 아니라 직렬화 검증)."""
    from app.services.admin_billing import create_offering_version
    from app.models.offering_version import OfferingVersion
    from sqlalchemy import select

    engine, maker = await _session_factory()
    try:
        currency = "usd"
        tier = "business"

        async def _create(label: str):
            async with maker() as s:
                v = await create_offering_version(
                    s, actor_email="op@moonklabs.com",
                    **_offering_fields(tier=tier, currency=currency, version_label=label),
                )
                await s.commit()
                return v.id

        ids = await asyncio.gather(_create("race-a"), _create("race-b"))

        async with maker() as s:
            all_rows = (await s.execute(
                select(OfferingVersion).where(
                    OfferingVersion.tier == tier, OfferingVersion.currency == currency,
                    OfferingVersion.id.in_(ids),
                )
            )).scalars().all()
            assert len(all_rows) == 2, "동시 CREATE 중 하나가 유실됨(히스토리 손실)"

            active_rows = [r for r in all_rows if r.effective_to is None]
            assert len(active_rows) == 1, (
                f"동시 CREATE 후 활성 행이 {len(active_rows)}개 — partial unique index가 "
                f"실제로 위반됐거나(있으면 안 됨) 직렬화가 깨짐"
            )
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_create_grandfather_policy_rejects_nonexistent_offering_version_with_404():
    from app.services.admin_billing import AdminBillingError, create_grandfather_policy

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s)

        async with maker() as s:
            with pytest.raises(AdminBillingError) as exc_info:
                await create_grandfather_policy(
                    s, actor_email="op@moonklabs.com", org_id=org_id,
                    offering_version_id=uuid.uuid4(), auto_migrate_on_new_version=False,
                    grace_period_days=None, reason="테스트 — 미존재 offering_version",
                )
            assert exc_info.value.status_code == 404
            assert exc_info.value.code == "OFFERING_VERSION_NOT_FOUND"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_create_grandfather_policy_atomically_closes_previous_active_for_org():
    from app.services.admin_billing import create_offering_version, create_grandfather_policy
    from app.models.grandfather_policy import GrandfatherPolicy
    from sqlalchemy import select

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s)
            offering = await create_offering_version(
                s, actor_email="op@moonklabs.com", **_offering_fields(tier="team", currency="usd"),
            )
            offering_id = offering.id
            await s.commit()

        async with maker() as s:
            p1 = await create_grandfather_policy(
                s, actor_email="op@moonklabs.com", org_id=org_id, offering_version_id=offering_id,
                auto_migrate_on_new_version=False, grace_period_days=None, reason="최초 정책",
            )
            p1_id = p1.id
            await s.commit()

        async with maker() as s:
            p2 = await create_grandfather_policy(
                s, actor_email="op@moonklabs.com", org_id=org_id, offering_version_id=offering_id,
                auto_migrate_on_new_version=True, grace_period_days=30, reason="정책 갱신",
            )
            p2_id = p2.id
            await s.commit()

        async with maker() as s:
            rows = (await s.execute(
                select(GrandfatherPolicy).where(GrandfatherPolicy.id.in_([p1_id, p2_id]))
            )).scalars().all()
            by_id = {r.id: r for r in rows}
            assert by_id[p1_id].effective_to is not None
            assert by_id[p2_id].effective_to is None

            active = (await s.execute(
                select(GrandfatherPolicy).where(
                    GrandfatherPolicy.org_id == org_id, GrandfatherPolicy.effective_to.is_(None),
                )
            )).scalars().all()
            assert len(active) == 1 and active[0].id == p2_id
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_list_offering_versions_ordered_by_effective_from_desc():
    """PO 보강ⓑ — 히스토리 목록 정렬 결정성(#2864 학습). service 레이어가 아니라 실제
    라우터 쿼리(GET)와 동일한 order_by를 직접 재현해 값으로 검증(라우터는 FastAPI
    TestClient 없이 이 세션 검증으로 충분 — order_by 자체가 회귀 축)."""
    from app.services.admin_billing import create_offering_version
    from app.models.offering_version import OfferingVersion
    from sqlalchemy import select

    engine, maker = await _session_factory()
    try:
        tier, currency = "free", "usd"
        ids_in_creation_order = []
        for i in range(3):
            async with maker() as s:
                v = await create_offering_version(
                    s, actor_email="op@moonklabs.com",
                    **_offering_fields(tier=tier, currency=currency, version_label=f"seq-{i}"),
                )
                ids_in_creation_order.append(v.id)
                await s.commit()

        async with maker() as s:
            q = select(OfferingVersion).where(
                OfferingVersion.tier == tier, OfferingVersion.currency == currency,
            ).order_by(OfferingVersion.effective_from.desc(), OfferingVersion.id.desc())
            rows = (await s.execute(q)).scalars().all()
            returned_ids = [r.id for r in rows if r.id in ids_in_creation_order]
            assert returned_ids == list(reversed(ids_in_creation_order)), (
                "effective_from desc 정렬이 생성 역순과 다름 — 히스토리 목록이 비결정적일 위험"
            )
    finally:
        await engine.dispose()
