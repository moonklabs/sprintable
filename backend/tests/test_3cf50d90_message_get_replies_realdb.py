"""story 3cf50d90: 채팅 메시지 단건 원문 조회(GET /messages/{id})·리플 서브리소스
(GET /messages/{id}/replies) 실증 — 인가(참여자 전용) + 타 conversation 격리.

근본: 게이트/QA 리플이 웹훅 payload 잘림으로 도달하면 원문을 재조회할 경로가 없어
"잘렸다·재발신" 왕복이 반복됐다(도그푸딩 실사용 갭). list_messages의 `?thread_id=`는
있었지만 단건 GET(top-level+리플 공용)과 discoverable한 replies 서브리소스가 부재했다.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
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


async def _seed_human(session, org_id, project_id):
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user_id = uuid.uuid4()
    user = User(id=user_id, email=f"human-{user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role="member")
    session.add(om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, org_member_id=om.id, permission="granted",
    ))
    await session.commit()
    return user_id, om.id


async def _seed(session):
    """org + project + human_a(conv_1 참가자) + human_b(project 접근권만·conv_1 비참가자).

    conv_1: top-level 메시지 1 + 그 리플 1(human_a 발신).
    conv_2: human_b 소유 대화의 메시지 1(cross-conversation 격리 검증용).
    """
    from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="3cf50d90 Org", slug=f"3cf50d90-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    user_a, om_a_id = await _seed_human(session, org.id, project.id)
    user_b, om_b_id = await _seed_human(session, org.id, project.id)

    conv_1 = Conversation(
        id=uuid.uuid4(), project_id=project.id, org_id=org.id, type="group", created_by=om_a_id,
    )
    session.add(conv_1)
    await session.flush()
    session.add(ConversationParticipant(conversation_id=conv_1.id, member_id=om_a_id))
    await session.commit()

    conv_2 = Conversation(
        id=uuid.uuid4(), project_id=project.id, org_id=org.id, type="group", created_by=om_b_id,
    )
    session.add(conv_2)
    await session.flush()
    session.add(ConversationParticipant(conversation_id=conv_2.id, member_id=om_b_id))
    await session.commit()

    top = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv_1.id, sender_id=om_a_id, content="원문 최상위 메시지",
    )
    session.add(top)
    await session.flush()
    reply = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv_1.id, sender_id=om_a_id, content="원문 리플 메시지",
        thread_id=top.id,
    )
    session.add(reply)
    await session.commit()

    other_msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv_2.id, sender_id=om_b_id, content="다른 대화의 메시지",
    )
    session.add(other_msg)
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id,
        "user_a": user_a, "user_b": user_b,
        "conv_1_id": conv_1.id, "conv_2_id": conv_2.id,
        "top_id": top.id, "reply_id": reply.id, "other_msg_id": other_msg.id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

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
            user_id=str(user_id), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_get_message_200_top_level_participant():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["user_a"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/conversations/{seeded['conv_1_id']}/messages/{seeded['top_id']}"
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["content"] == "원문 최상위 메시지"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_message_200_reply_participant():
    """핵심 회귀: 리플 메시지도 단건 GET으로 원문 조회 가능(기존엔 404)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["user_a"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/conversations/{seeded['conv_1_id']}/messages/{seeded['reply_id']}"
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["content"] == "원문 리플 메시지"
            assert body["thread_id"] == str(seeded["top_id"])
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_message_403_non_participant():
    """human_b는 project 접근권은 있으나 conv_1 참가자가 아님 → 403(project-access 통과 후 참가자 체크에서 차단)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["user_b"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/conversations/{seeded['conv_1_id']}/messages/{seeded['top_id']}"
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_message_404_cross_conversation():
    """other_msg는 conv_2 소속 — conv_1 URL로 조회하면 404(권한 경계: 타 conversation 차단)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["user_a"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/conversations/{seeded['conv_1_id']}/messages/{seeded['other_msg_id']}"
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_message_replies_200_returns_only_replies():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["user_a"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/conversations/{seeded['conv_1_id']}/messages/{seeded['top_id']}/replies"
            )
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            assert len(data) == 1
            assert data[0]["id"] == str(seeded["reply_id"])
            assert data[0]["content"] == "원문 리플 메시지"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_message_replies_403_non_participant():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["user_b"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/conversations/{seeded['conv_1_id']}/messages/{seeded['top_id']}/replies"
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
