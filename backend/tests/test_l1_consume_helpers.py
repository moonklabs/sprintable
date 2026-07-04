"""L1 BE-6: L2/L4 소비 helper 테스트 (activity_seq cursor poll + object anchoring).

activity_events만 사용(FK 없음)하므로 real-DB로 직접 seed해 검증한다.
PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL 없으면 skip(CI alembic-fresh-db 잡).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

TS = datetime(2026, 6, 11, 12, 0, 0, tzinfo=timezone.utc)

_RAW = os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL") or ""
_ASYNC_URL = (
    _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")
    if _RAW
    else ""
)
pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not _ASYNC_URL, reason="real-DB URL 미설정 — skip"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _act(org, *, verb="memo_created", object_type="memo", object_id=None, sources=1):
    from app.models.activity_event import ActivityEvent

    return ActivityEvent(
        org_id=org, project_id=uuid.uuid4(), actor_id=None, verb=verb,
        object_type=object_type, object_id=object_id or uuid.uuid4(), occurred_at=TS,
        source_event_ids=[uuid.uuid4() for _ in range(sources)],
        recipient_ids=[uuid.uuid4() for _ in range(sources)],
        recipient_types=["human"] * sources, payload={"t": "x"}, dedup_key=str(uuid.uuid4()),
    )


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models.activity_event import ActivityEvent

    engine = create_async_engine(_ASYNC_URL)
    async with engine.begin() as conn:
        await conn.run_sync(ActivityEvent.__table__.create, checkfirst=True)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def test_poll_activities_after_seq_cursor_and_org_scope():
    from sqlalchemy import func, select

    from app.models.activity_event import ActivityEvent
    from app.services.activity_stream import poll_activities_after_seq

    engine, Session = await _session()
    org_a, org_b = uuid.uuid4(), uuid.uuid4()
    try:
        async with Session() as s:
            # story 18eefc31: activity_events 는 이 파일 전체·84파일 풀런에서 공유되는 테이블이라
            # (cleanup 없음) 이전 테스트/파일이 심은 잔여행이 누적된다. 원래 base 계산(전체 테이블
            # MIN(activity_seq))은 그 잔여행까지 잡아 poll_after(base-1)가 이 테스트의 4행보다
            # 훨씬 많이 반환 — 소배치서는 우연히 통과(잔여 없음)·84파일 풀런서만 실패했다.
            # 삽입 直前 워터마크(MAX, 순차실행이라 동시쓰기 없음 — 안전)를 cursor 기준으로 삼아
            # "이 테스트가 심은 행만" 포착하도록 근본수정.
            pre = (await s.execute(select(func.max(ActivityEvent.activity_seq)))).scalar() or 0
            s.add_all([_act(org_a), _act(org_a), _act(org_b), _act(org_a)])
            await s.commit()

            # org 생략 = 전 org poll. after_seq=pre(삽입 直前 워터마크)로 이 테스트의 4행만.
            allrows, _ = await poll_activities_after_seq(s, pre, limit=100)
            assert len(allrows) == 4
            assert [r.activity_seq for r in allrows] == sorted(r.activity_seq for r in allrows)  # ASC

            # org_a 스코프 = 3행(org_b 제외).
            a_rows, _ = await poll_activities_after_seq(s, pre, limit=100, org_id=org_a)
            assert len(a_rows) == 3 and all(r.org_id == org_a for r in a_rows)

            # cursor: limit=2 → next_after_seq, 이어 읽기 strict(중복 0).
            p1, nxt1 = await poll_activities_after_seq(s, pre, limit=2, org_id=org_a)
            assert len(p1) == 2 and nxt1 == p1[-1].activity_seq
            p2, nxt2 = await poll_activities_after_seq(s, nxt1, limit=2, org_id=org_a)
            assert len(p2) == 1 and nxt2 is None
            assert p2[0].activity_seq > nxt1

            await s.execute(ActivityEvent.__table__.delete().where(ActivityEvent.org_id.in_([org_a, org_b])))
            await s.commit()
    finally:
        await engine.dispose()


async def test_latest_activity_for_object_returns_newest():
    from app.services.activity_stream import latest_activity_for_object

    engine, Session = await _session()
    org, obj = uuid.uuid4(), uuid.uuid4()
    try:
        async with Session() as s:
            s.add(_act(org, object_type="story", object_id=obj, verb="created"))
            s.add(_act(org, object_type="story", object_id=obj, verb="status_changed"))  # 더 최신(seq↑)
            s.add(_act(org, object_type="story", object_id=uuid.uuid4()))  # 다른 object
            await s.commit()

            latest = await latest_activity_for_object(s, org, "story", obj)
            assert latest is not None and latest.verb == "status_changed"  # activity_seq DESC 최신

            # 매칭 없으면 None.
            assert await latest_activity_for_object(s, org, "story", uuid.uuid4()) is None
            # 다른 org면 None(org scope).
            assert await latest_activity_for_object(s, uuid.uuid4(), "story", obj) is None
    finally:
        await engine.dispose()


async def test_fanout_yields_single_activity_no_duplicate_trigger():
    """AC③: 동일 fan-out은 canonical 1행이라 poll이 1행만 — 중복 trigger 0."""
    from sqlalchemy import select

    from app.models.activity_event import ActivityEvent
    from app.services.activity_stream import poll_activities_after_seq

    engine, Session = await _session()
    org, obj = uuid.uuid4(), uuid.uuid4()
    try:
        async with Session() as s:
            # 3 수신자 fan-out이 수렴된 canonical 1행(source 3).
            s.add(_act(org, object_id=obj, sources=3))
            await s.commit()
            base = (await s.execute(select(ActivityEvent.activity_seq))).scalars().first()

            rows, _ = await poll_activities_after_seq(s, base - 1, org_id=org)
            assert len(rows) == 1  # fan-out N → poll 1행(중복 trigger 0)
            assert len(rows[0].source_event_ids) == 3  # 수신자 3 누적은 보존
    finally:
        await engine.dispose()
