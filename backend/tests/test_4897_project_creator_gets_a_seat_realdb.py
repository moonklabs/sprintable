"""story 4897 — whoever creates a project through the API is on that project's team (a granted seat, no admin rights).

Before: `POST /api/v2/projects` is allowed to any member of the organization (it checks the organization and the plan limit, not the role), but it only made sure the caller was an organization member. A plain member
or an agent got a 201 for a project they could then neither read, list nor rename — it existed and the plan's project count went down. An organization owner/admin saw it only because they see every project.
Decision (PO, after the screen/API mismatch was found): the screen follows the API (the form is open to every member) and the creator is put on the project. Reproduced first (member and agent: create 201, read 404,
list without it, rename 404 on develop), then fixed.

Real Postgres, real HTTP routes.
"""
from __future__ import annotations

import pytest
from sqlalchemy import text

from tests.test_4846_ac14_room_reads_realdb import _as
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


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _create(Session, w, caller, name):
    r = await _as(Session, w, caller, "POST", "/api/v2/projects", {"name": name, "org_id": str(w.org)})
    assert r.status_code == 201, r.text
    body = r.json()
    return (body.get("data") or body)["id"]


@pytest.mark.parametrize("caller", ["participant", "agent_plain", "org_owner"])
async def test_the_creator_can_read_list_and_rename_the_project_they_just_made(caller):
    engine, Session, w = await _world()
    try:
        pid = await _create(Session, w, caller, f"mine-{caller}")
        r = await _as(Session, w, caller, "GET", f"/api/v2/projects/{pid}")
        assert r.status_code == 200, r.text
        r = await _as(Session, w, caller, "GET", "/api/v2/projects")
        assert r.status_code == 200 and pid in r.text, "it is in their project list"
        r = await _as(Session, w, caller, "PATCH", f"/api/v2/projects/{pid}", {"name": "renamed"})
        assert r.status_code == 200, r.text
    finally:
        await engine.dispose()


@pytest.mark.parametrize("caller", ["participant", "agent_plain"])
async def test_the_seat_is_a_plain_member_seat_not_admin_rights(caller):
    """what the creator does NOT get: deleting the project (owner/admin only) or managing who else is on it"""
    engine, Session, w = await _world()
    try:
        pid = await _create(Session, w, caller, f"limits-{caller}")
        r = await _as(Session, w, caller, "DELETE", f"/api/v2/projects/{pid}")
        assert r.status_code in (403, 404), (r.status_code, r.text)
        r = await _as(Session, w, caller, "GET", f"/api/v2/projects/{pid}")
        assert r.status_code == 200, "and the refused delete left the project in place"
        async with Session() as s:
            row = (await s.execute(text("SELECT permission, role FROM project_access WHERE project_id = :p"), {"p": pid})).all()
        assert [tuple(x) for x in row] == [("granted", "member")], row
    finally:
        await engine.dispose()


async def test_other_members_still_do_not_see_the_new_project():
    """the seat is the creator's only: it does not open the project to the rest of the organization"""
    engine, Session, w = await _world()
    try:
        pid = await _create(Session, w, "participant", "private-by-default")
        for other in ("member_outside", "agent_participant", "lost_project"):
            r = await _as(Session, w, other, "GET", f"/api/v2/projects/{pid}")
            assert r.status_code == 404, (other, r.status_code)
    finally:
        await engine.dispose()


async def test_an_agent_creator_gets_no_organization_member_row_made_from_its_id():
    """the old path made an organization-member row for whatever id the caller had — for an agent that is a person row that does not exist"""
    engine, Session, w = await _world()
    try:
        agent = _callers(w)["agent_plain"][1]
        await _create(Session, w, "agent_plain", "by-an-agent")
        async with Session() as s:
            n_om = (await s.execute(text("SELECT count(*) FROM org_members WHERE user_id = :u"), {"u": agent})).scalar_one()
            seat = (await s.execute(text("SELECT count(*) FROM project_access WHERE member_id = :m AND org_member_id IS NULL AND permission = 'granted'"), {"m": agent})).scalar_one()
        assert n_om == 0, "no organization-member row for an agent"
        assert seat >= 1
    finally:
        await engine.dispose()


async def test_creating_twice_gives_one_seat_each():
    engine, Session, w = await _world()
    try:
        a = await _create(Session, w, "participant", "first-4897")
        b = await _create(Session, w, "participant", "second-4897")
        async with Session() as s:
            rows = (await s.execute(text("SELECT project_id, count(*) FROM project_access WHERE project_id IN (:a, :b) GROUP BY 1"), {"a": a, "b": b})).all()
        assert sorted(str(r[0]) for r in rows) == sorted([a, b]) and all(r[1] == 1 for r in rows)
    finally:
        await engine.dispose()
