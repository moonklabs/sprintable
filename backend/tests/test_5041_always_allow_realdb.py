"""story 5041 ② (server, step 3) — the card's «이번만 승인 / 이 에이전트는 이 프로젝트에서 늘 허용».

`POST /agent-actions/{id}/decision` with `always_allow: true` APPROVES this ask and ALSO saves «always allow» for this agent × this project × this action — the same setting the settings API makes — in the same commit as the claim.
Only an organisation owner / admin's person session; only an action that has an auto slot; refused BEFORE anything is claimed. Proven on a real database through the real routes, end to end: after the press the
same agent's next call in the same project runs without a card, another project and another agent still get one.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_5041_agent_action_realdb import (  # the same seed and «who makes the next call» as the approval-flow tests
    _REAL_DB_URL,
    _act_as,
    _client_for,
    _dispose_global_engine_after_test,  # noqa: F401  (autouse fixture)
    _exists,
    _requests,
    _seed,
    _session_factory,
    anyio_backend,  # noqa: F401
)

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="needs a real PG (PARITY/ALEMBIC_DATABASE_URL)")]


async def _ask(app, Session, d, path):
    await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
    async with _client_for(app) as c:
        r = await c.delete(path)
    assert r.status_code == 202, r.text
    return r.json()["request_id"]


async def _story_in(Session, d, project_id, title):
    from app.models.pm import Story

    async with Session() as s:
        story = Story(id=uuid.uuid4(), org_id=d["org_id"], project_id=project_id, title=title, status="backlog")
        s.add(story)
        await s.commit()
        return story.id


@pytest.mark.anyio
async def test_approve_with_always_allow_saves_the_setting_and_the_next_call_runs_without_a_card():
    from sqlalchemy import text

    from app.main import app
    from app.models.member import Member
    from app.models.pm import Story
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.services.agent_action_policy import resolve_action_level

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            p2 = Project(id=uuid.uuid4(), org_id=d["org_id"], name="Second Project")
            other = Member(id=uuid.uuid4(), org_id=d["org_id"], type="agent", name="Other Agent", is_active=True, owner_member_id=d["admin_om"])
            s.add_all([p2, other])
            await s.commit()
            s.add_all([
                ProjectAccess(id=uuid.uuid4(), project_id=p2.id, member_id=d["agent_id"], permission="granted", role="member"),
                ProjectAccess(id=uuid.uuid4(), project_id=d["project_id"], member_id=other.id, permission="granted", role="member"),
            ])
            await s.commit()
        second_story = await _story_in(Session, d, d["project_id"], "second story, same project")
        other_project_story = await _story_in(Session, d, p2.id, "story in the second project")

        rid = await _ask(app, Session, d, f"/api/v2/stories/{d['story_id']}")
        # the card offers it to an organisation admin — not to the plain member
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            assert (await c.get(f"/api/v2/agent-actions/{rid}")).json()["always_allow_available"] is True
        await _act_as(app, Session, d["member_user"], d["org_id"])
        async with _client_for(app) as c:
            assert (await c.get(f"/api/v2/agent-actions/{rid}")).json()["always_allow_available"] is False

        # the admin approves AND allows for good
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            pressed = await c.post(f"/api/v2/agent-actions/{rid}/decision", json={"decision": "approve", "always_allow": True})
        assert pressed.status_code == 200 and pressed.json()["state"] == "executed", pressed.text
        assert not await _exists(Session, Story, d["story_id"]), "this ask was approved and ran, as the person"
        async with Session() as s:
            assert await resolve_action_level(s, org_id=d["org_id"], project_id=d["project_id"], agent_id=d["agent_id"], action_key="story.delete") == ("auto", "project_agent")
            assert await resolve_action_level(s, org_id=d["org_id"], project_id=p2.id, agent_id=d["agent_id"], action_key="story.delete") == ("ask", "default"), "another project is not touched"
            assert await resolve_action_level(s, org_id=d["org_id"], project_id=d["project_id"], agent_id=other.id, action_key="story.delete") == ("ask", "default"), "another agent is not touched"
            via = (await s.execute(text("SELECT context FROM activity_logs WHERE org_id = :o AND action = 'agent_action_policy.set'"), {"o": d["org_id"]})).scalars().all()
        assert len(via) == 1 and via[0]["via"] == "card" and via[0]["level_after"] == "auto"

        # the SAME agent, project, action: no card now; the others still get one
        before = len(await _requests(Session, d["org_id"]))
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            done = await c.delete(f"/api/v2/stories/{second_story}")
            elsewhere = await c.delete(f"/api/v2/stories/{other_project_story}")
        assert done.status_code == 200 and not await _exists(Session, Story, second_story), done.text
        assert elsewhere.status_code == 202 and await _exists(Session, Story, other_project_story), "the same agent in another project is still asked"
        await _act_as(app, Session, other.id, d["org_id"], api_key=True)
        async with _client_for(app) as c:
            third = await _story_in(Session, d, d["project_id"], "third story")
            assert (await c.delete(f"/api/v2/stories/{third}")).status_code == 202, "another agent in the same project is still asked"
        assert len(await _requests(Session, d["org_id"])) == before + 2
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_always_allow_is_refused_before_anything_is_claimed():
    from app.main import app
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        rid = await _ask(app, Session, d, f"/api/v2/stories/{d['story_id']}")
        goal_rid = await _ask(app, Session, d, f"/api/v2/goals/{d['goal_id']}")

        # a plain member: not an organisation admin → 403, the ask is still pending and untouched
        await _act_as(app, Session, d["member_user"], d["org_id"])
        async with _client_for(app) as c:
            refused = await c.post(f"/api/v2/agent-actions/{rid}/decision", json={"decision": "approve", "always_allow": True})
        assert refused.status_code == 403 and refused.json()["error"]["code"] == "AGENT_ACTION_ALWAYS_ALLOW_ADMIN_REQUIRED", refused.text

        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            # with a rejection it means nothing
            r1 = await c.post(f"/api/v2/agent-actions/{rid}/decision", json={"decision": "reject", "always_allow": True})
            assert r1.status_code == 422 and r1.json()["error"]["code"] == "AGENT_ACTION_ALWAYS_ALLOW_NEEDS_APPROVE", r1.text
            # an action with no auto slot (a goal takes its stories with it): the card never offers it, the route refuses it
            assert (await c.get(f"/api/v2/agent-actions/{goal_rid}")).json()["always_allow_available"] is False
            r2 = await c.post(f"/api/v2/agent-actions/{goal_rid}/decision", json={"decision": "approve", "always_allow": True})
            assert r2.status_code == 409 and r2.json()["error"]["code"] == "AGENT_ACTION_ALWAYS_ALLOW_NOT_AVAILABLE", r2.text
            states = {r.id: r.status for r in await _requests(Session, d["org_id"])}
        assert set(states.values()) == {"pending"} and await _exists(Session, Story, d["story_id"]), "every refusal left the asks pending and nothing deleted"

        # a plain approval saves nothing
        async with _client_for(app) as c:
            ok = await c.post(f"/api/v2/agent-actions/{rid}/decision", json={"decision": "approve"})
        assert ok.status_code == 200, ok.text
        from app.services.agent_action_policy import resolve_action_level

        async with Session() as s:
            assert await resolve_action_level(s, org_id=d["org_id"], project_id=d["project_id"], agent_id=d["agent_id"], action_key="story.delete") == ("ask", "default")
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
