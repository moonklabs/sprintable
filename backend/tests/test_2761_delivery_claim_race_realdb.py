"""story #2761(P1·prod 실사용 제보) realdb 검증 — 원자적 claim이 재집기 창을 실제로 닫는지.

prod 실사고: `_claim_batch()`가 attempts만 올리고 status는 'pending' 그대로 둬(FOR UPDATE SKIP
LOCKED는 그 트랜잭션이 열려 있는 "그 순간"만 막음), 배달(외부 I/O)이 poll 주기를 넘으면 다음
poll 사이클(또는 동시에 도는 다른 인스턴스)이 같은 pending row를 재집었다 — minScale=3에서
"정확히 3번" 중복 발송으로 드러났다(미르코 그라운딩).

이 파일의 핵심 대조:
  ①`_buggy_claim_like_old_code()` — fix 前 패턴(SELECT FOR UPDATE SKIP LOCKED + attempts만
    증가, status 불변)을 그대로 재현 → 느린 배달(poll 주기 초과)을 흉내낸 "다음 poll 사이클"
    호출에서 같은 row가 다시 잡힘을 실증(중복 재현).
  ②실제 `_claim_batch()` — 같은 시나리오에서 두 번째 호출이 빈 리스트를 반환(재집기 0건)을
    실증(fix 후 정확 1회).
  ③진짜 동시성(두 세션이 같은 순간에 FOR UPDATE SKIP LOCKED) — 겹침 0, 커버리지 100%.

⛔공유 dev 백엔드 접속 없음 — 로컬 Postgres(``PARITY_TEST_DATABASE_URL``)만 사용. 미설정 시
skip. engine/session은 fixture가 아니라 테스트 본문에서 직접 생성(story #2459 realdb 관례 —
async-generator fixture는 pytest-asyncio/anyio loop 불일치로 asyncpg가 죽는다).
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="realdb 테스트는 로컬 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _clean_delivery_jobs(engine) -> None:
    from app.models.delivery_job import DeliveryJob

    async with engine.begin() as conn:
        await conn.execute(DeliveryJob.__table__.delete())


async def _buggy_claim_like_old_code(engine, org_id: uuid.UUID, limit: int = 20) -> list[uuid.UUID]:
    """fix 前 `_claim_batch()`의 정확한 재현 — SELECT ... FOR UPDATE SKIP LOCKED로 후보를
    골라 attempts만 올리고 커밋한다. status는 절대 안 건드린다(그게 버그였다) — 그래서
    커밋 순간 락이 풀리고, row는 여전히 'pending'이라 다음 호출이 또 집는다."""
    from app.models.delivery_job import DeliveryJob

    async with AsyncSession(engine) as session:
        candidate_ids = (
            select(DeliveryJob.id)
            .where(DeliveryJob.status == "pending", DeliveryJob.org_id == org_id)
            .order_by(DeliveryJob.created_at.asc())
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        rows = (await session.execute(
            update(DeliveryJob)
            .where(DeliveryJob.id.in_(candidate_ids))
            .values(attempts=DeliveryJob.attempts + 1)  # ⛔status 전이 없음 — 재현하려는 결함 그 자체.
            .returning(DeliveryJob.id)
        )).scalars().all()
        await session.commit()
        return list(rows)


# ─── ①fix 前 패턴: 느린 배달(poll 주기 초과) → 다음 poll 사이클이 재집음(중복 재현) ──────

@pytest.mark.anyio
async def test_pre_fix_claim_pattern_reclaims_same_pending_rows_before_delivery_finishes():
    """느린 배달 모킹 = 배달(외부 I/O)이 끝나기 전에 "다음 poll 사이클"이 도는 상황을 두 번의
    순차 호출로 흉내낸다(각 호출은 짧은 트랜잭션 — commit 즉시 락 해제, 실제 poll 루프와 동형).
    old 패턴은 status를 안 바꾸므로 두 번째 호출도 같은 row를 또 집는다 — prod 3중복의 근본원인
    그 자체를 이 회귀 가드가 직접 재현한다."""
    from app.models.delivery_job import DeliveryJob

    engine = create_async_engine(_async_url())
    try:
        await _clean_delivery_jobs(engine)
        org_id = uuid.uuid4()
        async with AsyncSession(engine) as session:
            for i in range(3):
                session.add(DeliveryJob(org_id=org_id, kind="org_webhook", payload={"seq": i}))
            await session.commit()

        first_poll = await _buggy_claim_like_old_code(engine, org_id)
        assert len(first_poll) == 3

        # "배달이 poll 주기를 넘는다" = 아직 delivered/failed로 전이 안 된 채 다음 poll이 돎.
        second_poll = await _buggy_claim_like_old_code(engine, org_id)
        assert set(second_poll) == set(first_poll)  # ⛔중복 재현: 정확히 같은 3건이 또 잡힘.
    finally:
        await engine.dispose()


# ─── ②fix 後: 같은 시나리오에서 재집기 0건(정확히 1회) ──────────────────────────────

@pytest.mark.anyio
async def test_claim_batch_prevents_reclaim_before_delivery_finishes(monkeypatch):
    """①과 완전히 같은 시나리오(느린 배달 = 두 번째 poll이 첫 poll의 배달 완료 前 도착)를
    실제 `_claim_batch()`로 재생 — status가 'pending'→'claimed'로 같은 원자적 UPDATE 안에서
    전이되므로 두 번째 호출은 빈 리스트를 반환해야 한다(fix 후 정확 1회의 핵심 증거)."""
    from app.models.delivery_job import DeliveryJob
    from app.services.delivery_dispatcher import _claim_batch

    engine = create_async_engine(_async_url())
    try:
        await _clean_delivery_jobs(engine)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr("app.core.database.async_session_factory", factory)

        org_id = uuid.uuid4()
        async with AsyncSession(engine) as session:
            for i in range(3):
                session.add(DeliveryJob(org_id=org_id, kind="org_webhook", payload={"seq": i}))
            await session.commit()

        first_poll = await _claim_batch(limit=10)
        mine_first = [j for j in first_poll if j["org_id"] == org_id]
        assert len(mine_first) == 3
        assert {j["attempts"] for j in mine_first} == {1}

        # 배달이 아직 안 끝난 상태(delivered/failed 전이 없음)에서 다음 poll 사이클 도착.
        second_poll = await _claim_batch(limit=10)
        mine_second = [j for j in second_poll if j["org_id"] == org_id]
        assert mine_second == []  # ⛔재집기 0건 — status='claimed'라 pending SELECT에 안 잡힘.

        async with AsyncSession(engine) as verify:
            rows = (await verify.execute(
                select(DeliveryJob).where(DeliveryJob.org_id == org_id)
            )).scalars().all()
        assert {r.status for r in rows} == {"claimed"}
        assert {r.attempts for r in rows} == {1}  # 재집기가 없었으니 attempts도 안 더 올라감.
        assert all(r.claimed_at is not None for r in rows)
    finally:
        await engine.dispose()


# ─── ③진짜 동시성: 두 세션이 같은 순간에 claim — 겹침 0, 유실 0 ──────────────────────

@pytest.mark.anyio
async def test_concurrent_claim_batches_no_overlap_no_loss(monkeypatch):
    """두 워커 인스턴스가 정말 동시에(FOR UPDATE SKIP LOCKED가 겹치는 순간) 폴링해도 같은
    job을 안 집는다 — story #2761 AC "동시 워커 2+" 요건의 직접 증거."""
    import asyncio

    from app.models.delivery_job import DeliveryJob
    from app.services.delivery_dispatcher import _claim_batch

    engine = create_async_engine(_async_url())
    try:
        await _clean_delivery_jobs(engine)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr("app.core.database.async_session_factory", factory)

        org_id = uuid.uuid4()
        async with AsyncSession(engine, expire_on_commit=False) as session:
            job_objs = [
                DeliveryJob(org_id=org_id, kind="org_webhook", payload={"seq": i}) for i in range(10)
            ]
            for j in job_objs:
                session.add(j)
            await session.commit()
            all_ids = {j.id for j in job_objs}

        results = await asyncio.gather(
            _claim_batch(limit=5), _claim_batch(limit=5), _claim_batch(limit=5),
        )
        claimed_ids_per_worker = [
            {j["id"] for j in r if j["org_id"] == org_id} for r in results
        ]
        union_ids = set().union(*claimed_ids_per_worker)

        for i in range(len(claimed_ids_per_worker)):
            for j in range(i + 1, len(claimed_ids_per_worker)):
                assert claimed_ids_per_worker[i] & claimed_ids_per_worker[j] == set()  # 겹침 0.
        assert union_ids == all_ids  # 유실 0 — 10건 전부 누군가 정확히 한 번씩 집음.
    finally:
        await engine.dispose()


# ─── ④크래시 복구: claimed_at 타임아웃 → reaper가 pending으로 되돌림(at-least-once 보존) ───

@pytest.mark.anyio
async def test_reap_expired_claims_returns_stale_claimed_jobs_to_pending(monkeypatch):
    from datetime import datetime, timedelta, timezone

    from app.models.delivery_job import DeliveryJob
    from app.services.delivery_dispatcher import _reap_expired_claims

    engine = create_async_engine(_async_url())
    try:
        await _clean_delivery_jobs(engine)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr("app.core.database.async_session_factory", factory)

        org_id = uuid.uuid4()
        stale_cutoff = datetime.now(timezone.utc) - timedelta(seconds=999)
        fresh_claimed_at = datetime.now(timezone.utc)
        async with AsyncSession(engine, expire_on_commit=False) as session:
            stale = DeliveryJob(
                org_id=org_id, kind="org_webhook", payload={"x": "stale"},
                status="claimed", claimed_at=stale_cutoff, attempts=1,
            )
            fresh = DeliveryJob(
                org_id=org_id, kind="org_webhook", payload={"x": "fresh"},
                status="claimed", claimed_at=fresh_claimed_at, attempts=1,
            )
            session.add_all([stale, fresh])
            await session.commit()
            stale_id, fresh_id = stale.id, fresh.id

        reaped = await _reap_expired_claims()
        assert reaped >= 1

        async with AsyncSession(engine) as verify:
            stale_row = (await verify.execute(
                select(DeliveryJob).where(DeliveryJob.id == stale_id)
            )).scalar_one()
            fresh_row = (await verify.execute(
                select(DeliveryJob).where(DeliveryJob.id == fresh_id)
            )).scalar_one()
        assert stale_row.status == "pending"  # 만료된 claim은 회수됨.
        assert stale_row.claimed_at is None
        assert fresh_row.status == "claimed"  # 방금 claim된 건 그대로(오탐 회수 없음).
    finally:
        await engine.dispose()
