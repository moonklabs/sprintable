"""story 5041 (PO 11-28, ④ lap · DIAG): a person who belongs to an organisation that has NO project.

The lap measured it on dev: `/api/current-project` named «project 53839743 in org 53839743» — the ORGANISATION id in the project slot — and the next call that took it for a project (`POST /agents` with `project_ids`) answered
400 «project_ids not in org». The source is `GET /api/v2/me` (and the PATCH): for an organisation-member-only person it filled a missing project with `org_member.org_id`, because `MeResponse.project_id` was a required UUID.
«No project» must be said as no project: `project_id` is null, and nothing may stand in for it. Real database, the real roads.
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


async def _admin_in_an_org_with_no_project(app, Session):
    """the seed's admin, after the organisation's only project is deleted through the real road: an organisation member, no project row at all"""
    async with Session() as s:
        d = await _seed(s)
    await _act_as(app, Session, d["admin_user"], d["org_id"])
    async with _client_for(app) as c:
        gone = await c.delete(f"/api/v2/projects/{d['project_id']}")
    assert gone.status_code == 200, gone.text
    return d


@pytest.mark.anyio
async def test_get_me_of_a_person_in_an_organisation_without_a_project_says_no_project_not_the_organisation_id():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        d = await _admin_in_an_org_with_no_project(app, Session)
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            r = await c.get("/api/v2/me")
        assert r.status_code == 200, r.text
        body = r.json()
        body = body.get("data", body)
        assert body["org_id"] == str(d["org_id"])
        assert body["project_id"] is None, ("the organisation id must not stand in for a project", body["project_id"])
        assert body.get("project_name") is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_me_says_the_same():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        d = await _admin_in_an_org_with_no_project(app, Session)
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            r = await c.patch("/api/v2/me", json={"name": "Renamed Person"})
        assert r.status_code == 200, r.text
        body = r.json()
        body = body.get("data", body)
        assert body["name"] == "Renamed Person" and body["org_id"] == str(d["org_id"])
        assert body["project_id"] is None, ("the organisation id must not stand in for a project", body["project_id"])
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_claim_that_names_a_project_is_still_answered_as_that_project():
    """the other side, unchanged: a session whose claim names a live project (the person is a member of it) still gets that project"""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["admin_user"], d["org_id"], project_id=d["project_id"])
        async with _client_for(app) as c:
            r = await c.get("/api/v2/me")
        assert r.status_code == 200, r.text
        body = r.json()
        body = body.get("data", body)
        assert body["project_id"] == str(d["project_id"]), body
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
