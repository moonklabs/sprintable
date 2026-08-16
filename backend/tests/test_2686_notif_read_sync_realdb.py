"""story #2686(E-CHAT-REALTIME 축D): 채팅 read → event-notification read_at 동기 — realPG 통합 테스트.

«노티 받고 들어왔는데 잔상» 근본수정. 커버:
- AC1: 그 대화의 대화-이벤트 알림이 채팅 read 시 read_at 세팅.
- AC2(음성대조): 다른 대화 알림·비채팅 이벤트(story_assigned 등)는 불변.
- 과잉살상 방지(미르코 보강): up_to(GREATEST 래칫 후 값) 이후 생성된 메시지의 알림은 안 건드림.
- AC3: 멱등 — 이미 read_at 세팅된 알림 재갱신 0.
- SAVEPOINT 격리: 동기 실패(카디르 QA #3119 — 실 SQL 레벨 에러 주입)가 read-state 갱신
  자체를 조용히 삼키지 않는다(begin_nested 없으면 last_read_at이 세션 poison으로 유실됨).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

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


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_conversation(session, *, n_members: int = 2):
    from app.models.conversation import Conversation, ConversationParticipant
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    member_ids = []
    user_ids = []
    for i in range(n_members):
        user_id = uuid.uuid4()
        user = User(id=user_id, email=f"human-{user_id.hex[:8]}@test.com", hashed_password="x")
        session.add(user)
        await session.commit()
        m = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=user_id, name=f"Member{i}")
        session.add(m)
        await session.commit()
        session.add(ProjectAccess(
            id=uuid.uuid4(), project_id=project.id, member_id=m.id, permission="granted", role="member",
        ))
        await session.commit()
        member_ids.append(m.id)
        user_ids.append(user_id)

    conv = Conversation(
        id=uuid.uuid4(), project_id=project.id, org_id=org.id, type="group",
        title="Test convo", created_by=member_ids[0],
    )
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "conv_id": conv.id,
        "member_ids": member_ids, "user_ids": user_ids,
    }


async def _add_message(session, conv_id, sender_id, content: str, created_at: datetime):
    from app.models.conversation import ConversationMessage
    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv_id, sender_id=sender_id,
        content=content, created_at=created_at,
    )
    session.add(msg)
    await session.commit()
    return msg


async def _add_notification(
    session, *, org_id, project_id, recipient_id, event_type: str,
    source_entity_id=None, source_entity_type=None,
):
    from app.models.event import Event
    evt = Event(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        event_type=event_type, source_entity_type=source_entity_type,
        source_entity_id=source_entity_id, recipient_id=recipient_id,
        recipient_type="human", payload={},
    )
    session.add(evt)
    await session.commit()
    return evt


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(user_id), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


T0 = datetime(2026, 8, 16, 8, 0, 0, tzinfo=timezone.utc)


def _t(minutes: int) -> datetime:
    return T0 + timedelta(minutes=minutes)


@pytest.mark.anyio
async def test_chat_read_marks_that_conversation_notification_read():
    """AC1: 그 대화 메시지 알림이 채팅 read 시 read_at 세팅."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_conversation(s, n_members=2)
            me, other = seeded["member_ids"]
            msg = await _add_message(s, seeded["conv_id"], other, "hi", _t(1))
            notif = await _add_notification(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"],
                recipient_id=me, event_type="conversation.message_created",
                source_entity_id=msg.id, source_entity_type="conversation_message",
            )

        await _setup_app_human(app, Session, seeded["user_ids"][0], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/conversations/{seeded['conv_id']}/read",
                json={"up_to": _t(1).isoformat()},
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s2:
                from app.models.event import Event
                from sqlalchemy import select
                row = (await s2.execute(select(Event).where(Event.id == notif.id))).scalar_one()
                assert row.read_at is not None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_other_conversation_and_non_chat_notification_untouched():
    """AC2 음성대조: 다른 대화 알림·비채팅 이벤트는 불변."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_conversation(s, n_members=2)
            me, other = seeded["member_ids"]
            msg_this = await _add_message(s, seeded["conv_id"], other, "hi", _t(1))

            # 같은 org·같은 me가 참가한 별개 대화 — recipient_id만으론 안 걸러지는지 검증하려는
            # 것(다른 org면 recipient_id 자체가 안 겹쳐 약한 대조가 됨).
            from app.models.conversation import Conversation, ConversationParticipant
            conv_b = Conversation(
                id=uuid.uuid4(), project_id=seeded["project_id"], org_id=seeded["org_id"],
                type="group", title="Other convo", created_by=me,
            )
            s.add(conv_b)
            await s.flush()
            s.add(ConversationParticipant(conversation_id=conv_b.id, member_id=me))
            s.add(ConversationParticipant(conversation_id=conv_b.id, member_id=other))
            await s.commit()
            msg_conv_b = await _add_message(s, conv_b.id, other, "in other conv", _t(1))

            notif_this = await _add_notification(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"],
                recipient_id=me, event_type="conversation.message_created",
                source_entity_id=msg_this.id, source_entity_type="conversation_message",
            )
            notif_other_conv = await _add_notification(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"],
                recipient_id=me, event_type="conversation.message_created",
                source_entity_id=msg_conv_b.id, source_entity_type="conversation_message",
            )
            notif_non_chat = await _add_notification(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"],
                recipient_id=me, event_type="story_assigned",
                source_entity_id=None, source_entity_type=None,
            )

        await _setup_app_human(app, Session, seeded["user_ids"][0], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/conversations/{seeded['conv_id']}/read",
                json={"up_to": _t(1).isoformat()},
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s2:
                from app.models.event import Event
                from sqlalchemy import select
                this_row = (await s2.execute(select(Event).where(Event.id == notif_this.id))).scalar_one()
                other_conv_row = (await s2.execute(select(Event).where(Event.id == notif_other_conv.id))).scalar_one()
                non_chat_row = (await s2.execute(select(Event).where(Event.id == notif_non_chat.id))).scalar_one()
                assert this_row.read_at is not None
                assert other_conv_row.read_at is None
                assert non_chat_row.read_at is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_partial_read_does_not_overkill_future_message_notification():
    """미르코 보강(과잉살상 방지): up_to 이전 메시지만 read 처리, up_to 이후 메시지 알림은 불변."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_conversation(s, n_members=2)
            me, other = seeded["member_ids"]
            msg_past = await _add_message(s, seeded["conv_id"], other, "past", _t(1))
            msg_future = await _add_message(s, seeded["conv_id"], other, "future", _t(5))

            notif_past = await _add_notification(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"],
                recipient_id=me, event_type="conversation.message_created",
                source_entity_id=msg_past.id, source_entity_type="conversation_message",
            )
            notif_future = await _add_notification(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"],
                recipient_id=me, event_type="conversation.message_created",
                source_entity_id=msg_future.id, source_entity_type="conversation_message",
            )

        await _setup_app_human(app, Session, seeded["user_ids"][0], seeded["org_id"])
        client = _client_for(app)
        try:
            # 부분읽음 — msg_past까지만(up_to=_t(1)).
            resp = await client.post(
                f"/api/v2/conversations/{seeded['conv_id']}/read",
                json={"up_to": _t(1).isoformat()},
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s2:
                from app.models.event import Event
                from sqlalchemy import select
                past_row = (await s2.execute(select(Event).where(Event.id == notif_past.id))).scalar_one()
                future_row = (await s2.execute(select(Event).where(Event.id == notif_future.id))).scalar_one()
                assert past_row.read_at is not None
                assert future_row.read_at is None  # 과잉살상 방지 — 미래 메시지 알림은 그대로.
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mark_read_twice_is_idempotent_no_error():
    """AC3: 멱등 — 이미 read_at 세팅된 알림에 재호출해도 에러 없음(read_at IS NULL 필터로 0건 갱신)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_conversation(s, n_members=2)
            me, other = seeded["member_ids"]
            msg = await _add_message(s, seeded["conv_id"], other, "hi", _t(1))
            notif = await _add_notification(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"],
                recipient_id=me, event_type="conversation.message_created",
                source_entity_id=msg.id, source_entity_type="conversation_message",
            )

        await _setup_app_human(app, Session, seeded["user_ids"][0], seeded["org_id"])
        client = _client_for(app)
        try:
            resp1 = await client.post(
                f"/api/v2/conversations/{seeded['conv_id']}/read",
                json={"up_to": _t(1).isoformat()},
            )
            assert resp1.status_code == 200, resp1.text

            async with Session() as s2:
                from app.models.event import Event
                from sqlalchemy import select
                first_read_at = (await s2.execute(
                    select(Event.read_at).where(Event.id == notif.id)
                )).scalar_one()
            assert first_read_at is not None  # 첫 호출이 실제로 세팅했는지(약한 대조 방지).

            resp2 = await client.post(
                f"/api/v2/conversations/{seeded['conv_id']}/read",
                json={"up_to": _t(1).isoformat()},
            )
            assert resp2.status_code == 200, resp2.text

            async with Session() as s2:
                from app.models.event import Event
                from sqlalchemy import select
                second_read_at = (await s2.execute(
                    select(Event.read_at).where(Event.id == notif.id)
                )).scalar_one()

            assert first_read_at == second_read_at  # read_at IS NULL 필터로 재갱신 0.
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_notif_sync_failure_does_not_poison_read_state_update(monkeypatch):
    """SAVEPOINT 격리 실증(카디르 QA #3119) — 동기 실패가 read-state 갱신을 못 막아야 한다.

    bare Python raise는 SQLAlchemy 세션을 poison 안 시킨다(begin_nested 유무와 무관하게
    항상 통과해 이 테스트가 무의미해짐) — 실 DBAPI 에러(SELECT 1/0)를 주입해야 진짜
    poison이 재현된다. begin_nested 없이 이 에러가 나면 이후 UPDATE(ConversationParticipant.
    last_read_at)까지 poisoned 트랜잭션에 실려 조용히 사라진다(200 응답인데 저장 안 됨 —
    [[feedback_aborted_txn_silent_commit_class]] 동형)."""
    from app.main import app
    from sqlalchemy import text

    async def _boom(db, org_id, conversation_id, member_id, up_to):
        await db.execute(text("SELECT 1/0"))
        return 0

    monkeypatch.setattr(
        "app.routers.event_notifications.sync_notification_read_on_chat_read", _boom,
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_conversation(s, n_members=2)
            me, other = seeded["member_ids"]
            await _add_message(s, seeded["conv_id"], other, "hi", _t(1))

        await _setup_app_human(app, Session, seeded["user_ids"][0], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/conversations/{seeded['conv_id']}/read",
                json={"up_to": _t(1).isoformat()},
            )
            assert resp.status_code == 200, resp.text

            async with Session() as s2:
                from app.models.conversation import ConversationParticipant
                from sqlalchemy import select
                participant = (await s2.execute(
                    select(ConversationParticipant).where(
                        ConversationParticipant.conversation_id == seeded["conv_id"],
                        ConversationParticipant.member_id == me,
                    )
                )).scalar_one()
                # SAVEPOINT가 격리하므로 동기 실패와 무관하게 read-state는 실제로 저장돼야 한다.
                assert participant.last_read_at is not None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
