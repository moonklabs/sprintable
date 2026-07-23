"""E-ARCH S3b(story #2078, SSE 좁힘 설계 2026-07-21): `EventBroker.publish_atomic()` +
`stage_status_changed_sse_outbox()` — story status 변경 커밋과 SSE outbox row가 진짜 같은
트랜잭션에 실리는지(atomic) 검증.
"""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# realdb 섹션이 Base.metadata.create_all을 호출한다 — conftest.py AST 가드(story 8236bbc3) 대응.
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _story(**overrides):
    defaults = dict(
        id=uuid.uuid4(), epic_id=None, title="S", priority="low",
        project_id=uuid.uuid4(), status="done", assignee_id=uuid.uuid4(),
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


# ═══════════════════ OutboxEventBroker.publish_atomic — 단위(mocked) ═══════════════════


@pytest.mark.anyio
async def test_publish_atomic_noop_when_outbox_disabled(monkeypatch):
    from app.services.event_broker import OutboxEventBroker

    monkeypatch.setattr("app.core.config.settings.event_broker_outbox_enabled", False)
    db = MagicMock()
    broker = OutboxEventBroker()

    await broker.publish_atomic(db, "agent", str(uuid.uuid4()), "x", {})

    db.add.assert_not_called()


@pytest.mark.anyio
async def test_publish_atomic_adds_row_without_committing(monkeypatch):
    """핵심 — commit을 호출하지 않아야 한다(caller의 commit에 실려야 진짜 atomic)."""
    from app.services.event_broker import OutboxEventBroker

    monkeypatch.setattr("app.core.config.settings.event_broker_outbox_enabled", True)
    org_id = uuid.uuid4()
    monkeypatch.setattr(
        "app.services.event_broker._resolve_org_id", AsyncMock(return_value=org_id)
    )
    db = MagicMock()
    db.commit = AsyncMock()
    broker = OutboxEventBroker()

    target_id = str(uuid.uuid4())
    await broker.publish_atomic(db, "agent", target_id, "task.assigned", {"foo": "bar"})

    db.add.assert_called_once()
    added = db.add.call_args[0][0]
    assert added.org_id == org_id
    assert added.target == "agent"
    assert str(added.target_id) == target_id
    assert added.event_type == "task.assigned"
    assert added.payload == {"foo": "bar"}
    db.commit.assert_not_called()


@pytest.mark.anyio
async def test_publish_atomic_skips_silently_when_org_id_unresolved(monkeypatch, caplog):
    from app.services.event_broker import OutboxEventBroker

    monkeypatch.setattr("app.core.config.settings.event_broker_outbox_enabled", True)
    monkeypatch.setattr(
        "app.services.event_broker._resolve_org_id", AsyncMock(return_value=None)
    )
    db = MagicMock()
    broker = OutboxEventBroker()

    with caplog.at_level("WARNING"):
        await broker.publish_atomic(db, "agent", str(uuid.uuid4()), "x", {})

    db.add.assert_not_called()
    assert "org_id unresolved" in caplog.text


@pytest.mark.anyio
async def test_dual_publish_broker_publish_atomic_degrades_to_publish(monkeypatch):
    """DualPublishEventBroker(outbox 없는 구현체) — publish_atomic이 publish()로 graceful degrade."""
    from app.services.event_broker import DualPublishEventBroker

    calls = []
    broker = DualPublishEventBroker()

    async def _fake_publish(target, target_id, event_type, data):
        calls.append((target, target_id, event_type, data))

    monkeypatch.setattr(broker, "publish", _fake_publish)
    await broker.publish_atomic(MagicMock(), "org", "org-1", "x", {"a": 1})

    assert calls == [("org", "org-1", "x", {"a": 1})]


# ═══════════════════ stage_status_changed_sse_outbox — 단위(mocked) ═══════════════════


@pytest.mark.anyio
async def test_stage_noop_when_status_unchanged():
    from app.services.story_status_events import stage_status_changed_sse_outbox

    story = _story()
    calls = []
    with patch("app.services.event_broker.event_broker.publish_atomic", AsyncMock(side_effect=lambda *a, **kw: calls.append(a))):
        await stage_status_changed_sse_outbox(AsyncMock(), uuid.uuid4(), story, story.status)
    assert calls == []


@pytest.mark.anyio
async def test_stage_calls_publish_atomic_once_per_accessible_member():
    from app.services.story_status_events import stage_status_changed_sse_outbox

    story = _story()
    member_ids = [uuid.uuid4(), uuid.uuid4(), uuid.uuid4()]
    calls = []

    async def _fake_publish_atomic(db, target, target_id, event_type, data):
        calls.append((target, target_id, event_type, data))

    with patch(
        "app.services.project_auth.project_accessible_member_ids",
        AsyncMock(return_value=member_ids),
    ), patch("app.services.event_broker.event_broker.publish_atomic", _fake_publish_atomic):
        await stage_status_changed_sse_outbox(
            AsyncMock(), uuid.uuid4(), story, "in-review", actor_id=uuid.uuid4(), actor_type="human",
        )

    assert len(calls) == 3
    for (target, target_id, event_type, data) in calls:
        assert target == "agent"
        assert target_id in {str(m) for m in member_ids}
        assert event_type == "story.status_changed"
        assert data["story_id"] == str(story.id)
        assert data["event_type"] == "story.status_changed"


@pytest.mark.anyio
async def test_stage_swallows_exceptions_does_not_propagate():
    """member_ids 해소 실패해도 예외 전파 안 해야(caller의 commit을 막으면 안 됨)."""
    from app.services.story_status_events import stage_status_changed_sse_outbox

    story = _story()
    with patch(
        "app.services.project_auth.project_accessible_member_ids",
        AsyncMock(side_effect=RuntimeError("boom")),
    ):
        await stage_status_changed_sse_outbox(
            AsyncMock(), uuid.uuid4(), story, "in-review", actor_id=uuid.uuid4(), actor_type="human",
        )  # 예외 없이 반환해야


# ═══════════════════ realdb — 진짜 atomic 왕복 검증 ═══════════════════

_REAL_DB_SKIP = pytest.mark.skipif(
    not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"
)


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.models  # noqa: F401
    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project_member(Session):
    from app.models.project import OrgMember, Project

    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    member_id = uuid.uuid4()
    async with Session() as s:
        s.add(Project(id=project_id, org_id=org_id, name="P"))
        s.add(OrgMember(id=member_id, org_id=org_id, user_id=uuid.uuid4(), role="owner"))
        await s.commit()
    return org_id, project_id, member_id


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_outbox_row_commits_with_caller_transaction(monkeypatch):
    """핵심 atomic 증거 — publish_atomic 호출 후 caller가 commit하면 outbox row가 실제로 보인다."""
    from sqlalchemy import select

    from app.core.database import Base
    from app.models.event_outbox import EventOutbox
    from app.services.event_broker import event_broker

    engine, Session = await _session_factory()
    monkeypatch.setattr("app.core.config.settings.event_broker_outbox_enabled", True)
    try:
        org_id, project_id, member_id = await _seed_org_project_member(Session)

        async with Session() as s:
            await event_broker.publish_atomic(
                s, "agent", str(member_id), "story.status_changed", {"org_id": str(org_id)}
            )
            await s.commit()

        async with Session() as s2:
            rows = (await s2.execute(select(EventOutbox))).scalars().all()
        assert len(rows) == 1
        assert rows[0].org_id == org_id
        assert rows[0].target_id == member_id
        assert rows[0].published_at is None
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_outbox_row_rolled_back_with_caller_transaction(monkeypatch):
    """atomic의 반증 방향 — caller가 commit 안 하고(rollback/세션 종료) 끝나면 outbox row도 없어야."""
    from sqlalchemy import select

    from app.core.database import Base
    from app.models.event_outbox import EventOutbox
    from app.services.event_broker import event_broker

    engine, Session = await _session_factory()
    monkeypatch.setattr("app.core.config.settings.event_broker_outbox_enabled", True)
    try:
        org_id, project_id, member_id = await _seed_org_project_member(Session)

        async with Session() as s:
            await event_broker.publish_atomic(
                s, "agent", str(member_id), "story.status_changed", {"org_id": str(org_id)}
            )
            await s.rollback()  # caller가 commit 대신 rollback(예: 이후 로직에서 실패)

        async with Session() as s2:
            rows = (await s2.execute(select(EventOutbox))).scalars().all()
        assert rows == [], "commit 안 됐는데 outbox row가 남으면 atomic이 아니다"
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_stage_status_changed_sse_outbox_end_to_end(monkeypatch):
    """stage_status_changed_sse_outbox 전체 왕복 — 실 project_accessible_member_ids 경로까지."""
    from sqlalchemy import select

    from app.core.database import Base
    from app.models.event_outbox import EventOutbox
    from app.services.story_status_events import stage_status_changed_sse_outbox

    engine, Session = await _session_factory()
    monkeypatch.setattr("app.core.config.settings.event_broker_outbox_enabled", True)
    try:
        org_id, project_id, member_id = await _seed_org_project_member(Session)
        story = _story(project_id=project_id, assignee_id=None)

        async with Session() as s:
            await stage_status_changed_sse_outbox(
                s, org_id, story, "in-review", actor_id=member_id, actor_type="human",
            )
            await s.commit()

        async with Session() as s2:
            rows = (await s2.execute(select(EventOutbox))).scalars().all()
        assert len(rows) == 1
        assert rows[0].target == "agent"
        assert rows[0].target_id == member_id
        assert rows[0].event_type == "story.status_changed"
        assert rows[0].payload["story_id"] == str(story.id)
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
