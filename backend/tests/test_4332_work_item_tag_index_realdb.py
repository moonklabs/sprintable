"""story #4332 AC2 — 게이트 목록의 «태그된 대화» 조회(`derive_conversation_ids_for_tagged_work_items`)가 메시지 표를 전부 훑지 않는다.

dev 실측: 이 조회가 `Parallel Seq Scan on conversation_messages`(98,776행 · 69~169ms)로 게이트 목록 SQL 몫의 대부분이었고 메시지 표
크기에 비례했다. 0412 부분 표현식 인덱스 + 같은 식의 조회로 고친다.

- 결과: work item마다 캐폴러가 참여한 대화 중 **가장 최근** 태그의 대화(DISTINCT ON으로 바뀐 뒤에도 그대로).
- 계획: 함수가 실제로 낸 문장을 그대로 EXPLAIN — `enable_seqscan=off`에서 전체 스캔이 남으면 인덱스를 **쓸 수 없는** 것(식이 어긋남 ·
  부분 조건을 플래너가 증명 못 함 — 0384가 겪은 조용한 무효). 작은 시드에선 플래너가 전체 스캔을 고를 수 있어 이 설정으로 «쓸 수
  있는가»만 본다. 태그 없는 메시지를 늘려도 계획은 같다.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import event, text

from tests.test_1994_backlink_api_realdb import _make_org, _make_project, _session_factory
from tests.test_2288_command_center_gate_type_waiting_realdb import _make_member
from tests.test_2301_story_body_mentions_realdb import _REAL_DB_URL

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed(s, *, untagged: int):
    """(org, member, work_item, 옛 대화, 새 대화). 두 대화 모두 캐폴러 참여 · 같은 work item을 옛 대화가 먼저, 새 대화가 나중에 태그."""
    from datetime import UTC, datetime, timedelta

    from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant

    org = await _make_org(s)
    project = await _make_project(s, org.id)
    member_id, _ = await _make_member(s, org.id, project.id)
    convs = []
    for title in ("old", "new"):
        conv = Conversation(id=uuid.uuid4(), project_id=project.id, org_id=org.id, type="group", title=title, created_by=member_id)
        s.add(conv)
        await s.flush()
        s.add(ConversationParticipant(conversation_id=conv.id, member_id=member_id))
        convs.append(conv.id)
    work_item = uuid.uuid4()
    base = datetime(2026, 9, 1, tzinfo=UTC)

    def msg(conv_id, when, metadata):
        return ConversationMessage(
            id=uuid.uuid4(), conversation_id=conv_id, sender_id=member_id, content="m", msg_metadata=metadata, created_at=when,
        )

    s.add(msg(convs[0], base, {"work_item": {"type": "story", "id": str(work_item)}}))
    s.add(msg(convs[1], base + timedelta(hours=1), {"work_item": {"type": "story", "id": str(work_item)}}))
    s.add(msg(convs[0], base + timedelta(hours=2), {"work_item": {"type": "story", "id": str(uuid.uuid4())}}))  # 다른 work item
    for i in range(untagged):
        s.add(msg(convs[i % 2], base + timedelta(minutes=i), {"event": {"event_key": "x"}} if i % 3 == 0 else {}))
    await s.commit()
    return org.id, member_id, work_item, convs[0], convs[1]


async def test_latest_tagged_conversation_per_work_item():
    from app.services.work_item_conversation import derive_conversation_ids_for_tagged_work_items

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, member_id, work_item, _old, new = await _seed(s, untagged=30)
            other = uuid.uuid4()
            got = await derive_conversation_ids_for_tagged_work_items(
                s, org_id=org_id, member_id=member_id, work_item_pairs={("story", work_item), ("story", other)},
            )
        assert got == {("story", work_item): new}, "가장 최근 태그의 대화 · 태그 없는 work item은 키 없음"
    finally:
        await engine.dispose()


@pytest.mark.parametrize("untagged", [50, 1500])
async def test_tag_lookup_can_use_the_index_not_a_full_scan(untagged):
    from app.services.work_item_conversation import derive_conversation_ids_for_tagged_work_items

    engine, Session = await _session_factory()
    captured: list[tuple[str, object]] = []

    @event.listens_for(engine.sync_engine, "before_cursor_execute")
    def _grab(_conn, _cur, statement, parameters, _ctx, _many):
        if "FROM conversation_messages" in statement and "DISTINCT ON" in statement:
            captured.append((statement, parameters))

    try:
        async with Session() as s:
            org_id, member_id, work_item, _old, _new = await _seed(s, untagged=untagged)
            await derive_conversation_ids_for_tagged_work_items(
                s, org_id=org_id, member_id=member_id, work_item_pairs={("story", work_item)},
            )
        assert len(captured) == 1, "태그 조회 문장을 정확히 하나 잡아야 가드가 헛돌지 않는다"
        statement, parameters = captured[0]
        async with engine.connect() as conn:
            await conn.execute(text("SET enable_seqscan = off"))
            await conn.execute(text("ANALYZE conversation_messages"))
            plan = "\n".join(r[0] for r in (await conn.exec_driver_sql("EXPLAIN " + statement, parameters)).all())
        assert "ix_conversation_messages_work_item_tag" in plan, plan
        assert "Seq Scan on conversation_messages" not in plan, plan
    finally:
        await engine.dispose()
