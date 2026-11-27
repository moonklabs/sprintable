"""story 5041 (C0b) ② — the «바로» rows (PO 11-27 seq 20558): an agent may do what a person does on screen for these, and nothing else changes.

For each lifted road: the agent key is NOT answered with the old «human only» 403 (put the guard back and this goes RED), and the person is answered as before.
For the siblings in the same files that stay a person's (publish · start · resume · cancel of an ad boost): the agent is STILL refused (the lift did not leak sideways).
The owner/admin · role-cap · rate-limit · organisation-boundary checks are not touched — only the «who is it» 403 went.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_5041_agent_action_realdb import (  # the same seed and the same «who makes the next call» as the approval-flow tests
    _REAL_DB_URL,
    _act_as,
    _client_for,
    _dispose_global_engine_after_test,  # noqa: F401  (autouse fixture)
    _seed,
    _session_factory,
    anyio_backend,  # noqa: F401
)

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="needs a real PG (PARITY/ALEMBIC_DATABASE_URL)")]

_OLD_WORDS = ("HUMAN_ONLY", "person_session_required", "휴먼 멤버만", "human only")


def _refused_as_human_only(resp) -> bool:
    return resp.status_code == 403 and any(w in resp.text for w in _OLD_WORDS)


def _roads(org_id, project_id):
    o = f"/api/v2/organizations/{org_id}"
    nobody = uuid.uuid4()
    return [
        # 19 · 20 — a campaign is a name and two dates
        ("campaign create", "POST", f"{o}/campaigns", {"name": "from an agent"}),
        # 30 · 31 — turn a comment into a story · 32 — send a reply for approval (the gate is opened, the send waits for a person)
        ("comment follow-up", "POST", f"{o}/comments/{nobody}/follow-ups", {"title": "t"}),
        ("comment reply submit", "POST", f"{o}/comments/{nobody}/replies/{nobody}/submit", None),
        # 33 · 34 — a manual comment refresh (5 minutes per publication)
        ("comments refresh", "POST", f"{o}/publications/{nobody}/comments/refresh", None),
        # 63 · 64 — sort and assign a collected comment
        ("engagement patch", "PATCH", f"{o}/engagement/items/{nobody}", {"triage_status": "done"}),
        # 70 · 71 — a follow-up story from a publication
        ("publication follow-up", "POST", f"{o}/publications/{nobody}/follow-ups", {"kind": "edit"}),
        # 75 · 76 — ask for a newsletter send (opens the gate)
        ("newsletter send request", "POST", f"{o}/publications/{nobody}/newsletter-sends", {"segment_name": "all", "scheduled_at": "2030-01-01T00:00:00Z"}),
        # 9 · 12 — stop the spend · read it again
        ("ads boost pause", "POST", f"{o}/ads-boosts/{nobody}/pause", None),
        ("ads boost spend refresh", "POST", f"{o}/ads-boosts/{nobody}/spend/refresh", None),
        # 40 — stop a send that has not left yet
        ("cancel an unstarted publish", "POST", f"{o}/channel-posts/drafts/{nobody}/cancel-publish", None),
        # 79 — the generation connectors list has no credential in it
        ("generation connectors list", "GET", f"{o}/generation-connectors", None),
    ]


def _stays_with_a_person(org_id):
    o = f"/api/v2/organizations/{org_id}"
    nobody = uuid.uuid4()
    return [
        ("ads boost start", "POST", f"{o}/ads-boosts/{nobody}/start", {}),
        ("ads boost resume", "POST", f"{o}/ads-boosts/{nobody}/resume", None),
        ("ads boost cancel", "POST", f"{o}/ads-boosts/{nobody}/cancel", None),
        ("channel post publish", "POST", f"{o}/channel-posts/drafts/{nobody}/publish", {}),
    ]


async def _call(c, method, path, body):
    return await c.request(method, path, json=body) if body is not None else await c.request(method, path)


@pytest.mark.anyio
async def test_the_lifted_roads_do_not_answer_an_agent_with_the_human_only_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        refused = []
        for who, kw in (("agent", {"api_key": True}), ("person", {})):
            uid = d["agent_id"] if who == "agent" else d["admin_user"]
            await _act_as(app, Session, uid, d["org_id"], **kw)
            async with _client_for(app) as c:
                for name, method, path, body in _roads(d["org_id"], d["project_id"]):
                    r = await _call(c, method, path, body)
                    if _refused_as_human_only(r):
                        refused.append((who, name, r.status_code, r.text[:120]))
        assert refused == [], f"still answered as «human only»: {refused}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_siblings_that_stay_with_a_person_still_refuse_an_agent():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            for name, method, path, body in _stays_with_a_person(d["org_id"]):
                r = await _call(c, method, path, body)
                assert r.status_code == 403, f"{name}: the agent got {r.status_code} {r.text[:160]}"
                assert "HUMAN_ONLY" in r.text, f"{name}: {r.text[:160]}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_an_agent_makes_a_campaign_and_it_is_recorded_as_the_agent():
    from sqlalchemy import text

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            r = await c.post(f"/api/v2/organizations/{d['org_id']}/campaigns", json={"name": "made by an agent"})
        assert r.status_code == 201, r.text
        async with Session() as s:
            who = (await s.execute(text("SELECT created_by_member_id FROM campaigns WHERE id = :i"), {"i": r.json()["id"]})).scalar_one()
        assert who == d["agent_id"], "the maker is the agent, not a stand-in person"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_an_agent_reads_a_run_profile_but_cannot_change_it():
    from app.main import app
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            other = Member(id=uuid.uuid4(), org_id=d["org_id"], type="agent", name="Other Agent", is_active=True, owner_member_id=d["admin_om"])
            s.add(other)
            await s.commit()
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=d["project_id"], member_id=other.id, permission="granted", role="member"))
            await s.commit()
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            r = await c.get(f"/api/v2/agents/{other.id}/run-profile")
            assert r.status_code == 200, r.text
            assert r.json()["can_change"] is False, "worked out for this caller: an agent never changes a run profile"
            assert r.json()["can_change_unattended"] is False
            put = await c.put(f"/api/v2/agents/{other.id}/run-profile", json={"model": "opus", "effort": None})
            assert put.status_code == 403, "the write stays with a person's own session"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_an_agent_reader_is_never_told_it_can_change_a_run_profile(monkeypatch):
    """Kadir's audit of 6018 (L2): `may_change` could say yes for an agent that made the profile's agent — the write is a person's session only, so an agent's read says no whatever the rule answers"""
    from app.main import app
    from app.models.member import Member
    from app.models.project_access import ProjectAccess
    from app.services import agent_run_profile

    async def _yes(*a, **k):
        return True

    monkeypatch.setattr(agent_run_profile, "may_change", _yes)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            other = Member(id=uuid.uuid4(), org_id=d["org_id"], type="agent", name="Made By Agent", is_active=True, owner_member_id=d["admin_om"])
            s.add(other)
            await s.commit()
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=d["project_id"], member_id=other.id, permission="granted", role="member"))
            await s.commit()
        await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
        async with _client_for(app) as c:
            agent_view = (await c.get(f"/api/v2/agents/{other.id}/run-profile")).json()
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            person_view = (await c.get(f"/api/v2/agents/{other.id}/run-profile")).json()
        assert agent_view["can_change"] is False and agent_view["can_change_unattended"] is False
        assert person_view["can_change"] is True, "the same rule still answers a person"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
