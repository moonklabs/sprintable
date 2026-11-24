"""[SID:5000] real-DB — the free tier's organization · project · agent caps are lifted (`ee.plan_limits.FREE_LIMITS` None = no cap).

Before: free = one owned organization per person · one project per organization · three agents per organization, and on a deployment whose
payment entry is closed (prod) a person who hit one had no way up (402 PLAN_LIMIT_EXCEEDED, no plan tab, no checkout). Only the free tier's three
values moved; the check code, the catalog, seats · storage · AU and every paid tier's own agent cap stay.

Red when (a) a free cap is put back as the default (the first four tests ask for a 4th agent · a 4th organization · a 4th project and the
two reads that tell the web «there is a limit»), (b) the paid-tier agent cap stops being read from the catalog (fifth), (c) a number in
`FREE_LIMITS` no longer turns its cap back on (sixth · seventh · eighth: the old numbers 1 · 1 · 3 through the `free_caps_on` fixture).

Real PG (ALEMBIC_DATABASE_URL / PARITY_TEST_DATABASE_URL), skipped without one."""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import text

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = [pytest.mark.skipif(not _RAW, reason="real-DB URL not set — skip"), pytest.mark.anyio]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def maker():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    engine = create_async_engine(_ASYNC, poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


async def _free_org(s, *, tier: str = "free") -> uuid.UUID:
    from app.models.org_subscription import OrgSubscription
    from app.models.organization import Organization

    org = Organization(id=uuid.uuid4(), name="Org5000", slug=f"org5000-{uuid.uuid4().hex[:8]}")
    s.add(org)
    await s.flush()
    s.add(OrgSubscription(id=uuid.uuid4(), org_id=org.id, tier=tier, status="active"))
    await s.commit()
    return org.id


async def _agents(s, org_id: uuid.UUID, n: int) -> None:
    from app.models.member import Member

    for _ in range(n):
        s.add(Member(id=uuid.uuid4(), org_id=org_id, type="agent", name=f"a-{uuid.uuid4().hex[:6]}", is_active=True, runtime_type="claude-code"))
    await s.commit()


async def _projects(s, org_id: uuid.UUID, n: int) -> None:
    for i in range(n):
        await s.execute(
            text("INSERT INTO projects (id, org_id, name, slug) VALUES (:id, :o, :n, :s)"),
            {"id": uuid.uuid4(), "o": org_id, "n": f"P{i}", "s": f"p5000-{uuid.uuid4().hex[:8]}"},
        )
    await s.commit()


async def _owned_orgs(s, user_id: uuid.UUID, n: int) -> None:
    for _ in range(n):
        org_id = uuid.uuid4()
        await s.execute(text("INSERT INTO organizations (id, name, slug, plan) VALUES (:id, :n, :s, 'free')"), {"id": org_id, "n": f"t5000-{org_id}", "s": f"s5000-{org_id}"})
        await s.execute(text("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:id, :o, :u, 'owner')"), {"id": uuid.uuid4(), "o": org_id, "u": user_id})
    await s.commit()


async def test_a_free_org_can_make_a_fourth_agent_and_the_room_says_no_limit(maker):
    from ee.plan_limits import agent_room, check_agent_add_limit, new_org_agent_limit

    async with maker() as s:
        org_id = await _free_org(s)
        await _agents(s, org_id, 4)  # the old free cap was 3
        await check_agent_add_limit(s, org_id)  # no raise: a fifth would be allowed too
        assert await agent_room(s, org_id) is None  # the web reads «no limit» → the setup page says nothing about one
        assert await new_org_agent_limit(s) is None  # a person with no organization yet


async def test_a_person_can_own_a_fourth_organization(maker):
    from ee.plan_limits import check_org_create_limit

    async with maker() as s:
        user = uuid.uuid4()
        await _owned_orgs(s, user, 3)  # the old cap was 1
        await check_org_create_limit(s, user)  # no raise


async def test_a_free_org_can_make_a_fourth_project(maker):
    from ee.plan_limits import check_project_create_limit

    async with maker() as s:
        org_id = await _free_org(s)
        await _projects(s, org_id, 3)  # the old cap was 1
        await check_project_create_limit(s, org_id)  # no raise


async def test_the_defaults_are_no_cap_on_the_three_free_axes():
    from ee.plan_limits import FREE_LIMITS

    assert FREE_LIMITS["max_orgs_owned"] is None
    assert FREE_LIMITS["max_projects"] is None
    assert FREE_LIMITS["max_agents"] is None


async def test_a_paid_tiers_own_agent_cap_is_still_read_from_the_catalog(maker, monkeypatch):
    """The free table never leaks onto a paid tier: the catalog's value for it is what the check and the room use (here: a catalog that caps starter at 2)."""
    import ee.plan_limits as plan_limits

    async def _starter_caps_at_two(session, tier):
        return (3, 2) if tier == "starter" else (3, None)

    monkeypatch.setattr(plan_limits, "_get_offering_limits", _starter_caps_at_two)
    async with maker() as s:
        org_id = await _free_org(s, tier="starter")
        await _agents(s, org_id, 2)
        with pytest.raises(HTTPException) as full:
            await plan_limits.check_agent_add_limit(s, org_id)
        assert full.value.status_code == 402
        assert full.value.detail["code"] == "PLAN_LIMIT_EXCEEDED"
        assert full.value.detail["limit"] == 2
        assert (await plan_limits.agent_room(s, org_id))[0] == 2


async def test_put_the_old_org_number_back_and_the_cap_is_on_again(maker, free_caps_on):
    from ee.plan_limits import check_org_create_limit

    async with maker() as s:
        user = uuid.uuid4()
        await _owned_orgs(s, user, 1)
        with pytest.raises(HTTPException) as full:
            await check_org_create_limit(s, user)
        assert full.value.status_code == 402
        assert full.value.detail["resource"] == "org" and full.value.detail["limit"] == 1


async def test_put_the_old_project_number_back_and_the_cap_is_on_again(maker, free_caps_on):
    from ee.plan_limits import check_project_create_limit

    async with maker() as s:
        org_id = await _free_org(s)
        await _projects(s, org_id, 1)
        with pytest.raises(HTTPException) as full:
            await check_project_create_limit(s, org_id)
        assert full.value.status_code == 402
        assert full.value.detail["resource"] == "project" and full.value.detail["limit"] == 1
        # another tier is not asked (the project cap is the free tier's)
        other = await _free_org(s, tier="team")
        await _projects(s, other, 1)
        await check_project_create_limit(s, other)


async def test_put_the_old_agent_number_back_and_the_cap_is_on_again(maker, free_caps_on):
    from ee.plan_limits import agent_room, check_agent_add_limit

    async with maker() as s:
        org_id = await _free_org(s)
        await _agents(s, org_id, 3)
        with pytest.raises(HTTPException) as full:
            await check_agent_add_limit(s, org_id)
        assert full.value.status_code == 402
        assert full.value.detail["resource"] == "agent" and full.value.detail["limit"] == 3
        assert (await agent_room(s, org_id))[0] == 3
