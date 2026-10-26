"""story #2101 실DB 통합 테스트 — SSE 백필이 최근 delivered 이벤트도 포함하는지 검증.

`_pending_or_recently_delivered_filter()`(events.py)는 SQLAlchemy `or_`/`and_` 절을
빌드하므로 SQLite/mock으로는 실 SQL 시맨틱(status enum·timestamptz 비교)을 완전히
검증할 수 없다 — 실 PG 필요.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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


async def _seed_project(Session, *, org_id, project_id):
    from app.models.project import Project

    async with Session() as s:
        s.add(Project(id=project_id, org_id=org_id, name="test-project"))
        await s.commit()


async def _seed_team_member(Session, *, org_id, project_id, member_id):
    from app.models.team import TeamMember

    async with Session() as s:
        s.add(TeamMember(
            id=member_id, org_id=org_id, project_id=project_id, type="agent", name="test-agent",
        ))
        await s.commit()


async def _seed_event(Session, *, org_id, project_id, recipient_id, status, delivered_at=None, created_at=None):
    from app.models.event import Event

    event_id = uuid.uuid4()
    async with Session() as s:
        s.add(Event(
            id=event_id,
            project_id=project_id,
            org_id=org_id,
            event_type="test.event",
            recipient_id=recipient_id,
            recipient_type="agent",
            payload={},
            status=status,
            delivered_at=delivered_at,
            created_at=created_at or datetime.now(timezone.utc) - timedelta(seconds=1),
        ))
        await s.commit()
    return event_id


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_backfill_filter_includes_pending_and_recent_delivered_excludes_old_delivered():
    """3건 시드(pending·최근 delivered·오래된 delivered) 중 앞 둘만 필터 통과해야."""
    from sqlalchemy import select

    from app.models.event import Event
    from app.routers.events import _pending_or_recently_delivered_filter

    _, Session = await _session_factory()
    org_id, project_id, recipient_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await _seed_project(Session, org_id=org_id, project_id=project_id)
    await _seed_team_member(Session, org_id=org_id, project_id=project_id, member_id=recipient_id)
    now = datetime.now(timezone.utc)

    pending_id = await _seed_event(
        Session, org_id=org_id, project_id=project_id, recipient_id=recipient_id, status="pending",
    )
    recent_delivered_id = await _seed_event(
        Session, org_id=org_id, project_id=project_id, recipient_id=recipient_id, status="delivered",
        delivered_at=now - timedelta(seconds=60),  # 300초 윈도 안
    )
    old_delivered_id = await _seed_event(
        Session, org_id=org_id, project_id=project_id, recipient_id=recipient_id, status="delivered",
        delivered_at=now - timedelta(seconds=600),  # 300초 윈도 밖
    )

    async with Session() as s:
        result = await s.execute(
            select(Event.id).where(
                Event.org_id == org_id,
                Event.recipient_id == recipient_id,
                _pending_or_recently_delivered_filter(now),
            )
        )
        ids = {row[0] for row in result.all()}

    assert pending_id in ids
    assert recent_delivered_id in ids
    assert old_delivered_id not in ids


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_backfill_filter_boundary_at_exactly_cutoff_is_excluded():
    """정확히 윈도 경계(>=가 아닌 그 이전 순간)는 제외 — 경계값 정밀도 확認."""
    from sqlalchemy import select

    from app.models.event import Event
    from app.routers.events import _BACKFILL_RECENT_DELIVERED_SECONDS, _pending_or_recently_delivered_filter

    _, Session = await _session_factory()
    org_id, project_id, recipient_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await _seed_project(Session, org_id=org_id, project_id=project_id)
    await _seed_team_member(Session, org_id=org_id, project_id=project_id, member_id=recipient_id)
    now = datetime.now(timezone.utc)

    just_outside_id = await _seed_event(
        Session, org_id=org_id, project_id=project_id, recipient_id=recipient_id, status="delivered",
        delivered_at=now - timedelta(seconds=_BACKFILL_RECENT_DELIVERED_SECONDS, microseconds=1),
    )
    just_inside_id = await _seed_event(
        Session, org_id=org_id, project_id=project_id, recipient_id=recipient_id, status="delivered",
        delivered_at=now - timedelta(seconds=_BACKFILL_RECENT_DELIVERED_SECONDS - 1),
    )

    async with Session() as s:
        result = await s.execute(
            select(Event.id).where(
                Event.org_id == org_id,
                Event.recipient_id == recipient_id,
                _pending_or_recently_delivered_filter(now),
            )
        )
        ids = {row[0] for row in result.all()}

    assert just_outside_id not in ids
    assert just_inside_id in ids


def test_backfill_recent_delivered_seconds_default_is_300():
    """N=300초 — story #2101 유도 근거(RECONNECT_DELAYS_MS plateau)와 정합 고정."""
    from app.routers.events import _BACKFILL_RECENT_DELIVERED_SECONDS

    assert _BACKFILL_RECENT_DELIVERED_SECONDS == 300


def test_backfill_filter_used_in_both_exceed_and_within_branches():
    """소스 검사 — exceed/within 두 분기 모두 새 필터를 쓰는지(회귀 시 pending만 남는 것 방지)."""
    import inspect

    from app.routers import events as ev_module

    source = inspect.getsource(ev_module.agent_event_stream)
    assert source.count("_pending_or_recently_delivered_filter(now)") == 1
    assert source.count("_status_filter") >= 2  # exceed_clauses·where_clauses 양쪽에서 재사용
    # 예전 하드코딩(Event.status == "pending")이 두 분기 조건절에 더 이상 없어야 —
    # 있으면 그 분기가 _status_filter로 치환 안 된 회귀.
    assert 'Event.status == "pending",' not in source


# ─── story 4781 (AC8 · PO 10-26) — `delivered_at` is the FIRST delivery; a backfill re-send does not move it ──────────────────────────
# 10-26 (dev): one bell line's `delivered_at` changed five times in twelve minutes. The backfill above re-sends what was delivered inside the last 300 seconds and used to stamp
# `delivered_at = now` on every event it sent, delivered or not — so each reconnect re-opened the window for the same event, which the next reconnect sent again and stamped
# again: one notification replayed for as long as the stream kept reconnecting (every human notification does this: they are created `delivered`). Only a pending event is stamped, once.

import inspect  # noqa: E402


async def _reconnect(Session, org_id, recipient_id, at: datetime, stamp) -> set[uuid.UUID]:
    """What one reconnect does at time `at`: select what the backfill would send (the stream's own filter), stamp the batch with `stamp`, commit. Returns the ids it sent."""
    from sqlalchemy import select

    from app.models.event import Event
    from app.routers.events import _pending_or_recently_delivered_filter

    async with Session() as s:
        batch = list((await s.execute(
            select(Event).where(Event.org_id == org_id, Event.recipient_id == recipient_id, _pending_or_recently_delivered_filter(at)).order_by(Event.created_at.asc())
        )).scalars().all())
        await stamp(s, batch, at)
        await s.commit()
        return {e.id for e in batch}


async def _delivered_at(Session, event_id):
    from app.models.event import Event

    async with Session() as s:
        return (await s.get(Event, event_id)).delivered_at


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_4781_01_a_pending_event_is_stamped_once_and_resent_only_inside_the_window_after_that():
    from app.routers.events import _BACKFILL_RECENT_DELIVERED_SECONDS as WINDOW, _stamp_first_delivery

    _, Session = await _session_factory()
    org_id, project_id, recipient_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await _seed_project(Session, org_id=org_id, project_id=project_id)
    await _seed_team_member(Session, org_id=org_id, project_id=project_id, member_id=recipient_id)
    t0 = datetime.now(timezone.utc)
    eid = await _seed_event(Session, org_id=org_id, project_id=project_id, recipient_id=recipient_id, status="pending", created_at=t0 - timedelta(seconds=1))
    sent = []
    for dt in (0, 5, 60, 120, 250, WINDOW - 1):  # the stream reconnects again and again inside the window
        sent.append(eid in await _reconnect(Session, org_id, recipient_id, t0 + timedelta(seconds=dt), _stamp_first_delivery))
    assert sent == [True] * 6, "every reconnect inside the window of the FIRST delivery still gets it (no loss)"
    assert await _delivered_at(Session, eid) == t0, "and the first delivery time is what the row keeps"
    assert eid not in await _reconnect(Session, org_id, recipient_id, t0 + timedelta(seconds=WINDOW + 1), _stamp_first_delivery), "past the window: not sent again, however many reconnects came before"
    assert eid not in await _reconnect(Session, org_id, recipient_id, t0 + timedelta(seconds=WINDOW + 400), _stamp_first_delivery)


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_4781_03_a_human_notification_created_delivered_keeps_its_creation_time_through_reconnects():
    """Human bell Events are born `delivered` with `delivered_at` = their creation: the case that showed on 10-26."""
    from app.routers.events import _BACKFILL_RECENT_DELIVERED_SECONDS as WINDOW, _stamp_first_delivery

    _, Session = await _session_factory()
    org_id, project_id, recipient_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await _seed_project(Session, org_id=org_id, project_id=project_id)
    await _seed_team_member(Session, org_id=org_id, project_id=project_id, member_id=recipient_id)
    t0 = datetime.now(timezone.utc)
    eid = await _seed_event(Session, org_id=org_id, project_id=project_id, recipient_id=recipient_id, status="delivered", delivered_at=t0, created_at=t0 - timedelta(seconds=1))
    for dt in (30, 90, 200):
        assert eid in await _reconnect(Session, org_id, recipient_id, t0 + timedelta(seconds=dt), _stamp_first_delivery)
    assert await _delivered_at(Session, eid) == t0
    assert eid not in await _reconnect(Session, org_id, recipient_id, t0 + timedelta(seconds=WINDOW + 1), _stamp_first_delivery)


def test_4781_04_the_stream_uses_the_helper_and_no_longer_stamps_the_batch_itself():
    from app.routers import events as ev_module

    source = inspect.getsource(ev_module.agent_event_stream)
    assert "_stamp_first_delivery(db, batch, now)" in source
    assert "evt.delivered_at = now" not in source


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_4781_05_a_second_ack_keeps_the_first_delivery_time():
    from app.routers import events as ev_module

    _, Session = await _session_factory()
    org_id, project_id, recipient_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await _seed_project(Session, org_id=org_id, project_id=project_id)
    await _seed_team_member(Session, org_id=org_id, project_id=project_id, member_id=recipient_id)
    eid = await _seed_event(Session, org_id=org_id, project_id=project_id, recipient_id=recipient_id, status="pending")

    async def _is_the_recipient(*_a, **_k):
        return None

    original = ev_module.assert_caller_is_member
    ev_module.assert_caller_is_member = _is_the_recipient
    try:
        async with Session() as s:
            await ev_module.mark_delivered(eid, db=s, org_id=org_id, auth=None)
        first = await _delivered_at(Session, eid)
        assert first is not None
        async with Session() as s:
            await ev_module.mark_delivered(eid, db=s, org_id=org_id, auth=None)
        assert await _delivered_at(Session, eid) == first, "a second ack is not a second delivery"
    finally:
        ev_module.assert_caller_is_member = original


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_4781_06_two_connections_that_read_the_same_pending_event_do_not_overwrite_each_other():
    """The first stamp is decided in the database (codex 10-26): two connections read one event as pending, both stamp — the first stays; neither a later backfill nor a late ack moves it."""
    from sqlalchemy import select

    from app.models.event import Event
    from app.routers.events import _stamp_first_delivery

    _, Session = await _session_factory()
    org_id, project_id, recipient_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await _seed_project(Session, org_id=org_id, project_id=project_id)
    await _seed_team_member(Session, org_id=org_id, project_id=project_id, member_id=recipient_id)
    t0 = datetime.now(timezone.utc)
    eid = await _seed_event(Session, org_id=org_id, project_id=project_id, recipient_id=recipient_id, status="pending")
    async with Session() as s1, Session() as s2:
        read1 = list((await s1.execute(select(Event).where(Event.id == eid))).scalars())
        read2 = list((await s2.execute(select(Event).where(Event.id == eid))).scalars())
        assert read1[0].status == "pending" and read2[0].status == "pending"
        await _stamp_first_delivery(s1, read1, t0)
        await s1.commit()
        await _stamp_first_delivery(s2, read2, t0 + timedelta(seconds=7))  # read as pending a moment ago; it is delivered now
        await s2.commit()
    assert await _delivered_at(Session, eid) == t0
