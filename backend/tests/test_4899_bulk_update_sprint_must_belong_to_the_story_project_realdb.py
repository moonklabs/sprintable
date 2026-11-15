"""story 4899 (SEC-S8 T/X, third road) — PATCH /stories/bulk checks that a sprint it sets belongs to the story's own project.

Create (POST) and PATCH /{id} already refused an epic / sprint / meeting of another project with a 404; the bulk route set `sprint_id`
with setattr and no check, so a story of one project could be hung on a sprint of another project of the same org (and the burndown,
which has no project filter, then disagreed with the list, which has one). The bulk item carries `sprint_id` only.

Real routes on a real Postgres: the caller is an org owner (sees every project of the org) unless a test says otherwise.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_4497_assignee_event_on_create_realdb import _create, _patch, _seed
from tests.test_e4fc29fa_site_post_orchestration import _seed_org

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,  # the seeds write team_members (a table in the destructive schema, a view when migrated)
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


async def _second_project(Session, org_id) -> uuid.UUID:
    from app.models.project import Project

    async with Session() as s:
        p = Project(id=uuid.uuid4(), org_id=org_id, name="P2")
        s.add(p)
        await s.commit()
        return p.id


async def _sprint(Session, org_id, project_id) -> uuid.UUID:
    from app.models.pm import Sprint

    async with Session() as s:
        sp = Sprint(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="스프린트", status="planning")
        s.add(sp)
        await s.commit()
        return sp.id


async def _world():
    """org A: projects P1 (the seeded one) and P2, a sprint in each; org B: its own project and sprint."""
    engine, Session, org_id, p1, owner_id, _other, _agent = await _seed()
    p2 = await _second_project(Session, org_id)
    s1, s2 = await _sprint(Session, org_id, p1), await _sprint(Session, org_id, p2)
    async with Session() as s:
        org_b, project_b = await _seed_org(s)
    sb = await _sprint(Session, org_b, project_b)
    return engine, Session, org_id, p1, p2, owner_id, s1, s2, sb


async def _story(Session, org_id, project_id, owner_id) -> str:
    r = await _create(Session, org_id, project_id, owner_id)
    assert r.status_code == 201, r.text
    return r.json().get("data", r.json())["id"]


async def _row(Session, story_id):
    from sqlalchemy import select

    from app.models.pm import Story

    async with Session() as s:
        return (await s.execute(select(Story.sprint_id, Story.status, Story.priority).where(Story.id == uuid.UUID(story_id)))).one()


BULK = "/api/v2/stories/bulk"


async def test_a_sprint_of_another_project_of_the_same_org_is_refused_and_the_story_keeps_its_sprint():
    engine, Session, org_id, p1, p2, owner_id, s1, s2, _sb = await _world()
    try:
        sid = await _story(Session, org_id, p1, owner_id)
        r = await _patch(Session, org_id, owner_id, BULK, {"items": [{"id": sid, "sprint_id": str(s2)}]})
        assert r.status_code == 404, r.text
        assert "Sprint not found" in r.text
        assert (await _row(Session, sid)).sprint_id is None
        # the same story, the same call, with the sprint of its OWN project goes through (control)
        r = await _patch(Session, org_id, owner_id, BULK, {"items": [{"id": sid, "sprint_id": str(s1)}]})
        assert r.status_code == 200, r.text
        assert (await _row(Session, sid)).sprint_id == s1
    finally:
        await engine.dispose()


async def test_the_check_is_against_each_storys_own_project_not_the_first_items():
    """two stories of two projects in one request, each with the sprint of ITS project → fine; swapped → refused."""
    engine, Session, org_id, p1, p2, owner_id, s1, s2, _sb = await _world()
    try:
        a, b = await _story(Session, org_id, p1, owner_id), await _story(Session, org_id, p2, owner_id)
        ok = await _patch(Session, org_id, owner_id, BULK, {"items": [{"id": a, "sprint_id": str(s1)}, {"id": b, "sprint_id": str(s2)}]})
        assert ok.status_code == 200, ok.text
        assert (await _row(Session, a)).sprint_id == s1 and (await _row(Session, b)).sprint_id == s2
        swapped = await _patch(Session, org_id, owner_id, BULK, {"items": [{"id": a, "sprint_id": str(s2)}, {"id": b, "sprint_id": str(s1)}]})
        assert swapped.status_code == 404, swapped.text
        assert (await _row(Session, a)).sprint_id == s1 and (await _row(Session, b)).sprint_id == s2
    finally:
        await engine.dispose()


async def test_one_bad_item_refuses_the_whole_request_and_not_even_the_valid_items_are_saved():
    engine, Session, org_id, p1, p2, owner_id, s1, s2, _sb = await _world()
    try:
        good, bad = await _story(Session, org_id, p1, owner_id), await _story(Session, org_id, p1, owner_id)
        before = await _row(Session, good)
        r = await _patch(Session, org_id, owner_id, BULK, {"items": [
            {"id": good, "sprint_id": str(s1), "priority": "critical", "status": "ready-for-dev"},
            {"id": bad, "sprint_id": str(s2)},
        ]})
        assert r.status_code == 404, r.text
        after_good, after_bad = await _row(Session, good), await _row(Session, bad)
        assert after_good == before, "the valid item before the bad one must not be saved"
        assert after_bad.sprint_id is None
    finally:
        await engine.dispose()


async def test_a_status_gate_that_commits_midway_does_not_let_earlier_items_be_saved_when_a_later_sprint_is_refused(monkeypatch):
    """codex 01a1c99b: the loop's status gate (`_preflight_merge_gate` · `enforce_gate`) commits when it blocks or parks an item. A sprint
    check made INSIDE the loop would find the bad item after that commit — the item before it already saved. The check runs before
    the loop. The gate here is the real call's behaviour: commit what the session holds, then answer 409 (the loop turns it into a
    per-item result)."""
    import app.routers.stories as stories_mod
    from fastapi import HTTPException

    async def committing_gate(db, org_id, story, new_status):
        await db.commit()
        raise HTTPException(status_code=409, detail={"code": "MERGE_GATE_PENDING", "message": "held", "requires_human": True})

    monkeypatch.setattr(stories_mod, "_preflight_merge_gate", committing_gate)
    engine, Session, org_id, p1, p2, owner_id, s1, s2, _sb = await _world()
    try:
        first, gated, bad = [await _story(Session, org_id, p1, owner_id) for _ in range(3)]
        before = await _row(Session, first)
        r = await _patch(Session, org_id, owner_id, BULK, {"items": [
            {"id": first, "priority": "critical", "sprint_id": str(s1)},
            {"id": gated, "status": "done"},
            {"id": bad, "sprint_id": str(s2)},
        ]})
        assert r.status_code == 404, r.text
        assert await _row(Session, first) == before, "the item before the gate's commit must not be saved"
        # control: without the bad item the same request goes through, and the gated item answers its hold in the result
        r = await _patch(Session, org_id, owner_id, BULK, {"items": [
            {"id": first, "priority": "critical", "sprint_id": str(s1)},
            {"id": gated, "status": "done"},
        ]})
        assert r.status_code == 200, r.text
        assert (await _row(Session, first)).priority == "critical"
    finally:
        await engine.dispose()


async def test_access_that_appears_between_the_check_and_the_loop_cannot_let_an_unchecked_sprint_be_written(monkeypatch):
    """codex 01a1c9b2: the pre-pass and the loop each read the caller's access. A grant landing between the two reads must not make the
    loop write a sprint the pre-pass skipped (it saw «no access»). The first read says no, every later one says yes (what a grant in
    between looks like); the story is skipped by both and nothing is written."""
    import app.services.project_auth as project_auth

    real = project_auth.has_project_access
    calls = {"n": 0}

    async def access_appears_after_the_first_read(*a, **k):
        calls["n"] += 1
        return False if calls["n"] == 1 else await real(*a, **k)

    engine, Session, org_id, p1, p2, owner_id, s1, s2, _sb = await _world()
    try:
        sid = await _story(Session, org_id, p1, owner_id)
        monkeypatch.setattr(project_auth, "has_project_access", access_appears_after_the_first_read)
        r = await _patch(Session, org_id, owner_id, BULK, {"items": [{"id": sid, "sprint_id": str(s2), "priority": "critical"}]})
        assert calls["n"] >= 2, "the test must have reached the loop's own read"
        assert r.status_code == 200 and r.json() == [], r.text
        row = await _row(Session, sid)
        assert row.sprint_id is None and row.priority != "critical", "the cross-project sprint must not be written unchecked"
    finally:
        await engine.dispose()


async def test_a_story_id_that_does_not_exist_is_skipped_silently_whatever_sprint_is_named():
    engine, Session, org_id, p1, p2, owner_id, s1, s2, _sb = await _world()
    try:
        for named in (s1, s2):
            r = await _patch(Session, org_id, owner_id, BULK, {"items": [{"id": str(uuid.uuid4()), "sprint_id": str(named)}]})
            assert r.status_code == 200 and r.json() == [], r.text
    finally:
        await engine.dispose()


async def test_a_sprint_of_another_org_is_refused_the_same_way():
    engine, Session, org_id, p1, _p2, owner_id, _s1, _s2, sb = await _world()
    try:
        sid = await _story(Session, org_id, p1, owner_id)
        r = await _patch(Session, org_id, owner_id, BULK, {"items": [{"id": sid, "sprint_id": str(sb)}]})
        assert r.status_code == 404, r.text
        assert (await _row(Session, sid)).sprint_id is None
        # a sprint id that does not exist at all answers the same (nothing tells «exists elsewhere» from «no such»)
        r = await _patch(Session, org_id, owner_id, BULK, {"items": [{"id": sid, "sprint_id": str(uuid.uuid4())}]})
        assert r.status_code == 404, r.text
    finally:
        await engine.dispose()


async def test_a_bulk_edit_with_no_sprint_is_untouched_status_priority_and_order_still_go_through():
    engine, Session, org_id, p1, p2, owner_id, s1, _s2, _sb = await _world()
    try:
        a, b = await _story(Session, org_id, p1, owner_id), await _story(Session, org_id, p2, owner_id)
        r = await _patch(Session, org_id, owner_id, BULK, {"items": [
            {"id": a, "priority": "critical", "position": 1},
            {"id": b, "priority": "low", "position": 2},
        ]})
        assert r.status_code == 200, r.text
        assert (await _row(Session, a)).priority == "critical" and (await _row(Session, b)).priority == "low"
        # a story that already sits on a sprint is not re-checked when the request does not touch the sprint
        assert (await _patch(Session, org_id, owner_id, BULK, {"items": [{"id": a, "sprint_id": str(s1)}]})).status_code == 200
        r = await _patch(Session, org_id, owner_id, BULK, {"items": [{"id": a, "priority": "high"}]})
        assert r.status_code == 200 and (await _row(Session, a)).sprint_id == s1
    finally:
        await engine.dispose()


async def test_a_story_the_caller_cannot_reach_is_still_skipped_silently_not_answered_with_a_404():
    """the access check stays first: a story of a project the caller has no seat in answers as before (skipped), whatever sprint is
    named — an answer that differed would show the story exists."""
    from app.models.project import OrgMember
    from app.models.team import TeamMember
    from app.models.user import User

    engine, Session, org_id, p1, p2, owner_id, s1, s2, _sb = await _world()
    try:
        hidden = await _story(Session, org_id, p2, owner_id)  # a story of P2
        async with Session() as s:
            user = User(id=uuid.uuid4(), email=f"m-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
            s.add(user)
            await s.commit()
            s.add(OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="member"))
            s.add(TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=p1, type="human", name="P1만", user_id=user.id, is_active=True))
            await s.commit()
        for named in (s1, s2):  # a sprint of the caller's own project, and one of the story's project: same silent skip
            r = await _patch(Session, org_id, user.id, BULK, {"items": [{"id": hidden, "sprint_id": str(named), "priority": "critical"}]})
            assert r.status_code == 200 and r.json() == [], r.text
            row = await _row(Session, hidden)
            assert row.sprint_id is None and row.priority != "critical"
    finally:
        await engine.dispose()
