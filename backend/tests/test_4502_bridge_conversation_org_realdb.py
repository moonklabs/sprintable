"""story #4502 (4500's leftover) — a messaging bridge mapping's conversation id is written by hand (no API writes
`messaging_bridge_channels` rows). One that points at another org's conversation is refused before the author joins it or
posts; the org's own conversation is posted to as before.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
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
    url = _REAL_DB_URL or ""
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _world():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models.conversation import Conversation
    from app.models.organization import Organization
    from app.models.project import Project

    engine = create_async_engine(_async_url())
    Session = async_sessionmaker(engine, expire_on_commit=False)
    ids = {}
    async with Session() as s:
        for key in ("a", "b"):
            org = Organization(id=uuid.uuid4(), name=f"브리지 {key}", slug=f"bridge-{key}-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.flush()
            project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
            s.add(project)
            await s.flush()
            conv = Conversation(id=uuid.uuid4(), org_id=org.id, project_id=project.id, type="group")
            s.add(conv)
            ids[key] = (org.id, conv.id)
        await s.commit()
    return engine, Session, ids


async def _rows(Session, conv_id, author):
    from sqlalchemy import func, select

    from app.models.conversation import ConversationMessage, ConversationParticipant

    async with Session() as s:
        msgs = (await s.execute(select(func.count()).select_from(ConversationMessage).where(
            ConversationMessage.conversation_id == conv_id))).scalar_one()
        parts = (await s.execute(select(func.count()).select_from(ConversationParticipant).where(
            ConversationParticipant.conversation_id == conv_id, ConversationParticipant.member_id == author))).scalar_one()
    return msgs, parts


async def test_a_mapping_pointing_at_another_orgs_conversation_posts_nothing_there():
    from app.routers.bridge import _inbound_to_conversation

    engine, Session, ids = await _world()
    try:
        org_a, conv_a = ids["a"]
        _org_b, conv_b = ids["b"]
        author = uuid.uuid4()  # the mapping's org-A author (found by the mapping's org)
        async with Session() as s:
            result = await _inbound_to_conversation(s, conv_b, author, "안녕", None, message_ts="1.0", org_id=org_a)
            await s.commit()
        assert result == {"action": "error", "detail": "conversation_not_in_org"}
        assert await _rows(Session, conv_b, author) == (0, 0)  # no message, the author did not join
        # control: the mapping's own org's conversation is posted to as before
        async with Session() as s:
            result = await _inbound_to_conversation(s, conv_a, author, "안녕", None, message_ts="2.0", org_id=org_a)
            await s.commit()
        assert result["action"] == "conversation_message_created"
        assert await _rows(Session, conv_a, author) == (1, 1)
    finally:
        await engine.dispose()
