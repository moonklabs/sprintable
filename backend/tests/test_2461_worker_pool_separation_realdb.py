"""story #2461(§6 봉합③) realdb 검증 — 클레임 세션이 실제로 발행 단계 前 반납되는지 실측.

PO 지시(2026-08-05): 검증="워커가 요청풀 안 먹나" — 이 파일은 #2460 F1 pin
(test_send_phase_holds_no_connection_from_fetch_phase)과 동형 기법으로, pool_size=1
엔진에서 claim 직후 새 커넥션 획득이 가능한지(=claim 세션이 반납됐는지)를 실측한다.
⛔공유 dev 백엔드 접속 없음 — 로컬 Postgres(``PARITY_TEST_DATABASE_URL``)만 사용.
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


async def _clean_event_outbox(engine) -> None:
    from app.models.event_outbox import EventOutbox

    async with engine.begin() as conn:
        await conn.execute(EventOutbox.__table__.delete())


@pytest.mark.anyio
async def test_outbox_publish_phase_holds_no_connection_from_claim_phase(monkeypatch):
    """claim(FOR UPDATE SKIP LOCKED 짧은 트랜잭션)이 커밋된 뒤에는, pool_size=1 엔진으로
    새 세션을 여는 것이 막히지 않아야 한다 — publish 단계(순수 Redis, 이 테스트에선 mock)가
    실행되는 그 순간에 claim 세션이 진짜 반납돼 있음을 실측 고정."""
    from app.models.event_outbox import EventOutbox
    from app.services.event_broker import _claim_outbox_batch, _publish_outbox_batch

    engine = create_async_engine(_async_url(), pool_size=1, max_overflow=0, pool_timeout=3)
    try:
        await _clean_event_outbox(engine)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr("app.core.database.async_session_factory", factory)
        # story #2461 part2: outbox claim/publish/finalize가 이제 worker_session_factory를
        # 쓴다 — 이 테스트의 격리 엔진이 그쪽에도 걸리게 함께 patch(안 하면 CI의 실 DATABASE_URL
        # 로 새 나가 "attached to a different loop" — 로컬 재현 완료).
        monkeypatch.setattr("app.core.database.worker_session_factory", factory)

        async with AsyncSession(engine, expire_on_commit=False) as session:
            session.add(EventOutbox(
                id=uuid.uuid4(), org_id=uuid.uuid4(), target="org", target_id=uuid.uuid4(),
                event_type="story.status_changed", payload={"x": 1},
            ))
            await session.commit()

        claimed = await _claim_outbox_batch(limit=10)
        assert len(claimed) == 1

        probe_succeeded = {"value": False}

        async def _publish_probe(claimed_rows):
            # publish가 실행되는 이 시점에 claim 단계 커넥션이 반납돼 있어야, pool_size=1인
            # 이 엔진으로 새 세션을 여는 이 호출이 안 멈추고 통과한다.
            async with AsyncSession(engine) as probe_session:
                await probe_session.execute(select(EventOutbox.id).limit(1))
            probe_succeeded["value"] = True
            return [c["id"] for c in claimed_rows]

        published_ids = await _publish_probe(claimed)
        assert probe_succeeded["value"] is True
        assert published_ids == [claimed[0]["id"]]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_outbox_claim_commits_atomically(monkeypatch):
    """claim이 caller와 독립적으로(자기 세션) commit되므로, claim 호출 자체가 rollback
    불가능한 완료된 트랜잭션임을 확認 — 반환된 row가 DB에 실제로 남아 있고(soft-claim,
    published_at은 아직 None), 재조회로도 같은 상태가 보임."""
    from app.models.event_outbox import EventOutbox
    from app.services.event_broker import _claim_outbox_batch

    engine = create_async_engine(_async_url())
    try:
        await _clean_event_outbox(engine)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr("app.core.database.async_session_factory", factory)
        # story #2461 part2: outbox claim/publish/finalize가 이제 worker_session_factory를
        # 쓴다 — 이 테스트의 격리 엔진이 그쪽에도 걸리게 함께 patch(안 하면 CI의 실 DATABASE_URL
        # 로 새 나가 "attached to a different loop" — 로컬 재현 완료).
        monkeypatch.setattr("app.core.database.worker_session_factory", factory)

        row_id = uuid.uuid4()
        async with AsyncSession(engine, expire_on_commit=False) as session:
            session.add(EventOutbox(
                id=row_id, org_id=uuid.uuid4(), target="agent", target_id=uuid.uuid4(),
                event_type="x", payload={},
            ))
            await session.commit()

        claimed = await _claim_outbox_batch(limit=10)
        assert [c["id"] for c in claimed] == [row_id]

        async with AsyncSession(engine) as verify:
            row = (await verify.execute(
                select(EventOutbox).where(EventOutbox.id == row_id)
            )).scalar_one()
        assert row.published_at is None  # claim 자체는 status를 안 바꿈(soft-claim)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_outbox_finalize_marks_published(monkeypatch):
    from app.models.event_outbox import EventOutbox
    from app.services.event_broker import _finalize_outbox_published

    engine = create_async_engine(_async_url())
    try:
        await _clean_event_outbox(engine)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr("app.core.database.async_session_factory", factory)
        # story #2461 part2: outbox claim/publish/finalize가 이제 worker_session_factory를
        # 쓴다 — 이 테스트의 격리 엔진이 그쪽에도 걸리게 함께 patch(안 하면 CI의 실 DATABASE_URL
        # 로 새 나가 "attached to a different loop" — 로컬 재현 완료).
        monkeypatch.setattr("app.core.database.worker_session_factory", factory)

        row_id = uuid.uuid4()
        async with AsyncSession(engine, expire_on_commit=False) as session:
            session.add(EventOutbox(
                id=row_id, org_id=uuid.uuid4(), target="agent", target_id=uuid.uuid4(),
                event_type="x", payload={},
            ))
            await session.commit()

        await _finalize_outbox_published([row_id])

        async with AsyncSession(engine) as verify:
            row = (await verify.execute(
                select(EventOutbox).where(EventOutbox.id == row_id)
            )).scalar_one()
        assert row.published_at is not None
    finally:
        await engine.dispose()
