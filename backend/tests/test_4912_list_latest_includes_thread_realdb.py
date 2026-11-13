"""4912 follow-up (PO 11-13, decided) — a thread reply counts as the room's latest message.

The room list's `latest_message` is the newest message that is still there, thread replies INCLUDED (the room's own body shows top-level messages only, so a reply can be a preview the room itself does not draw).
The same rule moves the row's time and place (`updated_at`) and its unread count (every message counts) — all four read «a thread reply is new activity in the room». This file pins that shape so the next person
does not have to dig «is it a defect?» again: a reply newer than the last top-level message IS the preview; and the unread count counts it too. Changing it is a product decision about how thread activity shows in
the list (PO), not a fix.
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


async def _room_with_a_thread(Session):
    """a room of two people (A · B): a top-level message from A, then a THREAD REPLY to it from A one minute later; returns the ids"""
    from app.models.conversation import ConversationMessage
    from tests.test_1994_backlink_api_realdb import _add_message

    async with Session() as session:
        org = await _make_org(session)
        project = await _make_project(session, org.id)
        a_id, a_user = await _make_human_member(session, org.id, project.id)
        b_id, b_user = await _make_human_member(session, org.id, project.id)
        conv_id = await _make_conversation(session, org.id, project.id, [a_id, b_id], a_id)
        base = datetime.now(timezone.utc) - timedelta(hours=1)
        top = await _add_message(session, conv_id, a_id, "방에 보이는 최상위 글", base)
        reply = ConversationMessage(
            id=uuid.uuid4(), conversation_id=conv_id, sender_id=a_id, content="스레드 안의 더 새 답글",
            created_at=base + timedelta(minutes=1), thread_id=top.id,
        )
        session.add(reply)
        await session.commit()
    return org.id, project.id, conv_id, b_user, str(top.id), str(reply.id)


async def _row_for(app, Session, user, org_id, project_id, conv_id):
    await _setup_app_human(app, Session, user, org_id)
    try:
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/conversations?project_id={project_id}&limit=30&offset=0")
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 200, r.text
    row = next((c for c in r.json()["data"] if c["id"] == str(conv_id)), None)
    assert row is not None, "the room is in its own list"
    return row


async def test_a_thread_reply_newer_than_the_last_top_level_message_is_the_preview():
    engine, Session = await _session_factory()
    try:
        org_id, project_id, conv_id, b_user, top_id, reply_id = await _room_with_a_thread(Session)
        from app.main import app

        row = await _row_for(app, Session, b_user, org_id, project_id, conv_id)
        latest = row["latest_message"]
        assert latest is not None and latest["id"] == reply_id and latest["content"] == "스레드 안의 더 새 답글", (
            f"the reply (not the older top-level message) is the preview — the same rule as the row's time and unread count: {latest}"
        )
        assert latest["id"] != top_id
    finally:
        await engine.dispose()


async def test_the_unread_count_counts_the_thread_reply_too_so_the_four_move_together():
    engine, Session = await _session_factory()
    try:
        org_id, project_id, conv_id, b_user, top_id, reply_id = await _room_with_a_thread(Session)
        from app.main import app

        row = await _row_for(app, Session, b_user, org_id, project_id, conv_id)
        assert row["unread_count"] == 2, f"B has read nothing: the top-level message AND the reply are unread — {row['unread_count']}"
        assert row["latest_message"]["id"] == reply_id
    finally:
        await engine.dispose()
