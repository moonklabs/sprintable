"""story #4868 — the `members` anchor where the `team_members` view forgets (real Postgres; every test here was red before).

  AC2  the reserved system publisher («시스템 발행») is shown by the resolver when the project it was anchored to is gone (the view loses it with its grant) — the name and `agent` kind only, for that row only,
       and never another organization's.
  AC4  the agents' message policy finds its agents through the anchor: an agent that lost all its projects is judged (creator_only → 403 for a person who is not its creator); the server's own voice is not judged.
  AC6  the 1:1 «mention forks a group» (CB-S2) seats only those the sender could add — the same gate as «add a participant».
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from tests.test_4846_ac14_room_reads_realdb import _agents_org_wide, _as, _events_for, _say  # noqa: F401
from tests.test_4846_org_chat_rooms_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _callers,
    _dispose_global_engine_after_test,
    _world,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]

PUBLISHER_NAME = "시스템 발행"


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _lose_projects(Session, agent):
    """the agent has no project any more: neither a placement nor a grant — the `team_members` view shows it nowhere."""
    async with Session() as s:
        await s.execute(text("DELETE FROM project_access WHERE member_id = :a"), {"a": agent})
        await s.execute(text("DELETE FROM agent_project_profiles WHERE member_id = :a"), {"a": agent})
        await s.commit()


async def _creator_only(Session, agent, owner_member):
    async with Session() as s:
        await s.execute(text("UPDATE members SET message_policy_mode = 'creator_only', owner_member_id = :o WHERE id = :a"), {"a": agent, "o": owner_member})
        await s.commit()


async def _publisher(Session, org_id, *, project_gone=True):
    from app.routers.events import _get_or_create_system_publisher

    async with Session() as s:
        pub = await _get_or_create_system_publisher(s, org_id)
        await s.commit()
        pid = pub.id
    if project_gone:     # the project it was anchored to is deleted: its grant goes (the view loses the publisher)
        async with Session() as s:
            await s.execute(text("DELETE FROM project_access WHERE member_id = :a"), {"a": pid})
            await s.commit()
    return pid


# ─── AC2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_the_publisher_whose_project_is_gone_is_still_named_in_a_rooms_messages():
    from app.models.conversation import ConversationMessage

    engine, Session, w = await _world()
    try:
        pub = await _publisher(Session, w.org)
        marker = f"from-the-server-{uuid.uuid4().hex[:8]}"
        async with Session() as s:
            s.add(ConversationMessage(conversation_id=w.r_human, sender_id=pub, content=marker))
            await s.commit()
        r = await _as(Session, w, "participant", "GET", f"/api/v2/conversations/{w.r_human}/messages?limit=50")
        assert r.status_code == 200, r.text
        body = r.json()
        rows = body.get("items") or body.get("data") or body.get("messages") or []
        if isinstance(rows, dict):
            rows = rows.get("items") or rows.get("messages") or []
        item = next(i for i in rows if marker in str(i.get("content")))
        assert PUBLISHER_NAME in str(item), item                                                 # was: an unnamed person
        assert str((item.get("sender") or {}).get("type", "agent")) == "agent", item
    finally:
        await engine.dispose()


async def test_the_resolver_names_only_the_reserved_publisher_never_another_member_the_view_does_not_show():
    from app.services.member_resolver import lookup_members_by_ids

    engine, Session, w = await _world()
    try:
        pub = await _publisher(Session, w.org)
        (lost_agent,) = await _agents_org_wide(Session, w, w.p1)
        await _lose_projects(Session, lost_agent)                                                # an ordinary agent with no project: not in the view either
        async with Session() as s:
            got = await lookup_members_by_ids({pub, lost_agent}, s, org_id=w.org)
        assert got[pub].name == PUBLISHER_NAME and got[pub].type == "agent" and got[pub].resolved and got[pub].org_id == w.org
        assert got[lost_agent].name is None and got[lost_agent].resolved is False               # as before: nothing is supplemented for it
    finally:
        await engine.dispose()


async def test_another_organizations_publisher_is_not_supplemented_into_this_organizations_lookup():
    from app.services.member_resolver import lookup_members_by_ids
    from tests.test_1994_backlink_api_realdb import _make_org, _make_project

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            other_org = await _make_org(s)
            await _make_project(s, other_org.id, "Other")
        foreign = await _publisher(Session, other_org.id)
        async with Session() as s:
            mine = await lookup_members_by_ids({foreign}, s, org_id=w.org)
            theirs = await lookup_members_by_ids({foreign}, s, org_id=other_org.id)
        assert mine[foreign].name is None and mine[foreign].resolved is False                    # not mixed into this organization
        assert theirs[foreign].name == PUBLISHER_NAME                                           # its own organization reads it
    finally:
        await engine.dispose()


# ─── AC4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_an_agent_that_lost_all_its_projects_still_meets_its_creator_only_policy():
    """the policy question itself (the participants route stops a project-less agent earlier, at «Member not found» — the view again; this is the question every entry asks once it has an id)."""
    from fastapi import HTTPException

    from app.routers.conversations import _enforce_agent_creator_policy

    engine, Session, w = await _world()
    try:
        (agent,) = await _agents_org_wide(Session, w, w.p1)
        await _creator_only(Session, agent, w.h_b)                                              # its creator: h_b
        await _lose_projects(Session, agent)
        sender = SimpleNamespace(id=w.h_a, user_id=w.u_a)
        async with Session() as s:
            with pytest.raises(HTTPException) as e:                                              # was: «no agent found» → skipped, the conversation let through
                await _enforce_agent_creator_policy(sender, [w.h_c, agent], s)
            assert e.value.status_code == 403
            await _enforce_agent_creator_policy(sender, [w.h_b, agent], s)                      # control: its creator is among the people
    finally:
        await engine.dispose()


async def test_an_agent_that_regained_a_project_is_judged_the_same():
    from fastapi import HTTPException

    from app.routers.conversations import _enforce_agent_creator_policy

    engine, Session, w = await _world()
    try:
        (agent,) = await _agents_org_wide(Session, w, w.p1)
        await _creator_only(Session, agent, w.h_b)
        await _lose_projects(Session, agent)
        async with Session() as s:                                                               # the project comes back
            from tests.test_1994_backlink_api_realdb import _grant_project_access  # noqa: F401
            from app.models.member import AgentProjectProfile
            from app.models.project_access import ProjectAccess

            s.add(AgentProjectProfile(id=uuid.uuid4(), member_id=agent, project_id=w.p1))
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=w.p1, org_member_id=None, member_id=agent, permission="granted", role="member"))
            await s.commit()
        sender = SimpleNamespace(id=w.h_a, user_id=w.u_a)
        async with Session() as s:
            with pytest.raises(HTTPException) as e:
                await _enforce_agent_creator_policy(sender, [w.h_c, agent], s)
            assert e.value.status_code == 403
    finally:
        await engine.dispose()


async def test_the_server_issued_publisher_meets_no_message_policy():
    from fastapi import HTTPException

    from app.routers.conversations import _enforce_agent_creator_policy

    engine, Session, w = await _world()
    try:
        pub = await _publisher(Session, w.org)
        (restricted,) = await _agents_org_wide(Session, w, w.p1)
        await _creator_only(Session, restricted, w.h_b)
        sender = SimpleNamespace(id=w.h_a, user_id=w.u_a)
        async with Session() as s:
            await _enforce_agent_creator_policy(sender, [pub], s)                                # a person and the server's voice: no policy (was 403 «Agent has no creator»)
            with pytest.raises(HTTPException) as e:                                              # the publisher is no «person» that could satisfy another agent's policy
                await _enforce_agent_creator_policy(sender, [pub, restricted], s)
            assert e.value.status_code == 403
    finally:
        await engine.dispose()


# ─── AC6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async def _mention_in_dm(Session, w, dm, mentioned, words):
    r = await _as(Session, w, "participant", "POST", f"/api/v2/conversations/{dm}/messages", {"content": words, "mentioned_ids": [str(m) for m in mentioned]})
    assert r.status_code == 201, r.text
    return uuid.UUID((r.json().get("data") or r.json())["id"])


async def _rooms_with(Session, member):
    async with Session() as s:
        return [r[0] for r in (await s.execute(text("SELECT conversation_id FROM conversation_participants WHERE member_id = :m"), {"m": member})).all()]


async def test_a_dm_mention_does_not_fork_the_agent_in_past_its_creator_policy():
    from tests.test_1994_backlink_api_realdb import _make_conversation

    engine, Session, w = await _world()
    try:
        restricted, open_agent = await _agents_org_wide(Session, w, w.p1, w.p1)
        await _creator_only(Session, restricted, w.h_c)                                         # its creator h_c is NOT in the DM
        async with Session() as s:
            dm = await _make_conversation(s, w.org, w.p1, [w.h_a, w.h_b], w.h_a, "dm")
        words = f"ac6-dm-{uuid.uuid4().hex[:8]}"
        msg = await _mention_in_dm(Session, w, dm, [restricted], f"hello {words}")
        assert await _rooms_with(Session, restricted) == []                                      # was: seated in the new group
        got = await _events_for(Session, msg, restricted)
        assert all(words not in p for _t, p in got), got                                         # it keeps the mention (the bell), not the words
        # control: an agent that allows everyone is forked in, as before
        words2 = f"ac6-dm-ok-{uuid.uuid4().hex[:8]}"
        await _mention_in_dm(Session, w, dm, [open_agent], f"hello {words2}")
        assert len(await _rooms_with(Session, open_agent)) == 1
    finally:
        await engine.dispose()


# ─── AC5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_a_deleted_agents_runtime_type_is_not_read_from_the_anchor_as_the_view_did_not():
    from datetime import datetime, timezone

    from app.routers.conversations import _lookup_sender_runtime_types

    engine, Session, w = await _world()
    try:
        alive, gone = await _agents_org_wide(Session, w, w.p1, w.p1)
        async with Session() as s:
            await s.execute(text("UPDATE members SET runtime_type = 'claude-code' WHERE id IN (:a, :b)"), {"a": alive, "b": gone})
            await s.execute(text("UPDATE members SET deleted_at = :t WHERE id = :g"), {"t": datetime.now(timezone.utc), "g": gone})
            await s.commit()
        async with Session() as s:
            got = await _lookup_sender_runtime_types({alive, gone}, s)
        assert got.get(alive) == "claude-code" and gone not in got                                 # was: the deleted agent's kind came back
    finally:
        await engine.dispose()
