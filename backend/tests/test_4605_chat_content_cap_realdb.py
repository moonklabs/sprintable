"""story #4605 — the chat send route (the one MCP send_chat_message and the web call) against a real PG: content at the bound is
kept (201), one byte over is 422 `message_too_long` with the limit and what came, and nothing of it is stored."""
from __future__ import annotations

import os
import uuid

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


async def _setup(session):
    """org + project + a human (members ⋈ project_access — team_members is a view) + a conversation they take part in"""
    from app.models.conversation import Conversation, ConversationParticipant
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.flush()
    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    member = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=user.id, name="Human")
    session.add(member)
    await session.flush()
    session.add(ProjectAccess(project_id=project.id, member_id=member.id, permission="granted", role="member"))
    await session.flush()
    conv = Conversation(id=uuid.uuid4(), org_id=org.id, project_id=project.id, type="group", created_by=member.id)
    session.add(conv)
    await session.flush()
    session.add(ConversationParticipant(conversation_id=conv.id, member_id=member.id))
    await session.commit()
    return org, user, conv


async def test_the_send_route_keeps_the_bound_and_refuses_one_byte_over_storing_nothing():
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import func, select

    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app
    from app.models.conversation import MESSAGE_CONTENT_MAX_BYTES as LIMIT, ConversationMessage
    from tests.conftest import override_db_and_read

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, user, conv = await _setup(s)

        async def _db():
            async with Session() as s:
                try:
                    yield s
                    await s.commit()
                except Exception:
                    await s.rollback()
                    raise

        async def _auth():
            return AuthContext(user_id=str(user.id), email="human@test", claims={"app_metadata": {"org_id": str(org.id)}})

        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth
        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        try:
            at = await client.post(f"/api/v2/conversations/{conv.id}/messages", json={"content": "a" * LIMIT})
            assert at.status_code == 201, at.text[:300]
            over = await client.post(f"/api/v2/conversations/{conv.id}/messages", json={"content": "a" * (LIMIT + 1)})
            assert over.status_code == 422, over.text[:300]
            err = over.json()["error"]
            assert (err["code"], err["limit"], err["got"]) == ("message_too_long", LIMIT, LIMIT + 1)
            # counted in bytes: 3-byte characters cross the line one character sooner
            korean = await client.post(f"/api/v2/conversations/{conv.id}/messages", json={"content": "가" * (LIMIT // 3 + 1)})
            assert korean.status_code == 422, korean.text[:300]
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            kept = (await s.execute(
                select(func.count()).select_from(ConversationMessage).where(ConversationMessage.conversation_id == conv.id)
            )).scalar_one()
        assert kept == 1, "only the message at the bound was stored"
    finally:
        await engine.dispose()
