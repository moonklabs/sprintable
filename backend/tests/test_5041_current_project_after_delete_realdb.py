"""story 5041 (PO 11-28, ④ dev lap) — «delete the project I stand in»: what does the person's NEXT session say their current project is?

The ④ lap found the QA person's session pointing at a project that no longer answers (listed nowhere · GET 404). Whatever deletes a project (the person's own road, or an agent's card pressed by a person), the very next sign-in /
refresh must land the person on a LIVE project of their organisation — or on none — never on the deleted one. Real database; the real delete road, then the real session-context resolvers.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_5041_agent_action_realdb import (  # the same seed and «who makes the next call» as the approval-flow tests
    _REAL_DB_URL,
    _act_as,
    _client_for,
    _dispose_global_engine_after_test,  # noqa: F401  (autouse fixture)
    _seed,
    _session_factory,
    anyio_backend,  # noqa: F401
)

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="needs a real PG (PARITY/ALEMBIC_DATABASE_URL)")]


async def _second_project(Session, d):
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    async with Session() as s:
        p2 = Project(id=uuid.uuid4(), org_id=d["org_id"], name="The other live project")
        s.add(p2)
        await s.commit()
        s.add(ProjectAccess(id=uuid.uuid4(), project_id=p2.id, org_member_id=d["admin_om"], member_id=d["admin_om"], permission="granted"))
        await s.commit()
        return p2.id


async def _stand_in_then_delete(app, Session, d, *, last_org: bool):
    """the admin's person row points at the project (and the org); the admin deletes the project through the real road"""
    from sqlalchemy import update

    from app.models.user import User

    async with Session() as s:
        await s.execute(update(User).where(User.id == d["admin_user"]).values(last_project_id=d["project_id"], last_org_id=d["org_id"] if last_org else None))
        await s.commit()
    await _act_as(app, Session, d["admin_user"], d["org_id"])
    async with _client_for(app) as c:
        r = await c.delete(f"/api/v2/projects/{d['project_id']}")
    assert r.status_code == 200, r.text


async def _contexts(Session, d):
    """what each session resolver answers for the person AFTER the delete — an exception is an answer too (the person's refresh would be a 500)"""
    from sqlalchemy import select

    from app.models.user import User
    from app.routers.auth import _build_app_metadata, _refresh_session_context, _sign_in_session_context

    async def one(call):
        async with Session() as s:
            user = (await s.execute(select(User).where(User.id == d["admin_user"]))).scalar_one()
            try:
                return await call(user, s)
            except Exception as exc:  # noqa: BLE001
                return {"raised": type(exc).__name__, "project_id": None}

    return {
        "build": await one(lambda u, s: _build_app_metadata(u, s)),
        "sign_in": await one(lambda u, s: _sign_in_session_context(u, s)),
        # a refresh whose token still carries the deleted project as the session's project
        "refresh_with_old_project": await one(lambda u, s: _refresh_session_context(u, s, d["org_id"], d["project_id"])),
    }


@pytest.mark.anyio
@pytest.mark.parametrize("last_org", [True, False])
async def test_after_the_project_a_person_stands_in_is_deleted_the_next_session_lands_on_a_live_one(last_org):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        other = await _second_project(Session, d)
        await _stand_in_then_delete(app, Session, d, last_org=last_org)
        for where, md in (await _contexts(Session, d)).items():
            assert "raised" not in md, (where, md)
            assert md.get("project_id") not in (str(d["project_id"]),), (where, md.get("project_id"), "the deleted project")
            assert md.get("project_id") == str(other), (where, md.get("project_id"), "the person's other live project")
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_with_no_other_project_the_next_session_names_none_never_the_deleted_one():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _stand_in_then_delete(app, Session, d, last_org=True)
        for where, md in (await _contexts(Session, d)).items():
            assert "raised" not in md, (where, md)
            assert md.get("project_id") in ("", None), (where, md.get("project_id"))
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_project_delete_road_removes_the_project_row_for_real_and_the_persons_pointer_goes_null():
    """the FACT the verdict states (measured, then pinned): the delete road removes the `projects` ROW itself (no soft mark) — `users.last_project_id` is set NULL by its foreign key (so a refresh that writes the OLD id back is what broke) —
    while the rows that hang on the project WITHOUT a delete cascade (its stories, an agent's ask) stay behind as invisible orphans (the design `test_project_delete_realdb` guards: an orphan is never listed)."""
    from sqlalchemy import text

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            asked = await c.delete(f"/api/v2/stories/{d['story_id']}")
        assert asked.status_code == 202, asked.text
        await _stand_in_then_delete(app, Session, d, last_org=True)
        async with Session() as s:
            q = lambda sql: s.execute(text(sql), {"p": d["project_id"], "u": d["admin_user"]})  # noqa: E731
            assert (await q("SELECT count(*) FROM projects WHERE id = :p")).scalar_one() == 0, "the project row is deleted for real (not marked)"
            assert (await q("SELECT last_project_id FROM users WHERE id = :u")).scalar_one() is None, "the person's pointer was set NULL by its foreign key"
            assert (await q("SELECT count(*) FROM agent_hitl_requests WHERE project_id = :p")).scalar_one() == 1, "an agent's ask on the project is left behind (no cascade) — and unreachable: the card's access check says 404"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
