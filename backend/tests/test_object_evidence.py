"""H1-S1: L1 evidence read helper 테스트 (poll_object_evidence·latest_object_evidence).

소스=activity_events. 단위(actor_type 배치해소·정규화) + 실 Postgres(스코프/ASC/verbs/after_seq/
empty·AC④ status_changed seed→latest). DB 신설 0.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.services import activity_stream as mod
from app.services.activity_stream import (
    _evidence_dict,
    latest_object_evidence,
    poll_object_evidence,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── 단위: 정규화 + actor_type 배치 해소 ────────────────────────────────────────

def test_evidence_dict_normalizes_fields():
    aid, oid, actor = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    ts = datetime(2026, 6, 12, tzinfo=timezone.utc)
    row = SimpleNamespace(
        activity_id=aid, activity_seq=7, actor_id=actor, verb="status_changed",
        object_type="story", object_id=oid, occurred_at=ts, payload={"to": "in_review"},
    )
    d = _evidence_dict(row, "agent")
    assert d["activity_id"] == aid and d["activity_seq"] == 7
    assert d["actor_id"] == actor and d["actor_type"] == "agent"
    assert d["verb"] == "status_changed" and d["object_type"] == "story" and d["object_id"] == oid
    assert d["timestamp"] == ts and d["context"] == {"to": "in_review"}


def test_evidence_dict_null_payload_to_empty():
    row = SimpleNamespace(
        activity_id=uuid.uuid4(), activity_seq=1, actor_id=None, verb="x",
        object_type="story", object_id=uuid.uuid4(), occurred_at=datetime.now(timezone.utc),
        payload=None,
    )
    assert _evidence_dict(row, None)["context"] == {} and _evidence_dict(row, None)["actor_type"] is None


@pytest.mark.anyio
async def test_resolve_actor_types_batches_lookup():
    a1, a2 = uuid.uuid4(), uuid.uuid4()
    fake = {a1: SimpleNamespace(type="agent"), a2: SimpleNamespace(type="human")}
    with patch("app.services.member_resolver.lookup_members_by_ids", AsyncMock(return_value=fake)) as lk:
        out = await mod._resolve_actor_types(AsyncMock(), {a1, a2, None})
    assert out == {a1: "agent", a2: "human"}
    # None 제외 + 단일 배치 호출.
    lk.assert_awaited_once()
    assert lk.await_args.args[0] == {a1, a2}


@pytest.mark.anyio
async def test_resolve_actor_types_empty_skips_query():
    with patch("app.services.member_resolver.lookup_members_by_ids", AsyncMock()) as lk:
        assert await mod._resolve_actor_types(AsyncMock(), {None}) == {}
    lk.assert_not_awaited()


# ── 실 Postgres: 스코프/정렬/verbs/after_seq/empty (AC①③④) ─────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_object_evidence_real_db():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models.activity_event import ActivityEvent

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    org = uuid.uuid4()
    proj = uuid.uuid4()
    story_a = uuid.uuid4()
    story_b = uuid.uuid4()
    actor = uuid.uuid4()
    base = datetime(2026, 6, 12, 0, 0, tzinfo=timezone.utc)

    def _row(seq, obj_id, verb, mins):
        return ActivityEvent(
            activity_id=uuid.uuid4(), org_id=org, project_id=proj, actor_id=actor,
            verb=verb, object_type="story", object_id=obj_id,
            occurred_at=base + timedelta(minutes=mins),
            source_event_ids=[], recipient_ids=[], recipient_types=[],
            payload={"seq": seq}, dedup_key=f"dk-{uuid.uuid4()}", activity_seq=seq,
        )

    try:
        async with engine.begin() as conn:
            await conn.run_sync(ActivityEvent.__table__.create, checkfirst=True)
        Session = async_sessionmaker(engine, expire_on_commit=False)
        async with Session() as s:
            s.add_all([
                _row(101, story_a, "commented", 1),
                _row(103, story_a, "status_changed", 3),
                _row(105, story_a, "status_changed", 5),
                _row(104, story_b, "status_changed", 4),  # 다른 object — 격리돼야.
            ])
            await s.commit()

        # actor_type 해소는 멤버 테이블 의존이라 격리(쿼리/정규화에 집중).
        with patch.object(mod, "_resolve_actor_types", AsyncMock(return_value={actor: "agent"})):
            async with Session() as s:
                # AC④: status_changed seed → latest 반환(최신=seq105).
                latest = await latest_object_evidence(s, org, "story", story_a, verbs=["status_changed"])
                assert latest is not None and latest["activity_seq"] == 105
                assert latest["verb"] == "status_changed" and latest["actor_type"] == "agent"
                assert latest["object_id"] == story_a

                # AC①: 시간순 ASC·object 스코프(story_b 격리).
                allv = await poll_object_evidence(s, org, "story", story_a)
                assert [r["activity_seq"] for r in allv] == [101, 103, 105]

                # verbs 필터.
                sc = await poll_object_evidence(s, org, "story", story_a, verbs=["status_changed"])
                assert [r["activity_seq"] for r in sc] == [103, 105]

                # after_seq 증분.
                after = await poll_object_evidence(s, org, "story", story_a, after_seq=103)
                assert [r["activity_seq"] for r in after] == [105]

                # after_time 증분.
                at = await poll_object_evidence(s, org, "story", story_a, after_time=base + timedelta(minutes=3))
                assert [r["activity_seq"] for r in at] == [105]

                # AC③: 증거 없는 object → [] / None(빈=빈).
                empty_id = uuid.uuid4()
                assert await poll_object_evidence(s, org, "story", empty_id) == []
                assert await latest_object_evidence(s, org, "story", empty_id) is None
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(ActivityEvent.__table__.drop, checkfirst=True)
        await engine.dispose()
