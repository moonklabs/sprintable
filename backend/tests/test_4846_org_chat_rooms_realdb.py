"""story #4846 (E-ORG-CHAT 1) — a room belongs to the organization; its project is a label (maybe none), and being in the room reads it.

Pinned here, on a migrated PG (real HTTP):
- AC1 deleting a project leaves its rooms (project_id → NULL); a chat event row can carry no project.
- AC2 the access table. A room WITH a project: nothing changes for anyone but ONE cell — a participant who lost access to the project still reads the
  room. A room WITHOUT a project: a participant reads; a non-participant never does, except an organization owner/admin in a room with no human
  participant (an agent holds no organization-wide role: no bypass for an agent). HTTP · socket · the bulk predicate give one answer per cell.
- AC3 in a room without a project, delivery does not stop: the message / mention events (with no project), the webhook target, the human-intervention
  event, the mention notice.
- AC7 a new conversation is a new room (the same participants twice → two rooms).
"""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_agent_member,
    _make_conversation,
    _make_human_member,
    _make_org,
    _make_org_owner,
    _make_project,
    _session_factory,
    _setup_app_agent,
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


async def _world():
    """Org with projects P1 · P2; people and agents; four rooms (two with P1, two with no project)."""
    engine, Session = await _session_factory()
    async with Session() as s:
        org = await _make_org(s)
        p1 = await _make_project(s, org.id, "P1")
        p2 = await _make_project(s, org.id, "P2")
        h_a, u_a = await _make_human_member(s, org.id, p1.id)      # participant, has P1
        h_b, u_b = await _make_human_member(s, org.id, p1.id)      # participant, has P1
        h_c, u_c = await _make_human_member(s, org.id, p1.id)      # NOT a participant, has P1
        h_d, u_d = await _make_human_member(s, org.id, p2.id)      # participant, has NO access to P1 (lost it)
        owner, u_o = await _make_org_owner(s, org.id)              # NOT a participant; organization owner
        g_p = await _make_agent_member(s, org.id, p1.id)           # participant agent
        g_2 = await _make_agent_member(s, org.id, p1.id)           # second participant agent
        g_admin = await _make_agent_member(s, org.id, p1.id, role="admin")  # P1 admin agent, NOT a participant
        g_plain = await _make_agent_member(s, org.id, p1.id)       # P1 plain agent, NOT a participant
        g_p, g_2, g_admin, g_plain = (a if isinstance(a, uuid.UUID) else getattr(a, "id", a) for a in (g_p, g_2, g_admin, g_plain))
        r_human = await _make_conversation(s, org.id, p1.id, [h_a, h_b, h_d, g_p], h_a, "group")   # P1, humans in it → private
        r_agents = await _make_conversation(s, org.id, p1.id, [g_p, g_2], g_p, "group")            # P1, agents only
        n_human = await _make_conversation(s, org.id, None, [h_a, h_b, h_d, g_p], h_a, "group")    # no project, humans in it
        n_agents = await _make_conversation(s, org.id, None, [g_p, g_2], g_p, "group")             # no project, agents only
    return engine, Session, SimpleNamespace(
        org=org.id, p1=p1.id, p2=p2.id,
        h_a=h_a, u_a=u_a, h_b=h_b, u_b=u_b, h_c=h_c, u_c=u_c, h_d=h_d, u_d=u_d, owner=owner, u_o=u_o,
        g_p=g_p, g_2=g_2, g_admin=g_admin, g_plain=g_plain,
        r_human=r_human, r_agents=r_agents, n_human=n_human, n_agents=n_agents,
    )


def _callers(w):
    """name → (kind, member id, user id the HTTP layer authenticates)."""
    return {
        "participant": ("human", w.h_a, w.u_a),
        "lost_project": ("human", w.h_d, w.u_d),
        "member_outside": ("human", w.h_c, w.u_c),
        "org_owner": ("human", w.owner, w.u_o),
        "agent_participant": ("agent", w.g_p, w.g_p),
        "agent_project_admin": ("agent", w.g_admin, w.g_admin),
        "agent_plain": ("agent", w.g_plain, w.g_plain),
    }


async def _status(Session, w, caller, conv_id):
    from app.main import app

    kind, _member, user = _callers(w)[caller]
    if kind == "human":
        await _setup_app_human(app, Session, user, w.org)
    else:
        await _setup_app_agent(app, Session, user, w.org)
    try:
        async with _client_for(app) as c:
            return (await c.get(f"/api/v2/conversations/{conv_id}/messages")).status_code
    finally:
        app.dependency_overrides.clear()


# The access table. Every cell is what the code answered BEFORE this story, except the two marked NEW (the rooms without a project did not exist;
# `lost_project` in a room with a project is the one intended difference).
TABLE = {
    "r_human": {  # a room with a project, a person in it: private
        "participant": 200, "lost_project": 200,  # ← the one intended difference (was 403)
        "member_outside": 403, "org_owner": 403, "agent_participant": 200, "agent_project_admin": 403, "agent_plain": 403,
    },
    "r_agents": {  # a room with a project, agents only: its project's admin and an organization owner/admin may look
        "participant": 403, "lost_project": 403,
        "member_outside": 403, "org_owner": 200, "agent_participant": 200, "agent_project_admin": 200, "agent_plain": 403,
    },
    "n_human": {  # NEW: no project, a person in it
        "participant": 200, "lost_project": 200,
        "member_outside": 403, "org_owner": 403, "agent_participant": 200, "agent_project_admin": 403, "agent_plain": 403,
    },
    "n_agents": {  # NEW: no project, agents only: an organization owner/admin may look; no agent has an organization-wide role
        "participant": 403, "lost_project": 403,
        "member_outside": 403, "org_owner": 200, "agent_participant": 200, "agent_project_admin": 403, "agent_plain": 403,
    },
}


@pytest.mark.parametrize("room", list(TABLE))
async def test_ac2_http_access_table(room):
    engine, Session, w = await _world()
    try:
        got = {c: await _status(Session, w, c, getattr(w, room)) for c in TABLE[room]}
        assert got == TABLE[room]
    finally:
        await engine.dispose()


async def test_ac2_socket_and_bulk_predicate_give_the_same_answer_as_http():
    """Three consumers, one predicate: for every cell the socket check and the bulk (backlinks-shaped) predicate say what HTTP said."""
    from sqlalchemy import select

    from app.models.conversation import Conversation
    from app.services.conversation_auth import (
        agent_room_admin_bypass,
        conversation_readable_predicate,
        socket_can_read_conversation,
    )
    from app.services.project_auth import org_admin_valid_correlated, project_admin_valid_correlated

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            for room, cells in TABLE.items():
                conv_id = getattr(w, room)
                for caller, want in cells.items():
                    kind, member, user = _callers(w)[caller]
                    sock = await socket_can_read_conversation(
                        s, conv_id, w.org, member_id=member, access_user_id=user, via_agent_key=(kind == "agent"),
                    )
                    assert sock == (want == 200), (room, caller, "socket")
                    admin = (
                        project_admin_valid_correlated(Conversation.project_id, caller_id=member, org_id=w.org)
                        if kind == "agent" else org_admin_valid_correlated(caller_id=user, org_id=w.org)
                    )
                    bulk = set((await s.execute(
                        select(Conversation.id).where(
                            Conversation.org_id == w.org,
                            conversation_readable_predicate(Conversation.id, caller_member_id=member, admin_bypass_eligible=admin),
                        )
                    )).scalars().all())
                    assert (conv_id in bulk) == (want == 200), (room, caller, "bulk")
        # the agent bypass of a room without a project is none
        assert str(agent_room_admin_bypass(None, caller_id=w.g_admin, org_id=w.org)) == "false"
    finally:
        await engine.dispose()


async def test_ac1_deleting_the_project_leaves_the_room():
    from sqlalchemy import text

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            await s.execute(text("DELETE FROM projects WHERE id = :p"), {"p": w.p1})
            await s.commit()
        async with Session() as s:
            rows = (await s.execute(
                text("SELECT id, project_id FROM conversations WHERE id = ANY(:ids)"),
                {"ids": [w.r_human, w.r_agents, w.n_human, w.n_agents]},
            )).all()
        assert {r[0]: r[1] for r in rows} == {w.r_human: None, w.r_agents: None, w.n_human: None, w.n_agents: None}
    finally:
        await engine.dispose()


async def _send(Session, w, conv_id, *, mentioned=()):
    from app.main import app

    await _setup_app_human(app, Session, w.u_a, w.org)
    try:
        async with _client_for(app) as c:
            r = await c.post(f"/api/v2/conversations/{conv_id}/messages",
                             json={"content": "hello", "mentioned_ids": [str(m) for m in mentioned]})
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 201, r.text
    body = r.json()
    return uuid.UUID((body.get("data") or body)["id"])


async def _events(Session, msg_id):
    from sqlalchemy import text

    async with Session() as s:
        return (await s.execute(
            text("SELECT event_type, recipient_id, recipient_type, project_id, recipient_seq FROM events WHERE source_entity_id = :m"),
            {"m": msg_id},
        )).all()


async def test_ac3_a_message_in_a_room_without_a_project_reaches_everyone_it_should_with_no_project_on_the_rows():
    engine, Session, w = await _world()
    try:
        msg = await _send(Session, w, w.n_human, mentioned=[w.g_p])
        rows = await _events(Session, msg)
        by_type: dict[str, set] = {}
        for et, rid, _rt, project_id, _seq in rows:
            assert project_id is None, (et, rid)
            by_type.setdefault(et, set()).add(rid)
        # everyone but the sender gets the message …
        assert by_type.get("conversation.message_created") == {w.h_b, w.h_d, w.g_p}
        # … and the mentioned agent the mention, with a gap-free sequence number (an agent's stream)
        assert by_type.get("conversation:mention") == {w.g_p}
        assert all(seq is not None for et, rid, _rt, _p, seq in rows if rid == w.g_p)
        # nobody outside the room is told anything — every event of this message goes to a participant (and not to the sender)
        assert {rid for _et, rid, *_x in rows} <= {w.h_b, w.h_d, w.g_p}
        # control: the same message in a room WITH a project carries that project
        msg2 = await _send(Session, w, w.r_human, mentioned=[w.g_p])
        assert {p for *_x, p, _s in await _events(Session, msg2)} == {w.p1}
    finally:
        await engine.dispose()


async def test_ac3_the_mention_notice_is_written_in_a_room_without_a_project():
    from sqlalchemy import func, select

    from app.models.notification import Notification

    engine, Session, w = await _world()
    try:
        await _send(Session, w, w.n_human, mentioned=[w.h_b])
        async with Session() as s:
            n = (await s.execute(select(func.count()).select_from(Notification).where(
                Notification.user_id == w.u_b, Notification.type == "conversation.mention",
            ))).scalar_one()
        assert n == 1
    finally:
        await engine.dispose()


async def test_ac3_webhook_targets_of_a_room_without_a_project_are_the_member_bound_ones_only():
    from app.models.webhook_config import WebhookConfig
    from app.services.conversation_webhook import resolve_conversation_webhook_targets

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            bound = WebhookConfig(id=uuid.uuid4(), org_id=w.org, member_id=w.g_p, project_id=w.p1, url="https://a.example/hook", events=[])
            # a webhook that belongs to NO project, another member's: `project_id IS NULL` must not be read as «this room's project scope»
            other = WebhookConfig(id=uuid.uuid4(), org_id=w.org, member_id=w.g_plain, project_id=None, url="https://b.example/hook", events=[])
            s.add_all([bound, other])
            await s.commit()
        async with Session() as s:
            got = await resolve_conversation_webhook_targets(
                s, org_id=w.org, project_id=None, sender_id=w.h_a, authorized_member_ids={w.g_p},
            )
        assert {t.id for t in got} == {bound.id}
    finally:
        await engine.dispose()


async def test_ac3_the_human_intervention_event_is_written_in_a_room_without_a_project():
    from sqlalchemy import select

    from app.models.conversation import Conversation, ConversationMessage
    from app.routers.conversations import _dispatch_human_intervention_event
    from app.services.member_resolver import lookup_members_by_ids

    engine, Session, w = await _world()
    try:
        msg_id = await _send(Session, w, w.n_human)
        async with Session() as s:
            conv = (await s.execute(select(Conversation).where(Conversation.id == w.n_human))).scalar_one()
            msg = (await s.execute(select(ConversationMessage).where(ConversationMessage.id == msg_id))).scalar_one()
            sender = (await lookup_members_by_ids({w.h_a}, s))[w.h_a]
            pushes = await _dispatch_human_intervention_event(s, conv, msg, w.org, sender, {w.g_p}, 3)
            await s.commit()
        assert {pid for pid, _p in pushes} == {str(w.h_a), str(w.h_b), str(w.h_d)}
        rows = [r for r in await _events(Session, msg_id) if r[0] == "conversation.human_intervention_requested"]
        assert len(rows) == 3 and all(r[3] is None for r in rows)
    finally:
        await engine.dispose()


async def test_ac3_the_gate_card_notices_reach_a_room_without_a_project():
    """The three card notices (resolved · delegated · tossed) used to skip a conversation with no project «silently» (Event.project_id was NOT NULL)."""
    from app.models.conversation import ConversationMessage
    from app.services.approval_delivery import (
        notify_gate_card_recipients_resolved,
        notify_gate_delegated_to_old_approver,
        notify_gate_tossed,
    )

    engine, Session, w = await _world()
    try:
        gate = uuid.uuid4()
        async with Session() as s:
            s.add(ConversationMessage(
                id=uuid.uuid4(), conversation_id=w.n_human, sender_id=w.g_p, content="card",
                msg_metadata={"approval_target": {"gate_id": str(gate)}}, mentioned_ids=[w.h_b],
            ))
            await s.commit()
        async with Session() as s:
            resolved = await notify_gate_card_recipients_resolved(
                s, org_id=w.org, gate_id=gate, status="approved", resolver_id=w.h_a, resolved_at=None,
            )
            delegated = await notify_gate_delegated_to_old_approver(
                s, org_id=w.org, gate_id=gate, old_approver_id=w.h_b, new_approver_id=w.h_a,
            )
            tossed = await notify_gate_tossed(
                s, org_id=w.org, gate_id=gate, target_conversation_id=w.n_human, tossed_by_id=w.h_a,
            )
            await s.commit()
        assert [pid for pid, _p in resolved] == [str(w.h_b)]
        assert [pid for pid, _p in delegated] == [str(w.h_b)]
        assert str(w.h_b) in [pid for pid, _p in tossed]
        from sqlalchemy import text

        async with Session() as s:
            rows = (await s.execute(
                text("SELECT event_type, project_id FROM events WHERE source_entity_id = :g"), {"g": gate},
            )).all()
        assert {r[0] for r in rows} >= {"conversation.gate_resolved", "conversation.gate_delegated"}
        assert all(r[1] is None for r in rows)
    finally:
        await engine.dispose()


@pytest.mark.parametrize("room", ["r_human", "n_human"])
async def test_a_participant_who_is_removed_gets_nothing_after(room):
    """PO: "참가자에서 빠지면 그 뒤 글 0" — before removal the line reaches them; after it, no event row names them and the room is closed to them
    (REST and the socket judge), in a room with a project and in one without."""
    from sqlalchemy import text

    from app.services.conversation_auth import socket_can_read_conversation

    engine, Session, w = await _world()
    try:
        conv_id = getattr(w, room)
        before = await _send(Session, w, conv_id, mentioned=[w.h_d])
        assert w.h_d in {rid for _et, rid, *_x in await _events(Session, before)}
        assert await _status(Session, w, "lost_project", conv_id) == 200
        async with Session() as s:
            await s.execute(text("DELETE FROM conversation_participants WHERE conversation_id = :c AND member_id = :m"),
                            {"c": conv_id, "m": w.h_d})
            await s.commit()
        after = await _send(Session, w, conv_id, mentioned=[w.g_p])
        recipients = {rid for _et, rid, *_x in await _events(Session, after)}
        assert w.h_d not in recipients and w.h_b in recipients
        assert await _status(Session, w, "lost_project", conv_id) == 403
        async with Session() as s:
            assert await socket_can_read_conversation(s, conv_id, w.org, member_id=w.h_d, access_user_id=w.u_d, via_agent_key=False) is False
    finally:
        await engine.dispose()


@pytest.mark.parametrize("room", ["r_human", "n_human"])
async def test_a_person_who_left_the_organization_is_not_kept_by_a_leftover_participant_row(room):
    """The participant row alone does not read a room: someone who is no longer of the organization (no project access, org membership ended)
    is refused by REST and by the socket judge, the same answer (the project-access atom used to say it; the judge now asks the organization)."""
    from sqlalchemy import text

    from app.services.conversation_auth import socket_can_read_conversation

    engine, Session, w = await _world()
    try:
        conv_id = getattr(w, room)
        assert await _status(Session, w, "lost_project", conv_id) == 200
        async with Session() as s:
            await s.execute(text("DELETE FROM project_access WHERE member_id = :m"), {"m": w.h_d})
            await s.execute(text("UPDATE org_members SET deleted_at = now() WHERE user_id = :u"), {"u": w.u_d})
            await s.commit()
        assert await _status(Session, w, "lost_project", conv_id) == 403
        async with Session() as s:
            assert await socket_can_read_conversation(s, conv_id, w.org, member_id=w.h_d, access_user_id=w.u_d, via_agent_key=False) is False
    finally:
        await engine.dispose()


async def _post(Session, w, user, conv_id, *, agent=False):
    from app.main import app

    if agent:
        await _setup_app_agent(app, Session, user, w.org)
    else:
        await _setup_app_human(app, Session, user, w.org)
    try:
        async with _client_for(app) as c:
            return (await c.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": "let me in"})).status_code
    finally:
        app.dependency_overrides.clear()


async def _participants(Session, conv_id):
    from sqlalchemy import text

    async with Session() as s:
        return {r[0] for r in (await s.execute(text("SELECT member_id FROM conversation_participants WHERE conversation_id = :c"), {"c": conv_id})).all()}


async def test_a_member_outside_a_room_cannot_post_into_it_and_does_not_join_it():
    """codex 1: the group room's «a person with the project's access who speaks joins» is a PROJECT feature. A person of the organization WITHOUT the
    room's project is refused (403, not added); a room without a project has no way in but being added; the control (project access) still joins."""
    engine, Session, w = await _world()
    try:
        async with Session() as s:
            outsider, outsider_user = await _make_human_member(s, w.org, w.p2)   # of the organization, only P2
        before = await _participants(Session, w.r_human)
        assert await _post(Session, w, outsider_user, w.r_human) == 403           # a room with P1: no access to P1
        assert await _participants(Session, w.r_human) == before
        before_n = await _participants(Session, w.n_human)
        assert await _post(Session, w, w.u_c, w.n_human) == 403                    # no project: even a person with access to every project there is
        assert await _post(Session, w, w.u_o, w.n_human) == 403                    # … or the organization's owner
        assert await _participants(Session, w.n_human) == before_n
        # control: the existing feature (a person with the room's project speaks in its group room and joins)
        assert await _post(Session, w, w.u_c, w.r_human) == 201
        assert w.h_c in await _participants(Session, w.r_human)
    finally:
        await engine.dispose()


async def test_the_event_apis_serialize_a_row_without_a_project():
    """codex 1: `EventResponse` / `NotificationResponse` required a project id — the first chat line of a room without a project made the
    agent's pending-events call and the person's bell answer 500."""
    from app.main import app

    engine, Session, w = await _world()
    try:
        await _send(Session, w, w.n_human, mentioned=[w.g_p, w.h_b])
        await _setup_app_agent(app, Session, w.g_p, w.org)
        try:
            async with _client_for(app) as c:
                r = await c.get("/api/v2/events/pending", params={"recipient_id": str(w.g_p)})
            assert r.status_code == 200, r.text
            rows = r.json()
            assert rows and all(x["project_id"] is None for x in rows)
        finally:
            app.dependency_overrides.clear()
        await _setup_app_human(app, Session, w.u_b, w.org)
        try:
            async with _client_for(app) as c:
                r = await c.get("/api/v2/event-notifications")
            assert r.status_code == 200, r.text
            body = r.json()
            items = body.get("data", body) if isinstance(body, dict) else body
            assert items, body
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_a_room_without_a_project_refuses_a_new_attachment_out_loud():
    """codex 2: an attachment registered with no project would read as the organization's asset (`project_id IS NULL`) and open to a person who is
    not in the room. Until the attachment PR of this story it is refused, with a code the web can show; a text line is not affected."""
    from app.main import app

    engine, Session, w = await _world()
    try:
        await _setup_app_human(app, Session, w.u_a, w.org)
        try:
            async with _client_for(app) as c:
                r = await c.post(f"/api/v2/conversations/{w.n_human}/messages", json={
                    "content": "see file",
                    "attachments": [{"url": f"org/{w.org}/project/{w.p1}/chat/{w.n_human}/a.txt", "name": "a.txt", "size": 3, "content_type": "text/plain"}],
                })
                assert r.status_code == 400, r.text
                assert "ATTACHMENT_NEEDS_PROJECT" in r.text and "첨부" in r.text   # a reason a person can read
                ok = await c.post(f"/api/v2/conversations/{w.n_human}/messages", json={"content": "text only"})
                assert ok.status_code == 201, ok.text
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_the_registry_itself_refuses_a_chat_attachment_without_a_project():
    """the one place a chat attachment becomes an asset (`sync_attachment_assets`) — whichever route brought it there: a project → registered, no project → refused;
    a non-chat source (an org-level asset) and an empty list are not affected."""
    from app.services.asset_registry import AttachmentNeedsProject, sync_attachment_assets

    engine, Session, w = await _world()
    try:
        att = [{"url": f"org/{w.org}/project/{w.p1}/chat/{w.n_human}/a.txt", "name": "a.txt", "content_type": "text/plain", "size": 3}]
        async with Session() as s:
            with pytest.raises(AttachmentNeedsProject):
                await sync_attachment_assets(s, org_id=w.org, project_id=None, source_type="conversation_message",
                                             source_id=uuid.uuid4(), attachments=att, path_scope_id=w.n_human)
            # nothing to register is not an attachment: a message EDIT that drops them all passes through
            await sync_attachment_assets(s, org_id=w.org, project_id=None, source_type="conversation_message",
                                         source_id=uuid.uuid4(), attachments=[], path_scope_id=w.n_human)
    finally:
        await engine.dispose()


async def test_mcp_upload_never_builds_a_project_none_path():
    from app.main import app

    engine, Session, w = await _world()
    try:
        await _setup_app_agent(app, Session, w.g_p, w.org)
        try:
            async with _client_for(app) as c:
                r = await c.post(f"/api/v2/conversations/{w.n_agents}/attachments", json={
                    "name": "a.txt", "content_base64": "YWJj", "content_type": "text/plain",
                })
            assert r.status_code == 400 and "ATTACHMENT_NEEDS_PROJECT" in r.text, r.text
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def _delete_project(Session, w, project_id):
    from app.main import app

    await _setup_app_human(app, Session, w.u_o, w.org)
    try:
        async with _client_for(app) as c:
            return await c.delete(f"/api/v2/projects/{project_id}")
    finally:
        app.dependency_overrides.clear()


async def test_a_project_whose_rooms_hold_chat_attachments_is_not_deleted_yet():
    """PO: the files of a room are not deleted with the project (assets cascade on the project; no job deletes the stored files) — until the attachment PR,
    deleting such a project is refused with a code; a project whose rooms hold no attachment IS deleted and its rooms stay."""
    from sqlalchemy import text

    from app.models.conversation import ConversationMessage

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            s.add(ConversationMessage(
                id=uuid.uuid4(), conversation_id=w.r_human, sender_id=w.h_a, content="file",
                attachments=[{"url": f"org/{w.org}/project/{w.p1}/chat/{w.r_human}/a.txt", "name": "a.txt", "content_type": "text/plain", "size": 3}],
            ))
            await s.commit()
        r = await _delete_project(Session, w, w.p1)
        assert r.status_code == 409 and "PROJECT_HAS_CHAT_ATTACHMENTS" in r.text, r.text
        assert "첨부" in r.json()["error"]["message"] if "error" in r.json() else "첨부" in r.text   # a reason a person can read
        async with Session() as s:
            assert (await s.execute(text("SELECT count(*) FROM projects WHERE id = :p"), {"p": w.p1})).scalar_one() == 1
        # every path that deletes a project goes through the repository: the guard is there, not only in the route
        from app.repositories.project import ProjectHasChatAttachments, ProjectRepository

        async with Session() as s:
            with pytest.raises(ProjectHasChatAttachments):
                await ProjectRepository(s, w.org).delete(w.p1)
        # P2 has no room with an attachment (it has no room): deleted
        r2 = await _delete_project(Session, w, w.p2)
        assert r2.status_code == 200, r2.text
    finally:
        await engine.dispose()


async def test_project_deletion_locks_the_project_before_it_looks_for_attachments():
    """codex 3: «checked, then an attachment was registered, then deleted». Registering an attachment inserts an asset row that references the project (a
    key-share lock until its transaction ends); the deletion takes FOR UPDATE on the project row BEFORE the check, so it waits for one in flight and a
    later one waits for it. Pinned from the statements the repository sends (a wall-clock race test would be a budget, not a fact)."""
    from sqlalchemy import event

    from app.repositories.project import ProjectRepository

    engine, Session, w = await _world()
    try:
        seen: list[str] = []

        def _record(conn, cursor, statement, parameters, context, executemany):
            seen.append(statement.lower())

        async with Session() as s:
            event.listen(s.sync_session.get_bind(), "before_cursor_execute", _record)
            try:
                assert await ProjectRepository(s, w.org).delete(w.p2) is True   # P2 has no room: deleted
            finally:
                event.remove(s.sync_session.get_bind(), "before_cursor_execute", _record)
            await s.rollback()
        lock = next(i for i, q in enumerate(seen) if "from projects" in q and "for update" in q)
        check = next(i for i, q in enumerate(seen) if "jsonb_array_length" in q)
        assert lock < check, seen
    finally:
        await engine.dispose()


async def test_a_participant_who_lost_the_project_marks_their_own_chat_event_read():
    """codex 3: the read mark resolved the caller for the event's project — 403 for a participant who lost it (and unresolvable for an event with no project)."""
    from app.main import app

    engine, Session, w = await _world()
    try:
        await _send(Session, w, w.r_human, mentioned=[w.h_d])
        from sqlalchemy import text

        async with Session() as s:
            event_id = (await s.execute(
                text("SELECT id FROM events WHERE recipient_id = :r ORDER BY created_at DESC LIMIT 1"), {"r": w.h_d},
            )).scalar_one()
            await s.execute(text("DELETE FROM project_access WHERE member_id = :m"), {"m": w.h_d})
            await s.commit()
        await _setup_app_human(app, Session, w.u_d, w.org)
        try:
            async with _client_for(app) as c:
                r = await c.patch(f"/api/v2/event-notifications/{event_id}/read")
            assert r.status_code == 200, r.text
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_deleting_a_project_with_text_only_rooms_keeps_the_rooms():
    from sqlalchemy import text

    engine, Session, w = await _world()
    try:
        await _send(Session, w, w.r_human)  # text only
        r = await _delete_project(Session, w, w.p1)
        assert r.status_code == 200, r.text
        async with Session() as s:
            rows = (await s.execute(text("SELECT id, project_id FROM conversations WHERE id = ANY(:i)"), {"i": [w.r_human, w.r_agents]})).all()
        assert {x[0]: x[1] for x in rows} == {w.r_human: None, w.r_agents: None}
        assert await _status(Session, w, "participant", w.r_human) == 200   # and its participants still read it
    finally:
        await engine.dispose()


async def test_ac7_a_new_conversation_is_a_new_room():
    """The same participants twice → two rooms (no «existing» room is reused, nothing is merged)."""
    from app.main import app

    engine, Session, w = await _world()
    try:
        await _setup_app_human(app, Session, w.u_a, w.org)
        try:
            async with _client_for(app) as c:
                ids = []
                for _ in range(2):
                    r = await c.post("/api/v2/conversations", json={
                        "project_id": str(w.p1), "type": "dm", "participant_ids": [str(w.h_b)],
                    })
                    assert r.status_code == 201, r.text
                    assert r.json()["existing"] is False
                    ids.append(r.json()["id"])
        finally:
            app.dependency_overrides.clear()
        assert len(set(ids)) == 2
    finally:
        await engine.dispose()
