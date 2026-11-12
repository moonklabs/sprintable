"""story #4903 — a room's `latest_message` (the one-line preview of the room list) is the newest message that is NOT deleted, and it names itself (`id`).

Found on dev (QA lens, 11-12): the list picked the newest message ROW, a tombstone included — so a room whose last message was deleted answered an empty `content`
(the screen drew «no message») although older messages were still there. Now the newest message that is still there is the preview; all deleted → no latest message
(«no message», as for an empty room); and the preview carries the message's `id` (the web tells two messages of one microsecond apart, and matches a delete by it).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_conversation,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)

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


async def _as(app, Session, user_id, org_id, fn):
    await _setup_app_human(app, Session, user_id, org_id)
    try:
        async with _client_for(app) as client:
            return await fn(client)
    finally:
        app.dependency_overrides.clear()


async def _room_with(Session, texts):
    """a room of two people (A · B) with these messages from A, one minute apart (oldest first); returns the ids"""
    from tests.test_1994_backlink_api_realdb import _add_message

    async with Session() as session:
        org = await _make_org(session)
        project = await _make_project(session, org.id)
        a_id, a_user = await _make_human_member(session, org.id, project.id)
        b_id, b_user = await _make_human_member(session, org.id, project.id)
        conv_id = await _make_conversation(session, org.id, project.id, [a_id, b_id], a_id)
        base = datetime.now(timezone.utc) - timedelta(hours=1)
        ids = []
        for i, text in enumerate(texts):
            msg = await _add_message(session, conv_id, a_id, text, base + timedelta(minutes=i))
            ids.append(str(msg.id))
    return org.id, conv_id, a_user, b_user, ids


async def _latest_of(app, Session, user, org_id, conv_id):
    r = await _as(app, Session, user, org_id, lambda c: c.get(f"/api/v2/conversations?project_id={_project_of[conv_id]}&limit=30&offset=0"))
    assert r.status_code == 200, r.text
    row = next((c for c in r.json()["data"] if c["id"] == str(conv_id)), None)
    assert row is not None, "the room is in its own list"
    return row["latest_message"]


_project_of: dict = {}


async def _project(Session, conv_id):
    from sqlalchemy import select

    from app.models.conversation import Conversation

    async with Session() as session:
        _project_of[conv_id] = (await session.execute(select(Conversation.project_id).where(Conversation.id == conv_id))).scalar_one()


async def _delete(app, Session, user, org_id, conv_id, msg_id):
    d = await _as(app, Session, user, org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
    assert d.status_code == 200, d.text


async def test_the_preview_is_the_newest_message_that_is_still_there_and_it_names_itself():
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, a_user, b_user, ids = await _room_with(Session, ["먼저 보낸 글", "나중에 보낸 글"])
        await _project(Session, conv_id)
        from app.main import app

        before = await _latest_of(app, Session, b_user, org_id, conv_id)
        assert before["content"] == "나중에 보낸 글" and before["id"] == ids[1], before  # the id names the message

        await _delete(app, Session, a_user, org_id, conv_id, ids[1])  # the LATEST message is deleted
        after = await _latest_of(app, Session, b_user, org_id, conv_id)
        assert after is not None and after["content"] == "먼저 보낸 글" and after["id"] == ids[0], f"the newest message that is still there: {after}"
    finally:
        await engine.dispose()


async def test_a_room_whose_messages_are_all_deleted_has_no_latest_message():
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, a_user, b_user, ids = await _room_with(Session, ["첫 글", "둘째 글"])
        await _project(Session, conv_id)
        from app.main import app

        await _delete(app, Session, a_user, org_id, conv_id, ids[1])
        await _delete(app, Session, a_user, org_id, conv_id, ids[0])
        assert await _latest_of(app, Session, b_user, org_id, conv_id) is None  # «no message», as for an empty room
    finally:
        await engine.dispose()


async def test_deleting_an_older_message_leaves_the_preview_alone():
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, a_user, b_user, ids = await _room_with(Session, ["오래된 글", "최신 글"])
        await _project(Session, conv_id)
        from app.main import app

        await _delete(app, Session, a_user, org_id, conv_id, ids[0])
        latest = await _latest_of(app, Session, b_user, org_id, conv_id)
        assert latest["content"] == "최신 글" and latest["id"] == ids[1], latest
    finally:
        await engine.dispose()


async def test_two_messages_of_the_same_microsecond_pick_one_stable_latest_by_id():
    """codex (5653): `ORDER BY created_at DESC` alone leaves a tie to the planner while the preview names an `id` — the larger id wins, whichever row sits first.
    The two rows swap which one holds the larger id (an UPDATE moves a row to a new physical place): without the tie-break one of the two cases returns the smaller id."""
    from sqlalchemy import text, update

    from app.models.conversation import ConversationMessage

    tail = uuid.uuid4().hex[-12:]  # the test database is shared between runs: the ids must not repeat
    HIGH = f"ffffffff-ffff-4fff-8fff-{tail}"
    LOW = f"00000000-0000-4000-8000-{tail}"
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, a_user, b_user, ids = await _room_with(Session, ["첫째", "둘째"])
        await _project(Session, conv_id)
        async with Session() as session:  # the same microsecond for both
            moment = datetime.now(timezone.utc) - timedelta(minutes=5)
            await session.execute(update(ConversationMessage).where(ConversationMessage.conversation_id == conv_id).values(created_at=moment))
            await session.commit()
        from app.main import app

        first, second = ids
        for (id_first, id_second) in ((HIGH, LOW), (LOW, HIGH)):
            async with Session() as session:
                # park both ids out of the way first (the primary key cannot hold two equal values mid-swap)
                await session.execute(text("UPDATE conversation_messages SET id = gen_random_uuid() WHERE conversation_id = :c"), {"c": str(conv_id)})
                rows = (await session.execute(text("SELECT id FROM conversation_messages WHERE conversation_id = :c ORDER BY ctid"), {"c": str(conv_id)})).scalars().all()
                assert len(rows) == 2
                await session.execute(text("UPDATE conversation_messages SET id = :n WHERE id = :o"), {"n": id_first, "o": str(rows[0])})
                await session.execute(text("UPDATE conversation_messages SET id = :n WHERE id = :o"), {"n": id_second, "o": str(rows[1])})
                await session.commit()
            latest = await _latest_of(app, Session, b_user, org_id, conv_id)
            assert latest["id"] == HIGH, (latest, id_first, id_second)
    finally:
        await engine.dispose()
