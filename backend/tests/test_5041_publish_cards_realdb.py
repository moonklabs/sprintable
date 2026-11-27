"""story 5041 B2 — what goes out to the world (rows 35 · 36 · 38 · 39 · 85 · 86 · 87): an agent's publish · cancel-scheduled · unpublish of a channel post, retry of a stopped publication, and the site post's publish (from a body, from a draft) and unpublish
are kept as an approval card a person presses and then go out in THEIR name. Real database, the real routes. The cancel / unpublish roads demand an organisation owner / admin — an agent never is one — so the setting never lets them through: always a card (or a block).
"""
from __future__ import annotations

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
from tests.test_3806_ads_boost_gate import _configure_secrets  # noqa: F401,E402 — autouse: the channel-credential key the seeded connection needs

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="needs a real PG (PARITY/ALEMBIC_DATABASE_URL)")]

POLICY = "/api/v2/agent-action-policy"


async def _drafts(Session, d):
    """a channel post draft and a site post draft on the seed's story → (channel draft id, site draft id)"""
    from app.models.channel_post_draft import ChannelPostDraft
    from app.models.site_post_draft import SitePostDraft
    from tests.test_3497_insight_snapshots import _seed_channel_connection

    async with Session() as s:
        conn = await _seed_channel_connection(s, d["org_id"], channel="threads")
        cd = ChannelPostDraft(id=uuid.uuid4(), org_id=d["org_id"], work_item_id=d["story_id"], channel="threads", connection_id=conn.id, status="draft")
        sd = SitePostDraft(id=uuid.uuid4(), org_id=d["org_id"], work_item_id=d["story_id"], slug="hello", status="draft")
        s.add_all([cd, sd])
        await s.commit()
        return cd.id, sd.id


async def _as_agent(app, Session, d, method, path, body=None):
    await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
    async with _client_for(app) as c:
        return await c.request(method, path, json=body) if body is not None else await c.request(method, path)


@pytest.mark.anyio
@pytest.mark.parametrize("key, kind, suffix", [
    ("channel_post.publish", "channel", "publish"),
    ("channel_post.cancel_scheduled", "channel", "cancel-scheduled"),
    ("channel_post.unpublish", "channel", "unpublish"),
    ("site_post.publish_draft", "site", "publish"),
    ("site_post.unpublish", "site", "unpublish"),
])
async def test_an_agents_call_is_a_card_naming_the_story_and_nothing_goes_out(key, kind, suffix):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        cd, sd = await _drafts(Session, d)
        path = f"/api/v2/organizations/{d['org_id']}/{'channel-posts' if kind == 'channel' else 'site-posts'}/drafts/{cd if kind == 'channel' else sd}/{suffix}"
        r = await _as_agent(app, Session, d, "POST", path)
        assert r.status_code == 202 and r.json()["status"] == "pending_approval", r.text
        assert (await _as_agent(app, Session, d, "POST", path)).status_code == 202
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1, "the same call again is the same card"
        assert reqs[0].hitl_metadata["action_key"] == key and reqs[0].hitl_metadata["snapshot"]["path"] == path
        assert reqs[0].hitl_metadata["snapshot"]["body_b64"] == "", "no body rides along"
        assert "Story to delete" in reqs[0].title, reqs[0].title  # the seed's story names the card
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_site_post_from_a_body_keeps_its_body_and_names_the_title_and_a_person_who_presses_goes_through_the_road():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        body = {"work_item_id": str(d["story_id"]), "title": "Hello world", "slug": "hello", "lang": "en", "summary": "s", "tags": [], "body_md": "# hi"}
        path = f"/api/v2/organizations/{d['org_id']}/site-posts"
        r = await _as_agent(app, Session, d, "POST", path, body)
        assert r.status_code == 202, r.text
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1 and "Hello world" in reqs[0].title and reqs[0].hitl_metadata["action_key"] == "site_post.publish"
        # a person presses: the stored call runs as THEM through the road — the road's own gate check (no approved gate here) says no, and the ask stays honest about it
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            pressed = await c.post(f"/api/v2/agent-actions/{reqs[0].id}/decision", json={"decision": "approve"})
        assert pressed.status_code == 403 and pressed.json()["error"]["code"] == "AGENT_ACTION_FORBIDDEN_FOR_APPROVER", pressed.text
        assert {r.status for r in await _requests(Session, d["org_id"])} == {"pending"}, "the road said no to the presser, so the ask stays open for the next person — nothing went out"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_retry_of_a_stopped_publication_is_a_card_by_either_path_and_carries_no_body():
    from app.main import app
    from app.models.publication_command import PublicationCommand
    from app.services.gate_service import create_gate
    from tests.test_e4fc29fa_site_post_orchestration import _seed_default_role

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            role_id = await _seed_default_role(s, d["org_id"])
            gate = await create_gate(s, d["org_id"], d["story_id"], "story", "external_publish", d["admin_om"], role_id)
            await s.commit()
            cmd = PublicationCommand(
                id=uuid.uuid4(), org_id=d["org_id"], gate_id=gate.id, destination=uuid.uuid4(), approved_version=uuid.uuid4(),
                operation="publish", status="dead_letter", requested_by_member_id=d["admin_om"],
            )
            s.add(cmd)
            await s.commit()
        for tail in (f"publication-commands/{cmd.id}/retry", f"channel-posts/publication-commands/{cmd.id}/retry"):
            r = await _as_agent(app, Session, d, "POST", f"/api/v2/organizations/{d['org_id']}/{tail}", {"confirmed_no_campaign": True})
            assert r.status_code == 202, (tail, r.text)
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 2 and {r.hitl_metadata["action_key"] for r in reqs} == {"publication.retry"}
        assert all(r.hitl_metadata["snapshot"]["body_b64"] == "" for r in reqs), "the person's «I checked the ad account» confirmation is never carried by an agent"
        # a command whose gate the agent cannot reach is the road's plain «not found»
        ghost = await _as_agent(app, Session, d, "POST", f"/api/v2/organizations/{d['org_id']}/publication-commands/{uuid.uuid4()}/retry")
        assert ghost.status_code == 404
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_setting_decides_block_refuses_with_nothing_kept_and_auto_is_not_a_slot_for_the_owner_admin_roads():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        cd, _sd = await _drafts(Session, d)
        base = f"/api/v2/organizations/{d['org_id']}/channel-posts/drafts/{cd}"
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            ok = await c.put(POLICY, json={"action_key": "channel_post.publish", "level": "block", "project_id": str(d["project_id"])})
            assert ok.status_code == 200, ok.text
            # the road that demands an owner / admin has no «always allow»
            no = await c.put(POLICY, json={"action_key": "channel_post.unpublish", "level": "auto", "project_id": str(d["project_id"]), "agent_id": str(d["agent_id"])})
            assert no.status_code == 422 and no.json()["error"]["code"] == "ACTION_POLICY_NO_AUTO_SLOT", no.text
        blocked = await _as_agent(app, Session, d, "POST", f"{base}/publish")
        assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "AGENT_ACTION_BLOCKED", blocked.text
        assert await _requests(Session, d["org_id"]) == []
        # a hand-written `auto` row for the unpublish road is not honoured: the agent still gets the card
        from sqlalchemy import text

        async with Session() as s:
            await s.execute(text("INSERT INTO hitl_gate_config (org_id, project_id, agent_id, work_type, actor_type, level) VALUES (:o, :p, :a, 'action:channel_post.unpublish', 'agent', 'auto')"),
                            {"o": d["org_id"], "p": d["project_id"], "a": d["agent_id"]})
            await s.commit()
        again = await _as_agent(app, Session, d, "POST", f"{base}/unpublish")
        assert again.status_code == 202, again.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_an_agent_that_cannot_see_the_drafts_project_gets_the_roads_own_404_and_a_person_is_unchanged():
    from app.main import app
    from app.models.member import Member
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            outsider = Member(id=uuid.uuid4(), org_id=d["org_id"], type="agent", name="Outsider", is_active=True, owner_member_id=d["admin_om"])
            p2 = Project(id=uuid.uuid4(), org_id=d["org_id"], name="Elsewhere")
            s.add_all([outsider, p2])
            await s.commit()
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=p2.id, member_id=outsider.id, permission="granted", role="member"))
            await s.commit()
        cd, _sd = await _drafts(Session, d)
        await _act_as(app, Session, outsider.id, d["org_id"], api_key=True)
        async with _client_for(app) as c:
            r = await c.post(f"/api/v2/organizations/{d['org_id']}/channel-posts/drafts/{cd}/publish")
            ghost = await c.post(f"/api/v2/organizations/{d['org_id']}/channel-posts/drafts/{uuid.uuid4()}/publish")
        assert r.status_code == 404 and ghost.status_code == 404, (r.text, ghost.text)
        assert await _requests(Session, d["org_id"]) == []
        # a person's own call makes no card
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            await c.post(f"/api/v2/organizations/{d['org_id']}/channel-posts/drafts/{cd}/publish")
        assert await _requests(Session, d["org_id"]) == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
