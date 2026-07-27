"""E-ARCH S3(story #2078) 3a단계 — event_outbox 실DB 통합 테스트.

`_resolve_org_id`(team_members/org_members UNION 조회)·`_insert_outbox_row`·
`outbox_dispatcher_loop`(FOR UPDATE SKIP LOCKED 폴링→발행→published_at 마킹)은 실 SQL 문법과
JSONB/UUID 타입에 의존해 SQLite/mock으로는 검증 불가능하다 — 실 PG 필요.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# realdb 섹션이 Base.metadata.create_all을 호출한다 — conftest.py AST 가드(story 8236bbc3) 대응.
pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(
    not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"
)


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

    import app.models  # noqa: F401 — 전 모델 메타데이터 로드
    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_member(Session):
    """org_members에 휴먼 하나 시드 — grant-only(team_members 행 없음) 케이스를 정확히 재현.
    org_id/user_id에 FK가 없어(project.py:44-45) Organization/User 시드 불요."""
    from app.models.project import OrgMember

    org_id = uuid.uuid4()
    member_id = uuid.uuid4()
    async with Session() as s:
        s.add(OrgMember(id=member_id, org_id=org_id, user_id=uuid.uuid4(), role="member"))
        await s.commit()
    return org_id, member_id


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_resolve_org_id_org_target_returns_target_id_directly(monkeypatch):
    from app.services.event_broker import _resolve_org_id

    org_id = uuid.uuid4()
    resolved = await _resolve_org_id("org", str(org_id), {})
    assert resolved == org_id


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_resolve_org_id_agent_target_prefers_payload_org_id():
    from app.services.event_broker import _resolve_org_id

    org_id = uuid.uuid4()
    resolved = await _resolve_org_id("agent", str(uuid.uuid4()), {"org_id": str(org_id)})
    assert resolved == org_id


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_resolve_org_id_agent_target_falls_back_to_org_members_lookup(monkeypatch):
    """#2075(org owner SSE parity)와 동일 근거 — grant-only 휴먼은 team_members 행이 없고
    org_members.id로만 신원이 해소된다. UNION 조회가 이 케이스를 잡아야 한다."""
    from app.core.database import Base
    from app.services import event_broker as eb

    engine, Session = await _session_factory()
    monkeypatch.setattr("app.core.database.async_session_factory", Session)
    try:
        org_id, member_id = await _seed_org_member(Session)
        resolved = await eb._resolve_org_id("agent", str(member_id), {})
        assert resolved == org_id
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_resolve_org_id_unresolvable_returns_none(monkeypatch):
    from app.core.database import Base
    from app.services import event_broker as eb

    engine, Session = await _session_factory()
    monkeypatch.setattr("app.core.database.async_session_factory", Session)
    try:
        resolved = await eb._resolve_org_id("agent", str(uuid.uuid4()), {})
        assert resolved is None
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_insert_outbox_row_creates_pending_row(monkeypatch):
    from sqlalchemy import select

    from app.core.database import Base
    from app.models.event_outbox import EventOutbox
    from app.services import event_broker as eb

    engine, Session = await _session_factory()
    monkeypatch.setattr("app.core.database.async_session_factory", Session)
    try:
        org_id = uuid.uuid4()
        await eb._insert_outbox_row("org", str(org_id), "story.status_changed", {"entity_id": "s1"})

        async with Session() as s:
            rows = (await s.execute(select(EventOutbox))).scalars().all()
        assert len(rows) == 1
        assert rows[0].org_id == org_id
        assert rows[0].target == "org"
        assert rows[0].published_at is None
        assert rows[0].payload == {"entity_id": "s1"}
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_insert_outbox_row_skips_silently_when_org_id_unresolvable(monkeypatch):
    """best-effort 철학 — org_id 못 찾아도 예외 안 던지고 조용히 skip(경고 로그만)."""
    from sqlalchemy import select

    from app.core.database import Base
    from app.models.event_outbox import EventOutbox
    from app.services import event_broker as eb

    engine, Session = await _session_factory()
    monkeypatch.setattr("app.core.database.async_session_factory", Session)
    try:
        await eb._insert_outbox_row("agent", str(uuid.uuid4()), "x", {})  # raise 안 해야
        async with Session() as s:
            rows = (await s.execute(select(EventOutbox))).scalars().all()
        assert rows == []
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_outbox_dispatcher_publishes_pending_rows_and_marks_published(monkeypatch):
    """dispatcher가 pending row를 Redis publish하고 published_at을 마킹하는지 — 실 SQL(FOR
    UPDATE SKIP LOCKED·published_at IS NULL 필터) 검증. 1회전만 돌리고 즉시 취소."""
    import asyncio

    from sqlalchemy import select

    from app.core.database import Base
    from app.models.event_outbox import EventOutbox
    from app.services import event_broker as eb

    engine, Session = await _session_factory()
    monkeypatch.setattr("app.core.database.async_session_factory", Session)
    monkeypatch.setattr("app.core.config.settings.redis_url", "redis://fake:6379/0")

    published = []
    fake_client = AsyncMock()

    async def _fake_publish(channel, payload):
        published.append((channel, payload))

    fake_client.publish = _fake_publish
    monkeypatch.setattr(eb, "_get_redis_client", lambda: fake_client)

    org_id = uuid.uuid4()
    try:
        async with Session() as s:
            s.add(EventOutbox(org_id=org_id, target="org", target_id=org_id, event_type="x", payload={}))
            await s.commit()

        task = asyncio.create_task(eb.outbox_dispatcher_loop())
        for _ in range(50):  # 최대 ~0.5s 대기 — dispatcher가 첫 배치를 처리할 때까지
            await asyncio.sleep(0.01)
            if published:
                break
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        assert len(published) == 1

        async with Session() as s:
            rows = (await s.execute(select(EventOutbox))).scalars().all()
        assert rows[0].published_at is not None
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_outbox_dispatcher_skips_immediately_without_redis_url(monkeypatch):
    from app.services import event_broker as eb

    monkeypatch.setattr("app.core.config.settings.redis_url", None)
    await eb.outbox_dispatcher_loop()  # 타임아웃 없이 즉시 끝나야
