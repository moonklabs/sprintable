"""L1 BE-2: canonical mapper/extractor 테스트.

순수 함수(canonical_verb·fingerprint·dedup_key)는 DB 없이, upsert는 real-DB에서 검증한다
(PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL 없으면 skip — CI alembic-fresh-db 잡).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.services.activity_stream import (
    build_dedup_key,
    canonical_payload_fingerprint,
    canonical_verb,
)

TS = datetime(2026, 6, 11, 12, 0, 0, tzinfo=timezone.utc)


def _ev(**kw):
    base = dict(
        id=uuid.uuid4(),
        org_id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        event_type="status_changed",
        source_entity_type="story",
        source_entity_id=uuid.uuid4(),
        sender_id=uuid.uuid4(),
        recipient_id=uuid.uuid4(),
        recipient_type="human",
        payload={},
        created_at=TS,
    )
    base.update(kw)
    return SimpleNamespace(**base)


# ── canonical_verb (AC②) ────────────────────────────────────────────────────────

def test_canonical_verb_plain():
    assert canonical_verb(_ev(event_type="status_changed", payload={})) == "status_changed"


def test_canonical_verb_dispatched_unwraps_inner():
    ev = _ev(event_type="dispatched", payload={"event_type": "memo_replied", "title": "t"})
    assert canonical_verb(ev) == "memo_replied"


def test_canonical_verb_dispatched_without_inner_keeps_dispatched():
    assert canonical_verb(_ev(event_type="dispatched", payload={"title": "t"})) == "dispatched"


# ── fingerprint (AC③) ────────────────────────────────────────────────────────────

def test_fingerprint_excludes_delivery_only_fields():
    a = canonical_payload_fingerprint({"title": "x", "recipient_id": "r1", "recipient_seq": 1, "event_id": "e1"})
    b = canonical_payload_fingerprint({"title": "x", "recipient_id": "r2", "recipient_seq": 9, "event_id": "e2"})
    assert a == b  # delivery-only 차이는 fingerprint 불변


def test_fingerprint_changes_with_semantic_payload():
    assert canonical_payload_fingerprint({"title": "x"}) != canonical_payload_fingerprint({"title": "y"})


def test_fingerprint_is_order_independent():
    assert canonical_payload_fingerprint({"a": 1, "b": 2}) == canonical_payload_fingerprint({"b": 2, "a": 1})


# ── dedup_key (AC④ identity) ─────────────────────────────────────────────────────

def test_dedup_key_same_for_recipient_fanout():
    """같은 dispatch의 수신자 fan-out(recipient만 다름·created_at 공유) → 같은 dedup_key."""
    oid, sid, obj = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    common = dict(event_type="dispatched", org_id=oid, sender_id=None, source_entity_type="memo",
                  source_entity_id=obj, created_at=TS, payload={"title": "t", "body": "b", "event_type": "memo_created"})
    e1 = _ev(recipient_id=uuid.uuid4(), recipient_type="human", **common)
    e2 = _ev(recipient_id=uuid.uuid4(), recipient_type="agent", **common)
    assert build_dedup_key(e1) == build_dedup_key(e2)


def test_dedup_key_differs_for_distinct_object():
    e1 = _ev(source_entity_id=uuid.uuid4())
    e2 = _ev(source_entity_id=uuid.uuid4())
    assert build_dedup_key(e1) != build_dedup_key(e2)


def test_dedup_key_differs_for_distinct_dispatch_time():
    obj = uuid.uuid4()
    e1 = _ev(source_entity_id=obj, created_at=TS)
    e2 = _ev(source_entity_id=obj, created_at=datetime(2026, 6, 11, 13, 0, 0, tzinfo=timezone.utc))
    assert build_dedup_key(e1) != build_dedup_key(e2)


# ── upsert (AC①④⑤) — real-DB ─────────────────────────────────────────────────────

_RAW = os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL") or ""
_ASYNC_URL = (
    _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")
    if _RAW
    else ""
)

pytestmark_db = pytest.mark.skipif(not _ASYNC_URL, reason="real-DB URL 미설정 — skip")


def _upsert_stmt(org, dedup, src_id, rid, rtype):
    """activity_stream.upsert_activity_from_events가 이벤트당 발행하는 것과 동일한 on_conflict 문.

    실 Event(projects/team_members FK)를 seed하지 않고 array-union ON CONFLICT 거동만
    검증한다 — Event→활동 매핑(verb/dedup_key)은 위 순수 함수 테스트가 커버.
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from app.models.activity_event import ActivityEvent
    from app.services.activity_stream import _array_union_sql

    return (
        pg_insert(ActivityEvent.__table__)
        .values(
            activity_id=uuid.uuid4(), org_id=org, project_id=uuid.uuid4(), actor_id=None,
            verb="memo_created", object_type="memo", object_id=uuid.uuid4(), occurred_at=TS,
            representative_event_id=src_id, source_event_ids=[src_id], recipient_ids=[rid],
            recipient_types=[rtype], payload={"title": "t"}, dedup_key=dedup,
        )
        .on_conflict_do_update(
            index_elements=["org_id", "dedup_key"],
            set_={
                "source_event_ids": _array_union_sql("source_event_ids", "uuid[]"),
                "recipient_ids": _array_union_sql("recipient_ids", "uuid[]"),
                "recipient_types": _array_union_sql("recipient_types", "text[]"),
            },
        )
        .returning(ActivityEvent.__table__.c.activity_id)
    )


@pytestmark_db
@pytest.mark.anyio
async def test_upsert_array_union_merge_idempotent_and_distinct():
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models.activity_event import ActivityEvent

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(ActivityEvent.__table__.create, checkfirst=True)
        org, dk = uuid.uuid4(), "dedupA"
        s1, s2, s3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        r1, r2, r3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            a1 = (await s.execute(_upsert_stmt(org, dk, s1, r1, "human"))).scalar_one()
            a2 = (await s.execute(_upsert_stmt(org, dk, s2, r2, "agent"))).scalar_one()
            a3 = (await s.execute(_upsert_stmt(org, dk, s3, r3, "human"))).scalar_one()
            await s.commit()
            assert a1 == a2 == a3  # AC④ fan-out → 단일 활동

            (a,) = (await s.execute(select(ActivityEvent).where(ActivityEvent.org_id == org))).scalars().all()
            assert set(a.source_event_ids) == {s1, s2, s3}
            assert set(a.recipient_ids) == {r1, r2, r3}
            assert set(a.recipient_types) == {"human", "agent"}
            assert a.activity_seq is not None  # Identity DB 생성

            # AC⑤ idempotent.
            await s.execute(_upsert_stmt(org, dk, s1, r1, "human"))
            await s.commit()
            (a2r,) = (await s.execute(select(ActivityEvent).where(ActivityEvent.org_id == org))).scalars().all()
            assert set(a2r.source_event_ids) == {s1, s2, s3}

            # 다른 dedup_key → 별 행.
            await s.execute(_upsert_stmt(org, "dedupB", uuid.uuid4(), uuid.uuid4(), "human"))
            await s.commit()
            rows = (await s.execute(select(ActivityEvent).where(ActivityEvent.org_id == org))).scalars().all()
            assert len(rows) == 2
    finally:
        await engine.dispose()
