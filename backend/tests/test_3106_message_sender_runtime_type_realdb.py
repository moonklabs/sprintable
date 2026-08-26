"""story #3106(#3092 후속·선생님 실화면 지적, 2026-08-26) — 챗 메시지 payload의 sender에
runtime_type이 실려 나오는지 실PG 검증. Presence(team-presence-panel)는 이미 뜨는데 챗은
«Agent» 폴백에 머무는 갭 — 원인은 BE list_messages/get_message/list_message_replies가
쓰는 sender payload에 이 필드가 없었던 것(_msg_payload additive 배선, conversations.py).

범위: agent sender는 seed한 runtime_type 값이 그대로, human sender는 항상 None(additive,
기존 shape 비파괴) — 세 read 엔드포인트(목록·단건·replies) 전부 동형으로 확인한다.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

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

    # story #2451(§6 Phase3) — get_db만 걸면 get_read_db를 놓치는 재발 클래스를 구조적으로
    # 막는 정본 헬퍼(tests/conftest.py). raw dependency_overrides[get_db]=... 직접대입 금지.
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


async def _setup(session):
    """org + project + human(viewer, participant) + agent(runtime_type=claude_code, participant)
    + conversation. team_members는 뷰(members ⋈ project_access)라 Member ORM에 직접 쓴다
    (test_2263/test_2009와 동일 규율 — TeamMember로 직접 add하면 CI의 migrated 스키마에서
    「cannot insert into view」로 죽는다)."""
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.member import Member
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from app.models.conversation import Conversation, ConversationParticipant

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.flush()

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    human = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=user.id, name="Human")
    session.add(human)
    await session.flush()
    session.add(ProjectAccess(project_id=project.id, member_id=human.id, permission="granted", role="member"))

    agent = Member(
        id=uuid.uuid4(), org_id=org.id, type="agent", name="Bot",
        runtime_type="claude_code", is_active=True,
    )
    session.add(agent)
    await session.flush()
    session.add(ProjectAccess(project_id=project.id, member_id=agent.id, permission="granted", role="member"))
    await session.flush()

    conv = Conversation(id=uuid.uuid4(), org_id=org.id, project_id=project.id, type="group", created_by=human.id)
    session.add(conv)
    await session.flush()
    session.add(ConversationParticipant(conversation_id=conv.id, member_id=human.id))
    session.add(ConversationParticipant(conversation_id=conv.id, member_id=agent.id))
    await session.commit()
    return org, project, human, user, agent, conv


async def _make_message(session, conv_id, sender_id, content, *, thread_id=None):
    from app.models.conversation import ConversationMessage
    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv_id, sender_id=sender_id, content=content,
        thread_id=thread_id, created_at=datetime(2026, 8, 26, 9, 0, tzinfo=timezone.utc),
    )
    session.add(msg)
    if thread_id is not None:
        from sqlalchemy import select
        parent = (await session.execute(
            select(ConversationMessage).where(ConversationMessage.id == thread_id)
        )).scalar_one()
        parent.reply_count += 1
    await session.commit()
    return msg


async def test_list_messages_sender_runtime_type():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project, human, user, agent, conv = await _setup(s)
            agent_msg = await _make_message(s, conv.id, agent.id, "agent says hi")
            human_msg = await _make_message(s, conv.id, human.id, "human says hi")

        from app.main import app
        await _setup_app_human(app, Session, user.id, org.id)
        try:
            async with _client_for(app) as c:
                resp = await c.get(f"/api/v2/conversations/{conv.id}/messages")
            assert resp.status_code == 200, resp.text
            by_id = {m["id"]: m for m in resp.json()["data"]}
            assert by_id[str(agent_msg.id)]["sender"]["runtime_type"] == "claude_code"
            assert by_id[str(human_msg.id)]["sender"]["runtime_type"] is None
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_get_message_sender_runtime_type():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project, human, user, agent, conv = await _setup(s)
            agent_msg = await _make_message(s, conv.id, agent.id, "agent says hi")

        from app.main import app
        await _setup_app_human(app, Session, user.id, org.id)
        try:
            async with _client_for(app) as c:
                resp = await c.get(f"/api/v2/conversations/{conv.id}/messages/{agent_msg.id}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["sender"]["runtime_type"] == "claude_code"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_list_message_replies_sender_runtime_type():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project, human, user, agent, conv = await _setup(s)
            root = await _make_message(s, conv.id, human.id, "root")
            reply = await _make_message(s, conv.id, agent.id, "agent reply", thread_id=root.id)

        from app.main import app
        await _setup_app_human(app, Session, user.id, org.id)
        try:
            async with _client_for(app) as c:
                resp = await c.get(f"/api/v2/conversations/{conv.id}/messages/{root.id}/replies")
            assert resp.status_code == 200, resp.text
            by_id = {m["id"]: m for m in resp.json()["data"]}
            assert by_id[str(reply.id)]["sender"]["runtime_type"] == "claude_code"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
