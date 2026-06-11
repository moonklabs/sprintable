"""L1 BE-7: 회귀/끝단 E2E — fan-out 수렴 정규화 정확도 가드(블루프린트 §5·§6).

handler가 만드는 모양의 events를 seed해 extractor(upsert_activity_from_events)로 수렴시키고
①conversation 3 fan-out→1행 ②story_status→canonical 1행 ③dispatched wrapper verb 변환을
검증한다. FK는 SET session_replication_role=replica로 비활성(seed 편의·CI 실 스키마+로컬 공용).

④ /api/v2/agent/stream ACK·recipient_seq·wake, ⑤ event-notifications(events 기반)는 별도
신규 가드가 아니라 **기존 스위트가 그대로 통과**하는 것으로 회귀 보장한다(BE-3 hook은 best-effort
SAVEPOINT라 delivery 무영향 — test_eventbus/test_event_inject/test_event_notifications 참조).

PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL 없으면 skip(CI alembic-fresh-db 잡).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import select, text

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


_SEED_EVENT = text(
    "INSERT INTO events (id, org_id, project_id, event_type, source_entity_type, source_entity_id,"
    " sender_id, recipient_id, recipient_type, payload, status, created_at)"
    " VALUES (:id,:org,:proj,:et,:set,:sid,:snd,:rid,:rt,CAST(:pl AS jsonb),'pending',:ts)"
)


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_ASYNC_URL)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def test_l1_fanout_convergence_and_verb_transform():
    import json

    from app.models.activity_event import ActivityEvent
    from app.services.activity_stream import upsert_activity_from_events

    engine, Session = await _session()
    org, proj = uuid.uuid4(), uuid.uuid4()
    conv_msg, story, memo = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    sender = uuid.uuid4()
    try:
        async with Session() as s:
            await s.execute(text("SET session_replication_role = replica"))  # FK 비활성(seed)

            async def seed(eid, et, set_, sid, snd, rid, rt, pl):
                await s.execute(_SEED_EVENT, {
                    "id": eid, "org": org, "proj": proj, "et": et, "set": set_, "sid": sid,
                    "snd": snd, "rid": rid, "rt": rt, "pl": json.dumps(pl), "ts": TS,
                })

            # ① conversation.message_created — 참여자 3 fan-out(같은 메시지·payload·created_at).
            conv_ids = [uuid.uuid4() for _ in range(3)]
            conv_pl = {"message_id": str(conv_msg), "body": "hi"}
            for eid, (rid, rt) in zip(conv_ids, [(uuid.uuid4(), "human"), (uuid.uuid4(), "agent"), (uuid.uuid4(), "human")]):
                await seed(eid, "conversation.message_created", "conversation_message", conv_msg, sender, rid, rt, conv_pl)

            # ② story_status_changed — assignee + actor notification(같은 전이·2 recipient).
            story_ids = [uuid.uuid4(), uuid.uuid4()]
            story_pl = {"status": "done", "old_status": "in-progress"}
            for eid, rid in zip(story_ids, [uuid.uuid4(), uuid.uuid4()]):
                await seed(eid, "story_status_changed", "story", story, sender, rid, "human", story_pl)

            # ③ dispatched wrapper — verb는 payload.event_type로 변환돼야.
            disp_id = uuid.uuid4()
            await seed(disp_id, "dispatched", "memo", memo, None, uuid.uuid4(), "agent",
                       {"title": "t", "event_type": "memo_replied"})
            await s.commit()

            await s.execute(text("SET session_replication_role = replica"))
            await upsert_activity_from_events(s, conv_ids + story_ids + [disp_id])
            await s.commit()

            acts = (await s.execute(select(ActivityEvent).where(ActivityEvent.org_id == org))).scalars().all()
            by_obj = {a.object_id: a for a in acts}

            # ① 3 fan-out → 1행·source 3·verb 그대로.
            a_conv = by_obj[conv_msg]
            assert len(set(a_conv.source_event_ids)) == 3
            assert a_conv.verb == "conversation.message_created"
            assert a_conv.actor_id == sender

            # ② assignee+actor → canonical 1행·source 2.
            a_story = by_obj[story]
            assert len(set(a_story.source_event_ids)) == 2
            assert a_story.verb == "story_status_changed"

            # ③ dispatched → verb 변환.
            a_disp = by_obj[memo]
            assert a_disp.verb == "memo_replied"
            assert "title" in a_disp.payload  # canonical payload 보존

            # 총 3 활동(중복 0 — 같은 fan-out은 canonical 1행).
            assert len(acts) == 3

            await s.rollback()
    finally:
        await engine.dispose()
