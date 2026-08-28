"""story #2460(§6 봉합②) realdb 검증 — mock으로는 못 잡는 트랜잭션/락 시맨틱스.

PO 확定 축(2026-08-05): 「중복·유실·순서·재시도」. 실 Postgres 없이는 다음이 검증 불가능:
  ①원자성 — enqueue insert가 caller 트랜잭션 rollback과 함께 진짜 사라지는가(mock session은
    rollback을 흉내만 낼 뿐 실제 미반영을 증명 못 한다).
  ②FOR UPDATE SKIP LOCKED — 두 동시 claim이 정말 겹치지 않는가(mock으로는 SQL 자체의 락
    시맨틱스를 못 잰다).
  ③생성 순서(created_at ASC) — SELECT 정렬이 실제로 그 순서를 내는가.
⛔공유 dev 백엔드 접속 없음 — 로컬 Postgres(``PARITY_TEST_DATABASE_URL``)만 사용. 미설정 시
skip(CI에 로컬 PG가 없으면 이 파일 전체가 조용히 스킵 — non-realdb 스위트와 동일 관례).

⚠️engine/session은 fixture가 아니라 매 테스트 함수 본문 안에서 직접 만든다(story #2459
realdb 테스트 관례 그대로 재사용) — async-generator fixture로 만들면 pytest-asyncio/anyio의
loop 관리가 갈려 asyncpg가 "attached to a different loop"로 죽는 것을 이 세션에서 직접
재현했다(engine이 한 fixture의 loop에서 만들어지고 테스트 본문은 다른 loop에서 돎).
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import select
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


# ─── ①원자성: caller 트랜잭션 rollback = outbox row도 사라짐 ────────────────

@pytest.mark.anyio
async def test_enqueue_rolls_back_with_caller_transaction():
    from app.models.delivery_job import DeliveryJob
    from app.services.webhook_dispatch import fire_webhooks

    engine = create_async_engine(_async_url())
    try:
        await _clean_delivery_jobs(engine)
        org_id = uuid.uuid4()
        async with AsyncSession(engine) as session:
            await fire_webhooks(session, org_id, "story.status_changed", {"x": 1}, via_outbox=True)
            # commit 없이 rollback — get_db()의 except 분기(session.rollback())와 동형.
            await session.rollback()

        async with AsyncSession(engine) as verify:
            rows = (await verify.execute(
                select(DeliveryJob).where(DeliveryJob.org_id == org_id)
            )).scalars().all()
        assert rows == []  # rollback 됐으면 진짜로 안 남아야 한다 — "원자적"의 핵심 증거.
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_enqueue_persists_with_caller_commit():
    from app.models.delivery_job import DeliveryJob
    from app.services.webhook_dispatch import fire_webhooks

    engine = create_async_engine(_async_url())
    try:
        await _clean_delivery_jobs(engine)
        org_id = uuid.uuid4()
        async with AsyncSession(engine) as session:
            await fire_webhooks(session, org_id, "story.status_changed", {"x": 1}, via_outbox=True)
            await session.commit()

        async with AsyncSession(engine) as verify:
            rows = (await verify.execute(
                select(DeliveryJob).where(DeliveryJob.org_id == org_id)
            )).scalars().all()
        assert len(rows) == 1
        assert rows[0].status == "pending"
        assert rows[0].kind == "org_webhook"
    finally:
        await engine.dispose()


# ─── ②FOR UPDATE SKIP LOCKED: 동시 claim이 겹치지 않음(중복배달 최소화) ─────

@pytest.mark.anyio
async def test_concurrent_claims_do_not_overlap():
    """두 워커 인스턴스가 동시에 폴링해도(락이 열려 있는 동안은) 같은 job을 안 집는다 —
    at-least-once의 "least"가 실제로 SKIP LOCKED로 담보되는지의 핵심 증거."""
    from app.models.delivery_job import DeliveryJob

    engine = create_async_engine(_async_url())
    try:
        await _clean_delivery_jobs(engine)
        org_id = uuid.uuid4()
        # expire_on_commit=False: commit 後 job_objs 속성 접근이 지금 여기서 딱 재현한
        # #2459류 MissingGreenlet(동기 컨텍스트 lazy-load)에 걸리지 않게.
        async with AsyncSession(engine, expire_on_commit=False) as session:
            job_objs = [
                DeliveryJob(org_id=org_id, kind="org_webhook", payload={"event": "x", "data": {}})
                for _ in range(10)
            ]
            for j in job_objs:
                session.add(j)
            await session.commit()
            all_ids = {j.id for j in job_objs}

        session_a = AsyncSession(engine)
        session_b = AsyncSession(engine)
        try:
            rows_a = (await session_a.execute(
                select(DeliveryJob.id).where(DeliveryJob.status == "pending")
                .order_by(DeliveryJob.created_at.asc()).limit(5).with_for_update(skip_locked=True)
            )).scalars().all()
            rows_b = (await session_b.execute(
                select(DeliveryJob.id).where(DeliveryJob.status == "pending")
                .order_by(DeliveryJob.created_at.asc()).limit(5).with_for_update(skip_locked=True)
            )).scalars().all()
            ids_a, ids_b = set(rows_a), set(rows_b)

            assert ids_a & ids_b == set()  # 핵심 단정: 겹치는 job이 하나도 없어야 한다.
            assert len(ids_a) == 5 and len(ids_b) == 5  # 10개를 5+5로 정확히 나눠 가짐(유실 0).
            assert ids_a | ids_b == all_ids  # 합쳐서 전체를 커버(스킵으로 인한 누락도 0).
            await session_a.commit()
            await session_b.commit()
        finally:
            await session_a.close()
            await session_b.close()
    finally:
        await engine.dispose()


# ─── ③순서: created_at ASC로 선정됨 ──────────────────────────────────────────

@pytest.mark.anyio
async def test_claim_batch_orders_by_created_at(monkeypatch):
    from app.models.delivery_job import DeliveryJob
    from app.services.delivery_dispatcher import _claim_batch

    engine = create_async_engine(_async_url())
    try:
        await _clean_delivery_jobs(engine)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr("app.core.database.async_session_factory", factory)

        org_id = uuid.uuid4()
        ids_in_order = []
        async with AsyncSession(engine) as session:
            for i in range(3):
                job = DeliveryJob(org_id=org_id, kind="org_webhook", payload={"seq": i})
                session.add(job)
                await session.flush()
                ids_in_order.append(job.id)
            await session.commit()

        claimed = await _claim_batch(limit=10)
        claimed_ids = [j["id"] for j in claimed if j["org_id"] == org_id]
        assert claimed_ids == ids_in_order
    finally:
        await engine.dispose()


# ─── F1(PO 리뷰 2026-08-05, 머지 前 필수수정 pin): send 단계에 커넥션이 안 잡혀 있음 ─────

@pytest.mark.anyio
async def test_send_phase_holds_no_connection_from_fetch_phase(monkeypatch):
    """PO 리뷰 F1 — 예전엔 fetch(SELECT)를 문 세션이 send(httpx POST 루프) 내내 idle-in
    -transaction으로 열려 있었다(POST 자체는 세션을 안 건드리지만 세션 객체가 안 닫혀
    있었다는 게 문제). 이걸 «docstring 주장」이 아니라 실측으로 고정한다: 엔진 풀을
    `pool_size=1, max_overflow=0`으로 좁혀놓고, `_send_webhook_targets`가 실행되는 그
    순간 **같은 엔진**으로 새 쿼리를 하나 더 띄운다 — fetch 단계 커넥션이 반납 안 됐으면
    풀 고갈로 이 새 쿼리가 타임아웃(멈춤)한다. 반납됐으면 즉시 통과한다."""
    from app.models.delivery_job import DeliveryJob
    from app.services.delivery_dispatcher import _claim_batch, _deliver_one
    from app.services.webhook_dispatch import fire_webhooks

    engine = create_async_engine(_async_url(), pool_size=1, max_overflow=0, pool_timeout=3)
    try:
        await _clean_delivery_jobs(engine)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr("app.core.database.async_session_factory", factory)

        org_id = uuid.uuid4()
        async with AsyncSession(engine) as session:
            await fire_webhooks(session, org_id, "story.status_changed", {"story_id": "s1"}, via_outbox=True)
            await session.commit()

        claimed = await _claim_batch(limit=10)
        mine = [j for j in claimed if j["org_id"] == org_id]
        assert len(mine) == 1

        probe_succeeded = {"value": False}

        async def _send_probe(targets, event, data, org_id=None):
            # story #3173 — _send_webhook_targets가 이제 4번째 인자(org_id, AU 계측용)를
            # 받는다. send가 실행되는 이 시점에 fetch 단계 커넥션이 반납돼 있어야,
            # pool_size=1인 이 엔진으로 새 세션을 여는 이 호출이 안 멈추고 통과한다.
            async with AsyncSession(engine) as probe_session:
                await probe_session.execute(select(DeliveryJob.id).limit(1))
            probe_succeeded["value"] = True

        monkeypatch.setattr("app.services.webhook_dispatch._send_webhook_targets", _send_probe)
        await _deliver_one(mine[0])

        assert probe_succeeded["value"] is True  # 풀 고갈로 멈췄다면 여기 도달 자체가 실패(pytest timeout).
    finally:
        await engine.dispose()


# ─── 전 사이클: enqueue → claim → 배달(mock _now) → status='delivered' ──────

@pytest.mark.anyio
async def test_full_cycle_enqueue_claim_deliver_marks_delivered(monkeypatch):
    from unittest.mock import AsyncMock

    from app.models.delivery_job import DeliveryJob
    from app.services.delivery_dispatcher import _claim_batch, _deliver_one
    from app.services.webhook_dispatch import fire_webhooks

    engine = create_async_engine(_async_url())
    try:
        await _clean_delivery_jobs(engine)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr("app.core.database.async_session_factory", factory)

        org_id = uuid.uuid4()
        async with AsyncSession(engine) as session:
            await fire_webhooks(session, org_id, "story.status_changed", {"story_id": "s1"}, via_outbox=True)
            await session.commit()

        claimed = await _claim_batch(limit=10)
        mine = [j for j in claimed if j["org_id"] == org_id]
        assert len(mine) == 1

        # story #2460 PO 리뷰(F1): _deliver_one의 fetch 단계는 실 PG로 그대로 태우고(빈
        # WebhookConfig 목록을 실제로 조회), send 단계(순수 외부 I/O)만 mock — fetch/send가
        # 서로 다른 세션 경계에 있다는 것 자체를 실 DB 라운드트립으로 실증한다.
        mock_send = AsyncMock()
        monkeypatch.setattr("app.services.webhook_dispatch._send_webhook_targets", mock_send)
        await _deliver_one(mine[0])

        mock_send.assert_awaited_once()  # 실 HTTP 미발신(mock) — job 상태전이만 검증.
        async with AsyncSession(engine) as verify:
            row = (await verify.execute(
                select(DeliveryJob).where(DeliveryJob.id == mine[0]["id"])
            )).scalar_one()
        assert row.status == "delivered"
        assert row.delivered_at is not None
        assert row.attempts == 1  # claim에서 1회 증가, 배달 성공은 attempts를 더 안 건드림.
    finally:
        await engine.dispose()
