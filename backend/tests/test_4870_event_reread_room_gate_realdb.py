"""story #4870 — a STORED copy of a room's words is read back only by who may read the room NOW, on EVERY road that reads an `events` row back.

4846 cut what is SENT (an agent that has not a room's project is not delivered the room's words). A copy stored while the agent HAD the project is read back by the bell list and its
mark-read, `/events/pending`, `/events/{id}/delivered`, the reconnect backfill of `/events/stream` and the agent gateway replay (`/agent/stream`) — all five asked recipient + organization only.
Reproduced first (these tests were red on develop); now they all ask `event_room_gate.withheld_payloads` (the room-read predicate, one question per batch) and the words are taken out of
the copy handed back: the row stays, in the shape of a mention outside the room (`content_withheld`). A PERSON is not cut by project: a person who lost the project but is in the room reads on.
Nothing is written back: the stored row keeps the words (checked on every road).
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_1994_backlink_api_realdb import _client_for, _setup_app_agent, _setup_app_human
from tests.test_4846_ac14_room_reads_realdb import _agents_org_wide, _put_in_room
from tests.test_4846_org_chat_rooms_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _dispose_global_engine_after_test,
    _world,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _msg_payload(w, room, words: str) -> dict:
    """what `conversations._msg_payload` stores for a room message (the keys that matter here)."""
    return {
        "id": str(uuid.uuid4()), "conversation_id": str(room), "thread_id": None, "reply_count": 0, "deleted_at": None,
        "content": words, "mentioned_ids": [], "attachments": [{"name": f"a-{words}.txt", "url": "x"}],
        "sender_org_id": str(w.org), "sender": {"id": str(w.h_a), "name": "A", "type": "human", "avatar_url": None, "runtime_type": None},
        "summary": f"A: {words}", "created_at": datetime.now(timezone.utc).isoformat(),
    }


async def _stored_copy(Session, w, *, recipient, recipient_type, room, words, event_type="conversation.message_created", status="pending") -> uuid.UUID:
    """a copy of a room's message as it was STORED when the recipient was sent it (written directly: the state this story is about)."""
    from app.models.event import Event
    from app.services.event_seq import assign_recipient_seq

    payload = _msg_payload(w, room, words)
    async with Session() as s:
        ev = Event(
            project_id=w.p1, org_id=w.org, event_type=event_type, source_entity_type="conversation_message", source_entity_id=uuid.UUID(payload["id"]),
            sender_id=w.h_a, recipient_id=recipient, recipient_type=recipient_type, payload=payload, status=status,
        )
        s.add(ev)
        await s.flush()
        if recipient_type == "agent":
            await assign_recipient_seq(s, ev)
        await s.commit()
        return ev.id


async def _bell_copy(Session, w, *, recipient, room, words) -> uuid.UUID:
    """the bell's `dispatched` event about the ROOM (source = the conversation), made as `dispatch_notification` makes it: the message preview is `body`.
    story 4890: the copy of a plain chat MESSAGE (`conversation.message`) no longer reaches the bell at all (its message_created row is the line) — so this stand-in is the copy of a MENTION
    (`conversation.mention`), which still does (a person with no mention Event keeps it as their one bell item, 4519). The room gate treats every `dispatched` copy of a room the same way."""
    from app.models.event import Event

    async with Session() as s:
        ev = Event(
            project_id=w.p1, org_id=w.org, event_type="dispatched", source_entity_type="conversation", source_entity_id=room, sender_id=None,
            recipient_id=recipient, recipient_type="human", status="delivered",
            payload={"title": "a new message", "body": f"preview {words}", "event_type": "conversation.mention"},
        )
        s.add(ev)
        await s.commit()
        return ev.id


async def _stored_payload_text(Session, event_id) -> str:
    from sqlalchemy import text

    async with Session() as s:
        return (await s.execute(text("SELECT payload::text FROM events WHERE id = :i"), {"i": event_id})).scalar_one()


async def _call(Session, w, kind, user, method, path):
    from app.main import app

    await (_setup_app_human if kind == "human" else _setup_app_agent)(app, Session, user, w.org)
    try:
        async with _client_for(app) as c:
            return await c.request(method, path)
    finally:
        app.dependency_overrides.clear()


def _shown_as_withheld(payload: dict, words: str) -> bool:
    return words not in json.dumps(payload, ensure_ascii=False) and payload.get("content") in ("", None) and payload.get("content_withheld") is True


async def _world_with_agents(Session, w):
    """`lost`: an agent that has only P2 but is seated in the room of P1 (its project was taken away after it was sent the words); `kept`: seated and HAS P1 (the room's participant agent)."""
    (lost,) = await _agents_org_wide(Session, w, w.p2)
    await _put_in_room(Session, w.r_human, lost)
    return lost, w.g_p


# ─── the five roads, as an agent that lost the project ────────────────────────────────────────────────────────────────────────────────────

async def test_the_bell_list_and_its_mark_read_do_not_give_an_agent_that_lost_the_project_the_rooms_words():
    engine, Session, w = await _world()
    try:
        lost, kept = await _world_with_agents(Session, w)
        words = f"ac-bell-{uuid.uuid4().hex[:8]}"
        e_lost = await _stored_copy(Session, w, recipient=lost, recipient_type="agent", room=w.r_human, words=words)
        e_kept = await _stored_copy(Session, w, recipient=kept, recipient_type="agent", room=w.r_human, words=words)
        r = await _call(Session, w, "agent", kept, "GET", "/api/v2/event-notifications?limit=100")
        assert r.status_code == 200, r.text
        assert words in r.text and any(i["id"] == str(e_kept) for i in r.json())                    # control: the agent WITH the project reads its copy, as always
        r = await _call(Session, w, "agent", lost, "GET", "/api/v2/event-notifications?limit=100")
        assert r.status_code == 200, r.text
        rows = [i for i in r.json() if i["id"] == str(e_lost)]
        assert rows, "the row is kept (only the words go)"
        assert _shown_as_withheld(rows[0]["payload"], words) and words not in r.text, rows
        r = await _call(Session, w, "agent", lost, "PATCH", f"/api/v2/event-notifications/{e_lost}/read")
        assert r.status_code == 200, r.text
        assert _shown_as_withheld(r.json()["payload"], words) and words not in r.text
        r = await _call(Session, w, "agent", kept, "PATCH", f"/api/v2/event-notifications/{e_kept}/read")
        assert r.status_code == 200 and words in r.text                                             # control
        assert words in await _stored_payload_text(Session, e_lost)                                  # nothing is written back: the stored copy keeps the words
    finally:
        await engine.dispose()


async def test_pending_and_delivered_do_not_give_an_agent_that_lost_the_project_the_rooms_words():
    engine, Session, w = await _world()
    try:
        lost, kept = await _world_with_agents(Session, w)
        words = f"ac-pending-{uuid.uuid4().hex[:8]}"
        e_lost = await _stored_copy(Session, w, recipient=lost, recipient_type="agent", room=w.r_human, words=words)
        e_kept = await _stored_copy(Session, w, recipient=kept, recipient_type="agent", room=w.r_human, words=words)
        r = await _call(Session, w, "agent", kept, "GET", f"/api/v2/events/pending?recipient_id={kept}")
        assert r.status_code == 200 and words in r.text and any(i["id"] == str(e_kept) for i in r.json())   # control
        r = await _call(Session, w, "agent", lost, "GET", f"/api/v2/events/pending?recipient_id={lost}")
        assert r.status_code == 200, r.text
        rows = [i for i in r.json() if i["id"] == str(e_lost)]
        assert rows and _shown_as_withheld(rows[0]["payload"], words) and words not in r.text, r.text
        r = await _call(Session, w, "agent", lost, "PATCH", f"/api/v2/events/{e_lost}/delivered")
        assert r.status_code == 200, r.text
        assert _shown_as_withheld(r.json()["payload"], words) and words not in r.text
        assert words in await _stored_payload_text(Session, e_lost)                                  # the delivery stamp committed — and the stored copy is untouched
    finally:
        await engine.dispose()


async def _read_backfill_frames(Session, w, agent_id, monkeypatch) -> list[dict]:
    """the reconnect backfill of `/events/stream` for this agent: every event frame up to `sync_status`'s count, read straight off the generator (the transport is bypassed — see test_2201)."""
    from starlette.requests import Request

    from app.dependencies.auth import AuthContext
    from app.routers.events import agent_event_stream

    monkeypatch.setattr("app.core.database.async_session_factory", lambda: Session())
    auth = AuthContext(user_id=str(agent_id), email="agent@test", claims={"app_metadata": {"api_key_id": str(uuid.uuid4()), "org_id": str(w.org)}})
    request = Request(scope={"type": "http", "headers": [], "method": "GET", "path": "/api/v2/events/stream"})
    resp = await agent_event_stream(request=request, member_id=None, auth=auth, org_id=w.org, since_timestamp=None, last_event_id=None)
    frames: list[dict] = []
    expected = None
    try:
        async for chunk in resp.body_iterator:
            kind = None
            for line in chunk.splitlines():
                if line.startswith("event: "):
                    kind = line[len("event: "):]
                if line.startswith("data: "):
                    data = json.loads(line[len("data: "):])
                    if kind == "sync_status":
                        expected = data["returned"]
                    elif kind not in (None, "heartbeat"):
                        frames.append(data)
            if expected is not None and len(frames) >= expected:
                break
    finally:
        await resp.body_iterator.aclose()
    return frames


async def test_the_events_stream_backfill_does_not_give_an_agent_that_lost_the_project_the_rooms_words(monkeypatch):
    engine, Session, w = await _world()
    try:
        lost, kept = await _world_with_agents(Session, w)
        words = f"ac-stream-{uuid.uuid4().hex[:8]}"
        e_lost = await _stored_copy(Session, w, recipient=lost, recipient_type="agent", room=w.r_human, words=words)
        e_kept = await _stored_copy(Session, w, recipient=kept, recipient_type="agent", room=w.r_human, words=words)
        frames = await _read_backfill_frames(Session, w, kept, monkeypatch)
        assert any(f["event_id"] == str(e_kept) for f in frames) and words in json.dumps(frames), frames   # control: the agent WITH the project is backfilled the words
        frames = await _read_backfill_frames(Session, w, lost, monkeypatch)
        got = [f for f in frames if f["event_id"] == str(e_lost)]
        assert got, "the row is still backfilled (only the words go)"
        assert words not in json.dumps(frames, ensure_ascii=False), "the words are in a frame of the backfill"
        assert got[0]["content"] == "" and got[0]["payload"]["content_withheld"] is True and got[0]["content_withheld"] is True
        assert words in await _stored_payload_text(Session, e_lost)
    finally:
        await engine.dispose()


async def test_the_agent_gateway_replay_does_not_give_an_agent_that_lost_the_project_the_rooms_words(monkeypatch):
    import app.routers.agent_gateway as ag
    from tests.test_2381_ac4_live_wake_delivery_realdb import _open_stream, _patch_side_effects
    from tests.test_4649_agent_stream_org_realdb import _next_event_frame

    engine, Session, w = await _world()
    try:
        _patch_side_effects(monkeypatch)
        monkeypatch.setattr(ag, "async_session_factory", lambda: Session())
        lost, kept = await _world_with_agents(Session, w)
        words = f"ac-gateway-{uuid.uuid4().hex[:8]}"
        e_lost = await _stored_copy(Session, w, recipient=lost, recipient_type="agent", room=w.r_human, words=words)
        e_kept = await _stored_copy(Session, w, recipient=kept, recipient_type="agent", room=w.r_human, words=words)
        for agent, may in ((kept, True), (lost, False)):
            resp = await _open_stream(ag, Session, agent, w.org)
            agen = resp.body_iterator
            try:
                frame = await _next_event_frame(agen)
            finally:
                await agen.aclose()
                ag._agent_connections.pop(str(agent), None)
            assert frame["event_id"] == str(e_kept if may else e_lost)                               # the row is replayed either way
            assert (words in json.dumps(frame, ensure_ascii=False)) is may, (may, frame)
            if not may:
                assert frame["content"] == "" and frame["payload"]["content_withheld"] is True
        assert words in await _stored_payload_text(Session, e_lost)
    finally:
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


# ─── the other kinds of event that carry a room's words, and the controls ────────────────────────────────────────────────────────────────────

async def test_a_mention_and_a_human_intervention_copy_are_withheld_the_same_way():
    engine, Session, w = await _world()
    try:
        lost, _kept = await _world_with_agents(Session, w)
        words = f"ac-kinds-{uuid.uuid4().hex[:8]}"
        ids = {t: await _stored_copy(Session, w, recipient=lost, recipient_type="agent", room=w.r_human, words=words, event_type=t)
               for t in ("conversation:mention", "conversation.human_intervention_requested")}
        r = await _call(Session, w, "agent", lost, "GET", f"/api/v2/events/pending?recipient_id={lost}")
        assert r.status_code == 200 and words not in r.text, r.text
        by_id = {i["id"]: i for i in r.json()}
        assert all(str(i) in by_id for i in ids.values())
        assert by_id[str(ids["conversation:mention"])]["payload"]["mentioned_ids"] == [str(lost)]       # a mention keeps who was named — what a mention outside the room always carried
        assert by_id[str(ids["conversation.human_intervention_requested"])]["payload"]["mentioned_ids"] == []
    finally:
        await engine.dispose()


async def test_an_a2a_task_message_of_a_room_the_agent_cannot_read_is_withheld_and_one_it_can_is_not():
    from app.models.event import Event
    from app.services.event_seq import assign_recipient_seq

    engine, Session, w = await _world()
    try:
        lost, kept = await _world_with_agents(Session, w)
        words = f"ac-a2a-{uuid.uuid4().hex[:8]}"
        ids = {}
        async with Session() as s:
            for who in (lost, kept):
                ev = Event(project_id=w.p1, org_id=w.org, event_type="a2a.task_message", recipient_id=who, recipient_type="agent", sender_id=None, status="pending",
                           payload={"message_id": str(uuid.uuid4()), "conversation_id": str(w.r_human), "content": words, "project_context": {"note": words}})
                s.add(ev)
                await s.flush()
                await assign_recipient_seq(s, ev)
                ids[who] = ev.id
            await s.commit()
        r = await _call(Session, w, "agent", lost, "GET", f"/api/v2/events/pending?recipient_id={lost}")
        assert r.status_code == 200 and words not in r.text, r.text                                    # the words AND the project context are gone
        assert [i for i in r.json() if i["id"] == str(ids[lost])][0]["payload"]["content_withheld"] is True
        r = await _call(Session, w, "agent", kept, "GET", f"/api/v2/events/pending?recipient_id={kept}")
        assert r.status_code == 200 and words in r.text                                                # control
    finally:
        await engine.dispose()


async def test_a_person_who_lost_the_project_but_is_in_the_room_reads_on_and_a_person_outside_the_room_does_not():
    """AC2 (control): a PERSON is not cut by project. h_d has only P2 yet is a participant of the room of P1: the bell, pending and delivered give the words. h_c (a member of P1, NOT in the room)
    is asked the same question as everyone and does not get them."""
    engine, Session, w = await _world()
    try:
        words = f"ac-person-{uuid.uuid4().hex[:8]}"
        e_d = await _stored_copy(Session, w, recipient=w.h_d, recipient_type="human", room=w.r_human, words=words)
        e_c = await _stored_copy(Session, w, recipient=w.h_c, recipient_type="human", room=w.r_human, words=words)
        r = await _call(Session, w, "human", w.u_d, "GET", "/api/v2/event-notifications?limit=100")
        assert r.status_code == 200 and words in r.text and any(i["id"] == str(e_d) for i in r.json()), r.text
        r = await _call(Session, w, "human", w.u_d, "GET", f"/api/v2/events/pending?recipient_id={w.h_d}&include_recent_delivered_minutes=120")
        assert r.status_code == 200 and words in r.text, r.text
        r = await _call(Session, w, "human", w.u_c, "GET", "/api/v2/event-notifications?limit=100")
        assert r.status_code == 200, r.text
        rows = [i for i in r.json() if i["id"] == str(e_c)]
        assert rows and _shown_as_withheld(rows[0]["payload"], words) and words not in r.text, r.text
    finally:
        await engine.dispose()


async def test_the_bell_preview_of_a_room_is_withheld_from_someone_who_cannot_read_the_room():
    engine, Session, w = await _world()
    try:
        words = f"ac-preview-{uuid.uuid4().hex[:8]}"
        e_in = await _bell_copy(Session, w, recipient=w.h_a, room=w.r_human, words=words)             # a participant
        e_out = await _bell_copy(Session, w, recipient=w.h_c, room=w.r_human, words=words)            # a member of the project who is not in the room
        r = await _call(Session, w, "human", w.u_a, "GET", "/api/v2/event-notifications?limit=100")
        assert r.status_code == 200 and words in r.text and any(i["id"] == str(e_in) for i in r.json())   # control
        r = await _call(Session, w, "human", w.u_c, "GET", "/api/v2/event-notifications?limit=100")
        assert r.status_code == 200, r.text
        rows = [i for i in r.json() if i["id"] == str(e_out)]
        assert rows and words not in r.text and rows[0]["payload"].get("body") == "" and rows[0]["payload"]["content_withheld"] is True, r.text
        assert rows[0]["payload"]["title"] == "a new message"                                          # the bell still says that something came
    finally:
        await engine.dispose()


async def test_an_event_that_is_not_a_rooms_words_is_untouched_whoever_reads_it():
    from app.models.event import Event

    engine, Session, w = await _world()
    try:
        (lost,) = await _agents_org_wide(Session, w, w.p2)
        marker = f"ac-other-{uuid.uuid4().hex[:8]}"
        async with Session() as s:
            ev = Event(project_id=w.p2, org_id=w.org, event_type="story_assigned", source_entity_type="story", source_entity_id=uuid.uuid4(), sender_id=None,
                       recipient_id=lost, recipient_type="agent", payload={"title": marker, "body": marker}, status="pending")
            s.add(ev)
            await s.commit()
        r = await _call(Session, w, "agent", lost, "GET", f"/api/v2/events/pending?recipient_id={lost}")
        assert r.status_code == 200 and r.text.count(marker) == 2 and "content_withheld" not in r.text, r.text
    finally:
        await engine.dispose()


async def test_a_room_without_a_project_asks_nothing_of_an_agents_projects():
    """the room WITHOUT a project (4846): an agent that sits in it reads it whatever projects it has — its copy is not withheld. (A person in it likewise.)"""
    engine, Session, w = await _world()
    try:
        (lost,) = await _agents_org_wide(Session, w, w.p2)
        await _put_in_room(Session, w.n_human, lost)
        words = f"ac-free-{uuid.uuid4().hex[:8]}"
        await _stored_copy(Session, w, recipient=lost, recipient_type="agent", room=w.n_human, words=words)
        r = await _call(Session, w, "agent", lost, "GET", f"/api/v2/events/pending?recipient_id={lost}")
        assert r.status_code == 200 and words in r.text, r.text
    finally:
        await engine.dispose()


# ─── AC5 — the workflow execution log's message preview ──────────────────────────────────────────────────────────────────────────────────────

async def _execution_log(Session, w, room, preview: str, *, with_preview: bool = True) -> uuid.UUID:
    """a `workflow_execution_logs` row as `process_event` stores it for a `message.created` (the preview and its room in `event_context.metadata`)."""
    from app.models.workflow_execution_log import WorkflowExecutionLog

    meta = {"conversation_id": str(room), "message_id": str(uuid.uuid4()), "project_id": str(w.p1), "org_id": str(w.org), "sender_type": "human"}
    if with_preview:
        meta["content_preview"] = preview
    async with Session() as s:
        log = WorkflowExecutionLog(org_id=w.org, project_id=w.p1, event_type="message.created", trigger_type_slug="kickoff", event_context={"event_type": "message.created", "metadata": meta}, status="matched")
        s.add(log)
        await s.commit()
        return log.id


async def _owner_reads_log(Session, w, log_id):
    """the log's detail as an organization owner (the admin role claim `require_admin` reads), who is NOT in any of the rooms."""
    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            yield s

    async def _auth():
        return AuthContext(user_id=str(w.u_o), email="owner@test", claims={"app_metadata": {"org_id": str(w.org), "role": "owner"}})

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    try:
        async with _client_for(app) as c:
            return await c.get(f"/api/v2/workflow-executions/{log_id}")
    finally:
        app.dependency_overrides.clear()


async def test_the_execution_logs_message_preview_follows_the_room_read_rule_for_an_owner_outside_the_room():
    """AC5 — an organization owner/admin does not read a room with a person in it (the bypass is for rooms of agents only), so the preview of such a room's message is withheld
    from the log's detail; a room of agents only (the owner may read it) keeps its preview; a log with no preview, and the rest of the log, are as they were; the stored row keeps the words."""
    engine, Session, w = await _world()
    try:
        private_words = f"ac5-private-{uuid.uuid4().hex[:8]}"
        agents_words = f"ac5-agents-{uuid.uuid4().hex[:8]}"
        private_log = await _execution_log(Session, w, w.r_human, private_words)
        agents_log = await _execution_log(Session, w, w.r_agents, agents_words)
        bare_log = await _execution_log(Session, w, w.r_human, "", with_preview=False)
        gone_log = await _execution_log(Session, w, uuid.uuid4(), "ac5-gone-room")

        r = await _owner_reads_log(Session, w, private_log)
        assert r.status_code == 200, r.text
        meta = r.json()["event_context"]["metadata"]
        assert private_words not in r.text and meta["content_preview"] == "" and meta["content_withheld"] is True and meta["conversation_id"] == str(w.r_human)
        assert r.json()["event_type"] == "message.created" and r.json()["status"] == "matched"      # everything else in the log stays

        r = await _owner_reads_log(Session, w, agents_log)
        assert r.status_code == 200 and agents_words in r.text and "content_withheld" not in r.text   # control: the owner may read the room of agents

        r = await _owner_reads_log(Session, w, bare_log)
        assert r.status_code == 200 and "content_withheld" not in r.text and "content_preview" not in r.text

        r = await _owner_reads_log(Session, w, gone_log)
        assert r.status_code == 200 and "ac5-gone-room" not in r.text and r.json()["event_context"]["metadata"]["content_withheld"] is True   # a room that cannot be read is not a room anyone reads

        from sqlalchemy import text

        async with Session() as s:
            stored = (await s.execute(text("SELECT event_context::text FROM workflow_execution_logs WHERE id = :i"), {"i": private_log})).scalar_one()
        assert private_words in stored                                                                # the stored row is not changed
    finally:
        await engine.dispose()


async def test_a_copy_that_does_not_name_its_room_is_withheld_too_never_passed_on_a_missing_room_id():
    """fail closed: a stored copy of a message whose payload names no room (or a malformed one) is a room nobody can be shown to read — its words are not handed back, on any road (here /events/pending)."""
    from app.models.event import Event

    engine, Session, w = await _world()
    try:
        (agent,) = await _agents_org_wide(Session, w, w.p1)
        words = f"ac-noroom-{uuid.uuid4().hex[:8]}"
        async with Session() as s:
            ids = []
            for payload in ({"content": words}, {"content": words, "conversation_id": "not-a-uuid"}):
                ev = Event(project_id=w.p1, org_id=w.org, event_type="conversation.message_created", sender_id=None, recipient_id=agent, recipient_type="agent", payload=payload, status="pending")
                s.add(ev)
                ids.append(ev)
            await s.commit()
            ids = [e.id for e in ids]
        r = await _call(Session, w, "agent", agent, "GET", f"/api/v2/events/pending?recipient_id={agent}")
        assert r.status_code == 200, r.text
        rows = [i for i in r.json() if i["id"] in {str(x) for x in ids}]
        assert len(rows) == 2 and all(_shown_as_withheld(i["payload"], words) for i in rows) and words not in r.text, r.text
    finally:
        await engine.dispose()
