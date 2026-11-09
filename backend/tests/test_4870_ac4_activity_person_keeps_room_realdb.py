"""story #4870 AC4 — a PERSON who is in a room reads that room's activity whether or not they still have the room's project (4846 AC2: a person is not cut by project).

5458 (4846 AC14) made the activity stream and the activity log show a room's words only to who may read the room — but the org-wide view (no `project_id` given) was still cut by the
caller's project access FIRST, so a person who stayed in the room and lost its project (or a room that has no project at all) saw none of the room's activity. The room-read predicate is
the whole question for a row about a room; the project filter stays for every other kind of row.
Reproduced first (red on develop), then green. `lost_project` is in `r_human` (a room of P1) and in `n_human` (a room with no project) and has no access to P1.
"""
from __future__ import annotations

import json
import uuid

import pytest

from tests.test_4846_ac14_room_reads_realdb import _as, _say
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


async def _org_wide_stream(Session, w, caller) -> str:
    r = await _as(Session, w, caller, "GET", "/api/v2/activity-stream?limit=200&order=desc")
    assert r.status_code == 200, r.text
    return r.text


async def _org_wide_log(Session, w, caller) -> str:
    r = await _as(Session, w, caller, "GET", "/api/v2/activity-logs?limit=100")
    assert r.status_code == 200, r.text
    return r.text


async def test_a_person_who_stays_in_a_room_and_lost_its_project_sees_the_rooms_activity_in_the_org_wide_stream():
    engine, Session, w = await _world()
    try:
        in_p1 = f"ac4-p1-{uuid.uuid4().hex[:8]}"
        no_project = f"ac4-free-{uuid.uuid4().hex[:8]}"
        await _say(Session, w, "participant", w.r_human, f"a room of P1 {in_p1}")
        # a room with no project: the activity row exists because the message's fan-out reaches an agent of a project (`g_p` is in `n_human`) — an event with NO project at all makes
        # no activity row (`activity_events.project_id` is NOT NULL, `upsert_activity_from_events` skips it), so there is nothing to show or hide in that case
        await _say(Session, w, "participant", w.n_human, f"a room with no project {no_project}")
        text = await _org_wide_stream(Session, w, "lost_project")
        assert in_p1 in text and no_project in text, "a person in the room read nothing of its activity once the project was lost"
        # the other side stays shut: a project member who is NOT in the rooms reads none of it, and a person outside the project is not let into the P1 room by this
        text = await _org_wide_stream(Session, w, "member_outside")
        assert in_p1 not in text and no_project not in text, "the room-read rule is the whole question for a row about a room"
    finally:
        await engine.dispose()


async def test_a_person_who_stays_in_a_room_and_lost_its_project_sees_what_an_agent_said_there_in_the_org_wide_log():
    engine, Session, w = await _world()
    try:
        words = f"ac4-log-{uuid.uuid4().hex[:8]}"
        await _say(Session, w, "agent_participant", w.r_human, f"agent in the room {words}")
        assert words in await _org_wide_log(Session, w, "participant")                      # control: a participant who has the project
        assert words in await _org_wide_log(Session, w, "lost_project")                     # the person who stayed and lost the project
        assert words not in await _org_wide_log(Session, w, "member_outside")               # not in the room: none
    finally:
        await engine.dispose()


async def test_other_activity_is_still_cut_by_project_for_a_person_who_lost_it():
    """the project filter stays for every other kind of row (control): a story's activity in P1 is not shown to a person with no access to P1."""
    from datetime import datetime, timezone

    from app.models.activity_event import ActivityEvent

    engine, Session, w = await _world()
    try:
        marker = f"ac4-story-{uuid.uuid4().hex[:8]}"
        async with Session() as s:
            s.add(ActivityEvent(
                org_id=w.org, project_id=w.p1, actor_id=w.h_a, verb="status_changed", object_type="story", object_id=uuid.uuid4(),
                occurred_at=datetime.now(timezone.utc), payload={"title": marker}, dedup_key=f"ac4-{marker}",
            ))
            await s.commit()
        from app.models.activity_log import ActivityLog

        async with Session() as s:
            s.add(ActivityLog(org_id=w.org, project_id=w.p1, actor_id=w.h_a, actor_type="human", action="status_changed", entity_type="story", entity_id=uuid.uuid4(), context={"title": marker}))
            await s.commit()
        assert marker in await _org_wide_stream(Session, w, "participant")                  # control: a P1 member reads it
        text = await _org_wide_stream(Session, w, "lost_project")
        assert marker not in text, "a P1 story's activity must stay cut by P1 for a person with no P1 access"
        assert marker in await _org_wide_log(Session, w, "participant")                     # the same for the activity log
        assert marker not in await _org_wide_log(Session, w, "lost_project")
    finally:
        await engine.dispose()


async def test_an_agent_that_lost_the_rooms_project_still_does_not_see_the_rooms_activity():
    """an agent is the other way round (4846 AC12): in a room WITH a project it needs the project — the room-read predicate says so, and the activity follows it."""
    from sqlalchemy import text as sql

    engine, Session, w = await _world()
    try:
        words = f"ac4-agent-{uuid.uuid4().hex[:8]}"
        await _say(Session, w, "participant", w.r_human, f"human line {words}")
        assert words in await _org_wide_stream(Session, w, "agent_participant")              # control: the agent has P1
        async with Session() as s:
            await s.execute(sql("DELETE FROM project_access WHERE member_id = :m AND project_id = :p"), {"m": w.g_p, "p": w.p1})
            await s.commit()
        assert words not in await _org_wide_stream(Session, w, "agent_participant")
    finally:
        await engine.dispose()
