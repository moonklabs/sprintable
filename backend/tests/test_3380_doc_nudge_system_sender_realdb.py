"""story #3380(BE·결함·감사 신뢰, 페드루 PO 確定 2026-09-07, 담롱 실사고) — 제품이 생성하는
draft-doc 채팅 넛지("결재 상신하시겠습니까?")가 그 문장을 쓰지 않은 「대화 참가자(mention을
트리거한 사람)」 이름을 sender로 달고 나갔다(Sprintable 원본=댄·채널 릴레이 표시=담롱,
둘 다 안 쓴 문장 — 두 층이 서로 다른 사람을 가리키는 이중 오귀속이었다).

처방: `_get_or_create_system_publisher`(events.py, story #2791 — 새 개념 발명 0,
recipe_repeat_scheduler.py::_notify_owner_paused와 동형 재사용)가 반환하는 org당 1개
「시스템 발행」 anchor member로 (a) ConversationMessage.sender_id (b) `_dispatch_
conversation_event`에 넘기는 sender 인자(=Event.payload.sender·채널 릴레이가 읽는
바로 그 필드) 둘 다 고정한다. 트리거한 사람은 msg_metadata.triggered_by_member_id로만
남는다(sender 명의를 안 빌림). 감사축(activity_logs)도 actor_type="platform"·
actor_id=None(channel_posts.py 등 기존 platform-action 관례 재사용, 새 actor 유형 0).

`_get_or_create_system_publisher`가 실 alembic 마이그(0258)의 부분 유니크 인덱스
(ON CONFLICT 대상)에 의존해 test_2747의 create_all 하네스(team_members=평범한 물리
테이블로 만드는 관례)와 안 맞는다(그 인덱스는 raw op.execute라 ORM 모델 메타데이터에
없어 create_all이 못 만든다, 실측 확認) — 이 파일은 실 alembic 스키마 대상 하네스
(test_2301_story_body_mentions_realdb.py·test_2288_command_center_gate_type_waiting_
realdb.py 재사용, team_members는 그쪽 관례대로 진짜 VIEW)로 간다."""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from tests.test_2301_story_body_mentions_realdb import _REAL_DB_URL, _make_org, _make_project, _session_factory
from tests.test_2288_command_center_gate_type_waiting_realdb import _make_member

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _seed_doc(session, org_id, project_id, author_id, *, status="draft", title="Doc"):
    from app.models.doc import Doc

    doc = Doc(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, created_by=author_id,
        status=status, title=title, slug=f"{title.lower()}-{uuid.uuid4().hex[:8]}",
    )
    session.add(doc)
    await session.commit()
    return doc.id


async def _get_nudge_message_and_event(session, doc_id):
    from app.models.conversation import ConversationMessage
    from app.models.event import Event

    msg = (await session.execute(
        select(ConversationMessage).where(
            ConversationMessage.msg_metadata["nudge_target"]["doc_id"].astext == str(doc_id),
        )
    )).scalars().one()
    event = (await session.execute(
        select(Event).where(Event.source_entity_id == msg.id)
    )).scalars().first()
    return msg, event


@pytest.mark.anyio
async def test_nudge_sender_is_system_publisher_not_human_trigger():
    """AC — 인간이 draft doc을 mention해도 넛지 sender는 시스템 발행자, 트리거한 사람은
    msg_metadata에만 남는다. 채널 릴레이(Event.payload.sender)도 같은 신원이어야 한다."""
    from app.routers.events import _get_or_create_system_publisher

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            author_id, _ = await _make_member(s, org.id, project.id)
            trigger_id, _ = await _make_member(s, org.id, project.id)
            doc_id = await _seed_doc(s, org.id, project.id, author_id)
            system_publisher = await _get_or_create_system_publisher(s, org.id)
            await s.commit()
            system_publisher_id = system_publisher.id

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat
        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org.id, project_id=project.id, doc_id=doc_id,
                doc_title="온보딩 리서치", doc_status="draft",
                doc_author_id=author_id, sender_id=trigger_id,
            )
            await s.commit()

        async with Session() as s:
            msg, event = await _get_nudge_message_and_event(s, doc_id)
            assert msg.sender_id == system_publisher_id, "Sprintable 원본 sender가 여전히 트리거한 사람이다"
            assert msg.sender_id != trigger_id
            assert msg.sender_id != author_id
            assert msg.msg_metadata["triggered_by_member_id"] == str(trigger_id), "트리거 감사 추적 누락"

            assert event is not None, "채널 릴레이가 읽는 Event 행이 없다"
            assert event.sender_id == system_publisher_id
            assert event.payload["sender"]["id"] == str(system_publisher_id), (
                "채널 릴레이 표시(Event.payload.sender)가 Sprintable 원본과 다르다"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_nudge_sender_is_system_publisher_when_trigger_is_agent():
    """AC — 트리거가 에이전트여도(대화 참가자 이름을 빌리는 원 사고가 담롱 케이스에서
    에이전트였다) 결과는 동일하게 시스템 발행자."""
    from app.routers.events import _get_or_create_system_publisher

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            author_id, _ = await _make_member(s, org.id, project.id)
            trigger_agent_id, _ = await _make_member(s, org.id, project.id, type_="agent")
            doc_id = await _seed_doc(s, org.id, project.id, author_id)
            system_publisher = await _get_or_create_system_publisher(s, org.id)
            await s.commit()
            system_publisher_id = system_publisher.id

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat
        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org.id, project_id=project.id, doc_id=doc_id,
                doc_title="온보딩 리서치", doc_status="draft",
                doc_author_id=author_id, sender_id=trigger_agent_id,
            )
            await s.commit()

        async with Session() as s:
            msg, event = await _get_nudge_message_and_event(s, doc_id)
            assert msg.sender_id == system_publisher_id
            assert msg.msg_metadata["triggered_by_member_id"] == str(trigger_agent_id)
            assert event.payload["sender"]["id"] == str(system_publisher_id)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_nudge_writes_platform_activity_log():
    """AC — 감사축(activity_logs)도 actor_type="platform"·actor_id=None."""
    from app.models.activity_log import ActivityLog
    from app.routers.events import _get_or_create_system_publisher

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            author_id, _ = await _make_member(s, org.id, project.id)
            trigger_id, _ = await _make_member(s, org.id, project.id)
            doc_id = await _seed_doc(s, org.id, project.id, author_id)
            await _get_or_create_system_publisher(s, org.id)
            await s.commit()

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat
        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org.id, project_id=project.id, doc_id=doc_id,
                doc_title="온보딩 리서치", doc_status="draft",
                doc_author_id=author_id, sender_id=trigger_id,
            )
            await s.commit()

        async with Session() as s:
            log = (await s.execute(
                select(ActivityLog).where(
                    ActivityLog.entity_type == "doc", ActivityLog.entity_id == doc_id,
                    ActivityLog.action == "doc_chat_nudge_sent",
                )
            )).scalars().one()
            assert log.actor_type == "platform"
            assert log.actor_id is None
            assert log.context["triggered_by_member_id"] == str(trigger_id)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_reverting_sender_to_trigger_id_fails(monkeypatch):
    """뮤테이션 — sender를 트리거로 되돌리면(옛 결함 재현) 이 테스트가 RED가 되는 것을
    고정한다(위 positive 테스트들이 실제로 그 결함을 잡는다는 증거)."""
    from app.routers.events import _get_or_create_system_publisher

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            author_id, _ = await _make_member(s, org.id, project.id)
            trigger_id, _ = await _make_member(s, org.id, project.id)
            doc_id = await _seed_doc(s, org.id, project.id, author_id)
            await _get_or_create_system_publisher(s, org.id)
            await s.commit()

        class _TriggerAsSystemPublisher:
            id = trigger_id
            name = "Trigger"
            type = "human"
            avatar_url = None
            runtime_type = None

        async def _revert_to_trigger(db, org_id):
            return _TriggerAsSystemPublisher()

        # approval_delivery.py는 함수 안에서 `from app.routers.events import
        # _get_or_create_system_publisher`를 그때그때 부른다(지연 import) — 원본 모듈
        # 속성을 갈아끼우면 다음 호출부터 대역이 잡힌다(3635 뮤테이션 테스트와 동형 관례).
        import app.routers.events as events_module
        monkeypatch.setattr(events_module, "_get_or_create_system_publisher", _revert_to_trigger)

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat
        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org.id, project_id=project.id, doc_id=doc_id,
                doc_title="온보딩 리서치", doc_status="draft",
                doc_author_id=author_id, sender_id=trigger_id,
            )
            await s.commit()

        async with Session() as s:
            msg, _event = await _get_nudge_message_and_event(s, doc_id)
            assert msg.sender_id == trigger_id, "뮤테이션이 걸리지 않았다(sender가 여전히 시스템 발행자)"
    finally:
        await engine.dispose()
