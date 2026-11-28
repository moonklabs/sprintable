"""story 5041 (PO 11-28, ④ lap · DIAG): a person's `last_project_id` points at a project row that is only MARKED deleted (`deleted_at` set, the row still there — the old soft road, an archive, a restore).

The ④ lap found the QA person's sign-in landing on a project that answers nowhere (not in their list · GET 404). The earlier test (`test_5041_current_project_after_delete_realdb`) covers the delete road that removes the ROW; this one covers the
row that stays: the sign-in, the plain context build and a refresh must land on a LIVE project of the organisation — or on none — whatever the de-fallback flag says. Real database.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_5041_agent_action_realdb import (  # the same seed as the approval-flow tests
    _REAL_DB_URL,
    _dispose_global_engine_after_test,  # noqa: F401  (autouse fixture)
    _seed,
    _session_factory,
    anyio_backend,  # noqa: F401
)

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="needs a real PG (PARITY/ALEMBIC_DATABASE_URL)")]


async def _other_live_project(Session, d):
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    async with Session() as s:
        p2 = Project(id=uuid.uuid4(), org_id=d["org_id"], name="The other live project")
        s.add(p2)
        await s.commit()
        s.add(ProjectAccess(id=uuid.uuid4(), project_id=p2.id, org_member_id=d["admin_om"], member_id=d["admin_om"], permission="granted"))
        await s.commit()
        return p2.id


async def _mark_deleted_and_point_at_it(Session, d, *, last_org: bool):
    from sqlalchemy import text, update

    from app.models.user import User

    async with Session() as s:
        await s.execute(text("UPDATE projects SET deleted_at = now() WHERE id = :p"), {"p": d["project_id"]})
        await s.execute(update(User).where(User.id == d["admin_user"]).values(last_project_id=d["project_id"], last_org_id=d["org_id"] if last_org else None))
        await s.commit()


async def _answers(Session, d):
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
        "refresh_with_old_project": await one(lambda u, s: _refresh_session_context(u, s, d["org_id"], d["project_id"])),
    }


@pytest.mark.anyio
@pytest.mark.parametrize("flag", [False, True])
@pytest.mark.parametrize("last_org", [True, False])
async def test_a_project_only_marked_deleted_is_never_where_the_next_session_lands(monkeypatch, flag, last_org):
    from app.core.config import settings

    monkeypatch.setattr(settings, "build_app_metadata_defallback", flag)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        other = await _other_live_project(Session, d)
        await _mark_deleted_and_point_at_it(Session, d, last_org=last_org)
        for where, md in (await _answers(Session, d)).items():
            assert "raised" not in md, (flag, last_org, where, md)
            assert md.get("project_id") != str(d["project_id"]), (flag, last_org, where, "the project marked deleted")
            assert md.get("project_id") == str(other), (flag, last_org, where, md.get("project_id"), "the person's other live project")
    finally:
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("flag", [False, True])
async def test_with_no_other_project_the_next_session_names_none(monkeypatch, flag):
    from app.core.config import settings

    monkeypatch.setattr(settings, "build_app_metadata_defallback", flag)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _mark_deleted_and_point_at_it(Session, d, last_org=True)
        for where, md in (await _answers(Session, d)).items():
            assert "raised" not in md, (flag, where, md)
            assert md.get("project_id") in ("", None), (flag, where, md.get("project_id"))
    finally:
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("flag", [False, True])
async def test_a_last_project_of_another_organisation_never_makes_a_claim_that_names_a_project_outside_its_org(monkeypatch, flag):
    """the other shape of «current project that answers nowhere»: the person belongs to two organisations and `last_project_id` is a LIVE project of the OTHER one — the claim must still be one consistent pair (the org, and a project of THAT org)"""
    from sqlalchemy import select, update

    from app.core.config import settings
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from app.routers.auth import _build_app_metadata
    from app.services.agent_anchor_sync import ensure_human_member

    monkeypatch.setattr(settings, "build_app_metadata_defallback", flag)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            a = await _seed(s)
            b = await _seed(s)
            om = OrgMember(id=uuid.uuid4(), org_id=b["org_id"], user_id=a["admin_user"], role="member")
            s.add(om)
            await s.commit()
            await ensure_human_member(s, om.id)
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=b["project_id"], org_member_id=om.id, member_id=om.id, permission="granted"))
            await s.execute(update(User).where(User.id == a["admin_user"]).values(last_project_id=b["project_id"], last_org_id=a["org_id"]))
            await s.commit()
        async with Session() as s:
            user = (await s.execute(select(User).where(User.id == a["admin_user"]))).scalar_one()
            md = await _build_app_metadata(user, s)
        assert md.get("org_id") == str(a["org_id"]), md
        assert md.get("project_id") == str(a["project_id"]), (flag, "the claim's project must be a project of the claim's org", md.get("project_id"))
    finally:
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("flag", [False, True])
@pytest.mark.parametrize("which_org", ["a", "b", "none"])
async def test_a_person_in_two_organisations_with_no_stored_project_signs_in_to_one_consistent_pair(monkeypatch, flag, which_org):
    """PO's dev measurement of the QA person: `users.last_project_id` NULL, a team-member row in each of TWO organisations, nothing deleted — and the sign-in still answered a current project that is nowhere in the person's list. Whatever
    `last_org_id` says (either org, or none), the claim must be ONE pair: the organisation, and a LIVE project of THAT organisation the person can reach."""
    from sqlalchemy import select, update

    from app.core.config import settings
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from app.routers.auth import _sign_in_session_context
    from app.services.agent_anchor_sync import ensure_human_member
    from app.services.project_auth import has_project_access

    monkeypatch.setattr(settings, "build_app_metadata_defallback", flag)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            a = await _seed(s)
            b = await _seed(s)
            om = OrgMember(id=uuid.uuid4(), org_id=b["org_id"], user_id=a["admin_user"], role="member")
            s.add(om)
            await s.commit()
            await ensure_human_member(s, om.id)
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=b["project_id"], org_member_id=om.id, member_id=om.id, permission="granted"))
            last_org = {"a": a["org_id"], "b": b["org_id"], "none": None}[which_org]
            await s.execute(update(User).where(User.id == a["admin_user"]).values(last_project_id=None, last_org_id=last_org))
            await s.commit()
        async with Session() as s:
            user = (await s.execute(select(User).where(User.id == a["admin_user"]))).scalar_one()
            md = await _sign_in_session_context(user, s)
            org = uuid.UUID(md["org_id"])
            pid = uuid.UUID(md["project_id"]) if md.get("project_id") else None
            assert org in (a["org_id"], b["org_id"]), md
            if pid is not None:
                proj = (await s.execute(select(Project.org_id, Project.deleted_at).where(Project.id == pid))).first()
                assert proj is not None and proj[1] is None, (flag, which_org, "the claim's project is a live row", md)
                assert proj[0] == org, (flag, which_org, "the claim's project belongs to the claim's org", md)
                assert await has_project_access(s, user.id, pid, org), (flag, which_org, "and the person can reach it", md)
    finally:
        await engine.dispose()
