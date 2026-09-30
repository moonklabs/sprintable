"""story #4430 — a message a block kept from someone is never a quiet success for the sender.

Until now (#2349 AC3) the recipient who blocked the sender is left out of SSE · mentions · notifications · webhooks, and the
send answers exactly as if it reached everyone (201 + data). Mirko → Didi 1:1 was lost that way for two months.

Now:
- the send answer carries `delivery = {"withheld_count": N, "reason": "recipient_blocked_sender"}` — how many participants
  the message did not reach because they blocked the sender, and a closed reason code — only when N > 0 (no block → the
  field is absent, as before). A count, never who (PO 16:20Z): blocking is also a people's feature, and «who blocked me»
  would break the blocker's quiet — the sender needs «it did not arrive», not «by whom». In a 1:1 the count is 1;
- the same is kept on the sent line, and the message reads (list · single) show `delivery_withheld` to the sender only —
  never to the blocker or anyone else in the conversation.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone

import pytest

from tests.test_1994_backlink_api_realdb import (
    _add_message,
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


async def _one_to_one(Session):
    async with Session() as session:
        org = await _make_org(session)
        project = await _make_project(session, org.id)
        blocker_id, blocker_user = await _make_human_member(session, org.id, project.id)
        sender_id, sender_user = await _make_human_member(session, org.id, project.id)
        conv_id = await _make_conversation(session, org.id, project.id, [blocker_id, sender_id], sender_id)
    return org.id, conv_id, (blocker_id, blocker_user), (sender_id, sender_user)


def _withheld(n: int, conversation_type: str = "dm") -> dict:
    return {"withheld_count": n, "reason": "recipient_blocked_sender", "conversation_type": conversation_type}


async def test_a_message_the_recipient_blocked_is_withheld_in_the_send_answer():
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, (blocker_id, blocker_user), (_sender_id, sender_user) = await _one_to_one(Session)
        from app.main import app

        block = await _as(app, Session, blocker_user, org_id,
                          lambda c: c.post("/api/v2/user-blocks", json={"blocked_member_id": str(_sender_id)}))
        assert block.status_code == 201, block.text
        sent = await _as(app, Session, sender_user, org_id,
                         lambda c: c.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": "are you there?"}))
        assert sent.status_code == 201, sent.text
        assert sent.json().get("delivery") == _withheld(1), sent.json()
        assert str(blocker_id) not in str(sent.json()["delivery"]), sent.json()  # a count, never who
    finally:
        await engine.dispose()


async def test_the_sent_line_shows_withheld_to_the_sender_only():
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, (blocker_id, blocker_user), (sender_id, sender_user) = await _one_to_one(Session)
        from app.main import app

        await _as(app, Session, blocker_user, org_id,
                  lambda c: c.post("/api/v2/user-blocks", json={"blocked_member_id": str(sender_id)}))
        sent = await _as(app, Session, sender_user, org_id,
                         lambda c: c.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": "hello?"}))
        msg_id = sent.json()["data"]["id"]
        expected = _withheld(1)

        async def reads(c):
            return (await c.get(f"/api/v2/conversations/{conv_id}/messages"),
                    await c.get(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))

        s_list, s_one = await _as(app, Session, sender_user, org_id, reads)
        b_list, b_one = await _as(app, Session, blocker_user, org_id, reads)
        for r in (s_list, s_one, b_list, b_one):
            assert r.status_code == 200, r.text

        s_row = next(m for m in s_list.json()["data"] if m["id"] == msg_id)
        assert s_row.get("delivery_withheld") == expected, s_row
        assert s_one.json().get("delivery_withheld") == expected, s_one.json()  # the single read is the message itself

        # the blocker sees the message masked as before (#2349) — never who is told what
        b_row = next(m for m in b_list.json()["data"] if m["id"] == msg_id)
        assert "delivery_withheld" not in b_row, b_row
        assert "delivery_withheld" not in b_one.json(), b_one.json()
        assert b_row["is_blocked_sender"] is True
        # the raw metadata never carries it out either
        assert "delivery_withheld" not in (b_row.get("metadata") or {}), b_row
    finally:
        await engine.dispose()


async def test_no_block_no_withheld_anywhere():
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, (_blocker_id, blocker_user), (_sender_id, sender_user) = await _one_to_one(Session)
        from app.main import app

        sent = await _as(app, Session, sender_user, org_id,
                         lambda c: c.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": "hi"}))
        assert sent.status_code == 201, sent.text
        assert "delivery" not in sent.json(), sent.json()
        rows = (await _as(app, Session, sender_user, org_id,
                          lambda c: c.get(f"/api/v2/conversations/{conv_id}/messages"))).json()["data"]
        assert rows and all("delivery_withheld" not in m for m in rows), rows
    finally:
        await engine.dispose()


async def test_a_message_sent_before_the_block_stays_unmarked():
    """The mark is what happened at send time — blocking later does not rewrite earlier lines."""
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, (_blocker_id, blocker_user), (sender_id, sender_user) = await _one_to_one(Session)
        async with Session() as session:
            await _add_message(session, conv_id, sender_id, "before the block", datetime.now(timezone.utc))
        from app.main import app

        await _as(app, Session, blocker_user, org_id,
                  lambda c: c.post("/api/v2/user-blocks", json={"blocked_member_id": str(sender_id)}))
        rows = (await _as(app, Session, sender_user, org_id,
                          lambda c: c.get(f"/api/v2/conversations/{conv_id}/messages"))).json()["data"]
        before = next(m for m in rows if m["content"] == "before the block")
        assert "delivery_withheld" not in before, before
    finally:
        await engine.dispose()


async def test_in_a_group_the_sender_gets_a_count_never_who():
    """Two of three others blocked the sender: the sender is told 2, never which two; the third, who did not block,
    still gets it and sees no mark."""
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            b1_id, b1_user = await _make_human_member(session, org.id, project.id)
            b2_id, b2_user = await _make_human_member(session, org.id, project.id)
            other_id, other_user = await _make_human_member(session, org.id, project.id)
            sender_id, sender_user = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(
                session, org.id, project.id, [b1_id, b2_id, other_id, sender_id], sender_id, conv_type="group",
            )
        from app.main import app

        for user in (b1_user, b2_user):
            r = await _as(app, Session, user, org.id,
                          lambda c: c.post("/api/v2/user-blocks", json={"blocked_member_id": str(sender_id)}))
            assert r.status_code == 201, r.text
        sent = await _as(app, Session, sender_user, org.id,
                         lambda c: c.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": "team update"}))
        assert sent.status_code == 201, sent.text
        assert sent.json().get("delivery") == _withheld(2, "group"), sent.json()
        for blocker in (b1_id, b2_id):
            assert str(blocker) not in str(sent.json().get("delivery")), sent.json()

        msg_id = sent.json()["data"]["id"]
        s_row = next(m for m in (await _as(app, Session, sender_user, org.id,
                                           lambda c: c.get(f"/api/v2/conversations/{conv_id}/messages"))).json()["data"]
                     if m["id"] == msg_id)
        assert s_row.get("delivery_withheld") == _withheld(2, "group"), s_row
        o_row = next(m for m in (await _as(app, Session, other_user, org.id,
                                           lambda c: c.get(f"/api/v2/conversations/{conv_id}/messages"))).json()["data"]
                     if m["id"] == msg_id)
        assert "delivery_withheld" not in o_row and o_row["is_blocked_sender"] is False, o_row
        assert "delivery_withheld" not in (o_row.get("metadata") or {}), o_row
    finally:
        await engine.dispose()


async def test_someone_outside_the_conversation_who_blocked_the_sender_is_not_counted():
    """The count is about this conversation. A member who blocked the sender but sits only in *another* conversation with
    them was never going to receive this message — it adds nothing (PO 17:18Z: the first version of this test put the
    outsider in no conversation at all, so dropping the «this conversation» condition still passed)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            member_id, _member_user = await _make_human_member(session, org.id, project.id)
            outsider_id, outsider_user = await _make_human_member(session, org.id, project.id)
            sender_id, sender_user = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(session, org.id, project.id, [member_id, sender_id], sender_id)
            # the outsider shares another conversation with the sender — a participant row that is not this one
            await _make_conversation(session, org.id, project.id, [outsider_id, sender_id], sender_id)
        from app.main import app

        r = await _as(app, Session, outsider_user, org.id,
                      lambda c: c.post("/api/v2/user-blocks", json={"blocked_member_id": str(sender_id)}))
        assert r.status_code == 201, r.text
        sent = await _as(app, Session, sender_user, org.id,
                         lambda c: c.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": "hi again"}))
        assert sent.status_code == 201, sent.text
        assert "delivery" not in sent.json(), sent.json()  # withheld_count 0 → no field
    finally:
        await engine.dispose()


async def test_a_room_typed_dm_with_three_people_is_worded_as_a_group():
    """`conversation_type` comes from who is in the room, not the `type` column: a room typed "dm" can hold three or more
    people, and «the recipient» would be untrue there (PO 17:18Z)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            blocker_id, blocker_user = await _make_human_member(session, org.id, project.id)
            other_id, _ = await _make_human_member(session, org.id, project.id)
            sender_id, sender_user = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(
                session, org.id, project.id, [blocker_id, other_id, sender_id], sender_id, conv_type="dm",
            )
        from app.main import app

        await _as(app, Session, blocker_user, org.id,
                  lambda c: c.post("/api/v2/user-blocks", json={"blocked_member_id": str(sender_id)}))
        sent = await _as(app, Session, sender_user, org.id,
                         lambda c: c.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": "three of us"}))
        assert sent.json().get("delivery") == _withheld(1, "group"), sent.json()
    finally:
        await engine.dispose()

async def test_a_reply_in_a_thread_carries_the_mark_on_the_replies_read_too():
    """The third read path (replies) — the sent line's mark is loaded and shown to the sender there as well; a read path
    that did not load metadata would drop it silently (a quiet success again)."""
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, (_blocker_id, blocker_user), (sender_id, sender_user) = await _one_to_one(Session)
        from app.main import app

        root = await _as(app, Session, sender_user, org_id,
                         lambda c: c.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": "root"}))
        root_id = root.json()["data"]["id"]
        await _as(app, Session, blocker_user, org_id,
                  lambda c: c.post("/api/v2/user-blocks", json={"blocked_member_id": str(sender_id)}))
        reply = await _as(app, Session, sender_user, org_id,
                          lambda c: c.post(f"/api/v2/conversations/{conv_id}/messages",
                                           json={"content": "a reply", "thread_id": root_id}))
        assert reply.status_code == 201, reply.text
        assert reply.json().get("delivery") == _withheld(1), reply.json()
        reply_id = reply.json()["data"]["id"]

        async def replies(c):
            return await c.get(f"/api/v2/conversations/{conv_id}/messages/{root_id}/replies")

        s_rows = (await _as(app, Session, sender_user, org_id, replies)).json()["data"]
        b_rows = (await _as(app, Session, blocker_user, org_id, replies)).json()["data"]
        assert next(m for m in s_rows if m["id"] == reply_id).get("delivery_withheld") == _withheld(1), s_rows
        assert "delivery_withheld" not in next(m for m in b_rows if m["id"] == reply_id), b_rows
    finally:
        await engine.dispose()


async def _mcp_send_result(raw_backend_reply: dict, conv_id) -> tuple[dict, str]:
    """The MCP send tool fed the backend's real reply (transport patched, nothing else): its parsed result and raw text."""
    import json
    from unittest.mock import AsyncMock, patch

    import sprintable_mcp.tools.chat as chat_mod

    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value=raw_backend_reply)):
        out = await chat_mod.send_chat_message(chat_mod.SendChatInput(conversation_id=str(conv_id), content="x"))
    return json.loads(out[0].text), out[0].text


async def test_the_mcp_send_tool_hands_delivery_to_the_sending_agent():
    """PO 16:39Z — the MCP send tool passed only a few sibling keys through, so `delivery` never reached an agent sender
    (the two-month loss had an agent on the sending side). Fed the backend's real reply, the tool result now carries it; with
    no block the tool result is byte-for-byte what it was before (the message fields only)."""
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, (_blocker_id, blocker_user), (sender_id, sender_user) = await _one_to_one(Session)
        from app.main import app

        plain = await _as(app, Session, sender_user, org_id,
                          lambda c: c.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": "before"}))
        await _as(app, Session, blocker_user, org_id,
                  lambda c: c.post("/api/v2/user-blocks", json={"blocked_member_id": str(sender_id)}))
        withheld = await _as(app, Session, sender_user, org_id,
                             lambda c: c.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": "after"}))

        result, _ = await _mcp_send_result(withheld.json(), conv_id)
        assert result.get("delivery") == _withheld(1), result
        assert result["id"] == withheld.json()["data"]["id"]

        from sprintable_mcp.response import ok

        result, text = await _mcp_send_result(plain.json(), conv_id)
        assert "delivery" not in result, result
        assert text == ok(dict(plain.json()["data"]))[0].text  # the same bytes as the tool gave before
    finally:
        await engine.dispose()
