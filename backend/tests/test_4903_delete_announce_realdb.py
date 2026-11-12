"""story #4903 AC2 — deleting a message is announced to the room's people while their screens are open.

Until now a delete reached no other open screen (the old «AC7 blind spot»): the deleter's own screen turned the message into a tombstone, every other open
room and list kept the words until a reload. The server now pushes `conversation.message_deleted` to the people in the room (every open tab and device of each),
after the commit. Proved here against a real PG, through the real routes (send → delete), with the live push recorded:

- **who**: every PERSON in the room (the deleter too — their other devices) and nobody else: not an agent in the room, not a person outside it;
- **what**: ids and moments only — the closed set of keys, and none of the words anywhere in the frame;
- **when / how often**: once, on the first delete — not on a repeat delete, not on a delete that was refused (403 / 404);
- **safety**: a push that fails never fails the delete (the tombstone is committed).
"""
from __future__ import annotations

import json
import os
import uuid

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_agent_member,
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

WORDS = "지울 글 — 4903 announce-me"
FRAME_KEYS = {"event_type", "conversation_id", "id", "thread_id", "created_at", "deleted_at", "recipient_id"}


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


@pytest.fixture
def pushes(monkeypatch):
    """every live push the routers make, recorded: (member_id, payload)"""
    seen: list[tuple[str, dict]] = []

    def fake_push(member_id, payload, *args, **kwargs):
        seen.append((str(member_id), dict(payload)))
        return True

    monkeypatch.setattr("app.routers.conversations._push_to_agent", fake_push)
    return seen


def deleted_frames(seen):
    return [(m, p) for m, p in seen if p.get("event_type") == "conversation.message_deleted"]


async def _as(app, Session, user_id, org_id, fn):
    await _setup_app_human(app, Session, user_id, org_id)
    try:
        async with _client_for(app) as client:
            return await fn(client)
    finally:
        app.dependency_overrides.clear()


async def _world(Session):
    """org · project · a room of three people (A sends and deletes · B · C) and an agent, plus a person (D) who is NOT in the room"""
    async with Session() as session:
        org = await _make_org(session)
        project = await _make_project(session, org.id)
        a_id, a_user = await _make_human_member(session, org.id, project.id)
        b_id, b_user = await _make_human_member(session, org.id, project.id)
        c_id, c_user = await _make_human_member(session, org.id, project.id)
        d_id, d_user = await _make_human_member(session, org.id, project.id)
        agent_id = await _make_agent_member(session, org.id, project.id)
        conv_id = await _make_conversation(session, org.id, project.id, [a_id, b_id, c_id, agent_id], a_id, conv_type="group")
    return org.id, conv_id, {"a": (a_id, a_user), "b": (b_id, b_user), "c": (c_id, c_user), "d": (d_id, d_user), "agent": agent_id}


async def _send(app, Session, user, org_id, conv_id, text):
    r = await _as(app, Session, user, org_id, lambda c: c.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": text}))
    assert r.status_code == 201, r.text
    return r.json()["data"]["id"]


async def test_the_people_in_the_room_are_told_and_nobody_else(pushes):
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, w = await _world(Session)
        from app.main import app

        msg_id = await _send(app, Session, w["a"][1], org_id, conv_id, WORDS)
        assert deleted_frames(pushes) == [], "nothing is announced by a send"
        d = await _as(app, Session, w["a"][1], org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert d.status_code == 200, d.text

        frames = deleted_frames(pushes)
        got = {m for m, _ in frames}
        assert got == {str(w["a"][0]), str(w["b"][0]), str(w["c"][0])}, f"the three people in the room — the deleter's other devices included — and nobody else: {got}"
        assert str(w["agent"]) not in got, "an agent in the room is not sent the frame"
        assert str(w["d"][0]) not in got, "a person outside the room is not sent the frame"
        assert len(frames) == 3, "one frame per person"
    finally:
        await engine.dispose()


async def test_the_frame_carries_ids_and_moments_only_never_the_words(pushes):
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, w = await _world(Session)
        from app.main import app

        msg_id = await _send(app, Session, w["a"][1], org_id, conv_id, WORDS)
        d = await _as(app, Session, w["a"][1], org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert d.status_code == 200, d.text
        frames = deleted_frames(pushes)
        assert frames, "the frames were pushed"
        for member, frame in frames:
            assert set(frame) == FRAME_KEYS, f"the closed set of keys: {sorted(frame)}"
            assert frame["id"] == msg_id and frame["conversation_id"] == str(conv_id) and frame["recipient_id"] == member
            assert frame["deleted_at"] and frame["created_at"], frame
            assert "announce-me" not in json.dumps(frame, ensure_ascii=False), f"no words in the frame: {frame}"
    finally:
        await engine.dispose()


async def test_a_repeat_delete_and_a_refused_delete_announce_nothing(pushes):
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, w = await _world(Session)
        from app.main import app

        msg_id = await _send(app, Session, w["a"][1], org_id, conv_id, WORDS)
        # B is in the room but not the owner: refused (403) — nothing announced
        refused = await _as(app, Session, w["b"][1], org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert refused.status_code == 403, refused.text
        assert deleted_frames(pushes) == [], "a refused delete announces nothing"
        first = await _as(app, Session, w["a"][1], org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert first.status_code == 200, first.text
        n = len(deleted_frames(pushes))
        assert n == 3, n
        again = await _as(app, Session, w["a"][1], org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert again.status_code == 200, again.text
        assert len(deleted_frames(pushes)) == n, "a repeat delete does not announce again"
    finally:
        await engine.dispose()


async def test_a_failing_push_never_fails_the_delete(monkeypatch):
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, w = await _world(Session)
        from app.main import app

        calls = {"n": 0}

        def boom(member_id, payload, *a, **k):
            if payload.get("event_type") == "conversation.message_deleted":
                calls["n"] += 1
                raise RuntimeError("the stream is down")
            return True

        monkeypatch.setattr("app.routers.conversations._push_to_agent", boom)
        msg_id = await _send(app, Session, w["a"][1], org_id, conv_id, WORDS)
        d = await _as(app, Session, w["a"][1], org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert d.status_code == 200, d.text
        assert calls["n"] >= 1, "the announce was tried"
        msg = await _as(app, Session, w["b"][1], org_id, lambda c: c.get(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert msg.status_code == 200 and msg.json().get("deleted_at"), "the tombstone is committed"
    finally:
        await engine.dispose()


async def test_a_person_whose_participant_row_belongs_to_another_org_is_not_told(pushes):
    """the same recipients a NEW message reaches (`conversation_member_ids_in_org`: this org's conversation, this org's members): a participant row planted from another org gets no frame"""
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, w = await _world(Session)
        from app.main import app
        from app.models.conversation import ConversationParticipant

        async with Session() as session:
            other_org = await _make_org(session)
            other_project = await _make_project(session, other_org.id)
            stranger_id, _stranger_user = await _make_human_member(session, other_org.id, other_project.id)
            session.add(ConversationParticipant(conversation_id=conv_id, member_id=stranger_id))  # a row from another org in this room
            await session.commit()

        msg_id = await _send(app, Session, w["a"][1], org_id, conv_id, WORDS)
        d = await _as(app, Session, w["a"][1], org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert d.status_code == 200, d.text
        got = {m for m, _ in deleted_frames(pushes)}
        assert str(stranger_id) not in got, f"a person of another org is not told: {got}"
        assert got == {str(w["a"][0]), str(w["b"][0]), str(w["c"][0])}, f"this org's people still are: {got}"
    finally:
        await engine.dispose()
