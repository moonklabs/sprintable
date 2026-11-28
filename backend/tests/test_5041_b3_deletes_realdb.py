"""story 5041 B3 — the two big deletions an agent may ASK for: a project (rows 56..) and the whole organisation.

Always a card (no `auto` slot) — a person presses it and the stored call runs as THEM, so the road still asks the presser for the right (a project: organisation owner / admin · the organisation: the owner). The card says what goes with it,
in numbers. Real database, the real routes.
"""
from __future__ import annotations

import re
import uuid

import pytest

from tests.test_5041_agent_action_realdb import (  # the same seed and «who makes the next call» as the approval-flow tests
    _REAL_DB_URL,
    _act_as,
    _client_for,
    _dispose_global_engine_after_test,  # noqa: F401  (autouse fixture)
    _requests,
    _seed,
    _session_factory,
    anyio_backend,  # noqa: F401
)

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="needs a real PG (PARITY/ALEMBIC_DATABASE_URL)")]


async def _as_agent(app, Session, d, method, path, body=None):
    await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
    async with _client_for(app) as c:
        return await c.request(method, path, json=body) if body is not None else await c.request(method, path)


async def _an_owner(Session, d):
    from app.models.project import OrgMember
    from app.models.user import User
    from app.services.agent_anchor_sync import ensure_human_member

    async with Session() as s:
        uid = uuid.uuid4()
        s.add(User(id=uid, email=f"owner-{uid.hex[:8]}@test.com", hashed_password="x"))
        await s.commit()
        om = OrgMember(id=uuid.uuid4(), org_id=d["org_id"], user_id=uid, role="owner")
        s.add(om)
        await s.commit()
        await ensure_human_member(s, om.id)
        return uid


@pytest.mark.anyio
async def test_a_project_an_agent_deletes_is_a_card_naming_what_goes_with_it_and_an_admin_presses_it():
    from sqlalchemy import select

    from app.main import app
    from app.models.project import Project

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        path = f"/api/v2/projects/{d['project_id']}"
        r = await _as_agent(app, Session, d, "DELETE", path)
        assert r.status_code == 202 and r.json()["status"] == "pending_approval", r.text
        assert (await _as_agent(app, Session, d, "DELETE", path)).status_code == 202
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1 and reqs[0].hitl_metadata["action_key"] == "project.delete"
        # the seed holds two stories and one task: the numbers are on the card, with the name
        assert "5041 Project" in reqs[0].title and re.search(r"(스토리 2개|2 stories)", reqs[0].title) and re.search(r"(할 일 1개|1 tasks)", reqs[0].title), reqs[0].title

        async def _alive():
            async with Session() as s:
                return (await s.execute(select(Project.id).where(Project.id == d["project_id"], Project.deleted_at.is_(None)))).scalar_one_or_none() is not None

        assert await _alive(), "the ask deletes nothing"
        # a plain member cannot press it into a deletion: the road's own 403, the ask stays open
        await _act_as(app, Session, d["member_user"], d["org_id"])
        async with _client_for(app) as c:
            refused = await c.post(f"/api/v2/agent-actions/{reqs[0].id}/decision", json={"decision": "approve"})
        assert refused.json().get("state") != "executed" and await _alive(), refused.text
        assert {x.status for x in await _requests(Session, d["org_id"])} == {"pending"}
        # the organisation admin presses: the project is gone, by them
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            ok = await c.post(f"/api/v2/agent-actions/{reqs[0].id}/decision", json={"decision": "approve"})
        assert ok.status_code == 200 and ok.json()["state"] == "executed", ok.text
        assert not await _alive()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_project_the_agent_cannot_see_is_a_404_with_no_card_and_neither_delete_has_an_auto_slot_or_survives_a_block():
    from app.main import app
    from app.models.project import Project
    from app.services.agent_action_policy import NO_AUTO

    assert {"org.delete", "project.delete"} <= NO_AUTO
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            hidden = Project(id=uuid.uuid4(), org_id=d["org_id"], name="Not the agent's")
            s.add(hidden)
            await s.commit()
        r = await _as_agent(app, Session, d, "DELETE", f"/api/v2/projects/{hidden.id}")
        assert r.status_code == 404, r.text
        assert (await _as_agent(app, Session, d, "DELETE", f"/api/v2/projects/{uuid.uuid4()}")).status_code == 404
        assert await _requests(Session, d["org_id"]) == []

        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            for key in ("org.delete", "project.delete"):
                auto = await c.put("/api/v2/agent-action-policy", json={"action_key": key, "level": "auto", "project_id": str(d["project_id"]), "agent_id": str(d["agent_id"])})
                assert auto.status_code == 422 and auto.json()["error"]["code"] == "ACTION_POLICY_NO_AUTO_SLOT", (key, auto.text)
                blk = await c.put("/api/v2/agent-action-policy", json={"action_key": key, "level": "block", "project_id": str(d["project_id"])})
                assert blk.status_code == 200, (key, blk.text)
        blocked = await _as_agent(app, Session, d, "DELETE", f"/api/v2/projects/{d['project_id']}")
        assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "AGENT_ACTION_BLOCKED", blocked.text
        blocked_org = await _as_agent(app, Session, d, "DELETE", f"/api/v2/organizations/{d['org_id']}", {"confirmation": "5041 Org"})
        assert blocked_org.status_code == 403 and blocked_org.json()["error"]["code"] == "AGENT_ACTION_BLOCKED", blocked_org.text
        assert await _requests(Session, d["org_id"]) == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_an_organisation_an_agent_deletes_is_a_card_only_the_owner_can_press_and_a_foreign_organisation_is_never_reached():
    from sqlalchemy import select

    from app.main import app
    from app.models.organization import Organization

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            foreign = Organization(id=uuid.uuid4(), name="Somebody else", slug=f"fx-{uuid.uuid4().hex[:8]}")
            s.add(foreign)
            await s.commit()
        owner = await _an_owner(Session, d)
        path = f"/api/v2/organizations/{d['org_id']}"

        # the confirmation must already be the organisation's name: the road's own 422, no card for a call that cannot succeed
        wrong = await _as_agent(app, Session, d, "DELETE", path, {"confirmation": "not the name"})
        assert wrong.status_code == 422, wrong.text
        assert await _requests(Session, d["org_id"]) == []
        # another organisation's id: the agent is not its member — the road's own refusal, no card anywhere
        other = await _as_agent(app, Session, d, "DELETE", f"/api/v2/organizations/{foreign.id}", {"confirmation": "Somebody else"})
        assert other.status_code in (403, 404), other.text
        assert await _requests(Session, d["org_id"]) == [] and await _requests(Session, foreign.id) == []

        r = await _as_agent(app, Session, d, "DELETE", path, {"confirmation": "5041 Org"})
        assert r.status_code == 202 and r.json()["status"] == "pending_approval", r.text
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1 and reqs[0].hitl_metadata["action_key"] == "org.delete"
        assert "5041 Org" in reqs[0].title and re.search(r"(프로젝트 1개|1 projects)", reqs[0].title) and re.search(r"(스토리 2개|2 stories)", reqs[0].title), reqs[0].title

        async def _alive():
            async with Session() as s:
                return (await s.execute(select(Organization.id).where(Organization.id == d["org_id"]))).scalar_one_or_none() is not None

        # the agent reads ITS OWN ask without the organisation-wide numbers (it may hold only some of the projects); the person's card has them
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            own = (await c.get(f"/api/v2/agent-actions/{reqs[0].id}")).json()
        assert own["state"] == "pending" and not re.search(r"(프로젝트 \d+개|\d+ projects)", own["title"]), own
        # an admin is not the owner: the road's own 403, the ask stays open, the organisation stays
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            refused = await c.post(f"/api/v2/agent-actions/{reqs[0].id}/decision", json={"decision": "approve"})
        assert refused.json().get("state") != "executed" and await _alive(), refused.text
        assert {x.status for x in await _requests(Session, d["org_id"])} == {"pending"}
        # the owner presses: it is gone, by them
        await _act_as(app, Session, owner, d["org_id"])
        async with _client_for(app) as c:
            ok = await c.post(f"/api/v2/agent-actions/{reqs[0].id}/decision", json={"decision": "approve"})
        assert ok.status_code == 200 and ok.json()["state"] == "executed", ok.text
        assert not await _alive()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
