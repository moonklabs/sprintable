"""story 4717 — the plan's agent limit counts the customer's agents only, and the setup page can read the room before [시작].

AC4 (PO 10-16 04:04Z): an organization's «시스템 발행» (`runtime_type = 'system-publisher'`) is made by the server and no customer
can use it — it never takes one of the free plan's places. One count (app/services/agent_count.plan_agent_count) is called by the
limit check, the setup confirmation and the setup page's read, so the number shown before [시작] is the number a 402 carries.
AC1: `ee.plan_limits.agent_room` / `services.desktop_setup.setup_agent_room` = {limit, current, available} before [시작].

Real PG (ALEMBIC_DATABASE_URL / PARITY_TEST_DATABASE_URL), skipped without one. Like test_2776, offering_versions is never deleted or
updated — the free row is read as it is and every expectation is built from its real `max_agents`.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real-DB URL 미설정 — skip"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL or ""
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


@pytest.fixture
async def maker():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    engine = create_async_engine(_async_url(), poolclass=NullPool)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


async def _free_max_agents(s) -> int:
    """The free tier's real agent limit (0228 seeds 3) — seeded only when missing, never changed (test_2776's rule)."""
    from datetime import datetime, timezone

    from sqlalchemy import select
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from app.models.offering_version import OfferingVersion

    await s.execute(pg_insert(OfferingVersion).values(
        id=uuid.uuid4(), tier="free", currency="krw", version_label="free_krw_v1_test4717",
        monthly_price_minor=0, annual_price_minor=0, included_seats=3, max_agents=3,
        au_limit=1, realtime_connection_limit=1, storage_mb_limit=1, max_file_mb=1,
        lab_credit_minor=0, rate_limit_per_min=1, automation_rule_limit=1, webhook_limit=0,
        event_replay_days=1, overage_allowed=False,
        effective_from=datetime.now(timezone.utc), created_by="test_4717_seed",
    ).on_conflict_do_nothing(index_elements=["tier", "currency"], index_where=OfferingVersion.effective_to.is_(None)))
    await s.commit()
    row = (await s.execute(
        select(OfferingVersion.max_agents).where(OfferingVersion.tier == "free", OfferingVersion.effective_to.is_(None))
        .order_by(OfferingVersion.currency).limit(1)
    )).first()
    assert row is not None and row[0] is not None and row[0] >= 1, "the free tier must have a finite agent limit (0228)"
    return int(row[0])


async def _free_org(s) -> uuid.UUID:
    from app.models.org_subscription import OrgSubscription
    from app.models.organization import Organization

    org = Organization(id=uuid.uuid4(), name="Org4717", slug=f"org4717-{uuid.uuid4().hex[:8]}")
    s.add(org)
    await s.flush()
    s.add(OrgSubscription(id=uuid.uuid4(), org_id=org.id, tier="free", status="active"))
    await s.commit()
    return org.id


async def _agent(s, org_id: uuid.UUID, runtime_type: str | None = "claude-code") -> uuid.UUID:
    from app.models.member import Member

    m = Member(id=uuid.uuid4(), org_id=org_id, type="agent", name=f"a-{uuid.uuid4().hex[:6]}", is_active=True, runtime_type=runtime_type)
    s.add(m)
    await s.commit()
    return m.id


async def _system_publisher(s, org_id: uuid.UUID) -> uuid.UUID:
    """The org's «시스템 발행» exactly as the server makes it (type agent · active · runtime_type system-publisher)."""
    return await _agent(s, org_id, runtime_type="system-publisher")


async def test_a_free_org_with_its_system_publisher_can_still_make_all_its_agents(maker):
    """AC4 — with «시스템 발행» in the org, the free plan still lets the customer make `max_agents` agents (3), and the next one
    is refused with current = max_agents (the publisher is not in the number). Counting the publisher again makes the last
    customer agent fail → RED."""
    from fastapi import HTTPException

    from ee.plan_limits import check_agent_add_limit

    async with maker() as s:
        max_agents = await _free_max_agents(s)
        org_id = await _free_org(s)
        await _system_publisher(s, org_id)
        for _ in range(max_agents - 1):
            await _agent(s, org_id)
    async with maker() as s:
        await check_agent_add_limit(s, org_id)  # the customer's last place is still there
        await _agent(s, org_id)
    async with maker() as s:
        with pytest.raises(HTTPException) as exc:
            await check_agent_add_limit(s, org_id)
    assert exc.value.status_code == 402
    assert (exc.value.detail["resource"], exc.value.detail["current"], exc.value.detail["limit"]) == ("agent", max_agents, max_agents)


async def test_an_agent_without_a_runtime_type_is_still_counted(maker):
    """AC4 boundary — only the publisher is left out: an agent whose runtime_type is not set yet is a customer's agent."""
    from app.services.agent_count import plan_agent_count

    async with maker() as s:
        org_id = await _free_org(s)
        await _system_publisher(s, org_id)
        await _agent(s, org_id, runtime_type=None)
        await _agent(s, org_id, runtime_type="codex")
        assert await plan_agent_count(s, org_id) == 2


async def test_the_room_before_start_is_the_number_the_limit_holds(maker, monkeypatch):
    """AC1 — the setup page's read: {limit, current, available} with the publisher left out, and `available` 0 exactly when the
    limit check refuses the next agent (the two can never disagree)."""
    from fastapi import HTTPException

    from app.core.config import settings
    from app.services.desktop_setup import setup_agent_room
    from ee.plan_limits import check_agent_add_limit

    monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda _self: True))
    async with maker() as s:
        max_agents = await _free_max_agents(s)
        org_id = await _free_org(s)
        await _system_publisher(s, org_id)
        await _agent(s, org_id)
    async with maker() as s:
        assert await setup_agent_room(s, org_id) == {"limit": max_agents, "current": 1, "available": max_agents - 1, "tier": "free"}
        for _ in range(max_agents - 1):
            await _agent(s, org_id)
    async with maker() as s:
        assert await setup_agent_room(s, org_id) == {"limit": max_agents, "current": max_agents, "available": 0, "tier": "free"}
        with pytest.raises(HTTPException):
            await check_agent_add_limit(s, org_id)


async def test_a_person_with_no_organization_gets_the_free_plan_room(maker, monkeypatch):
    """AC1 — the new-organization setup page: a new organization has no subscription (read as free) and no agents."""
    from app.core.config import settings
    from app.services.desktop_setup import setup_agent_room

    monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda _self: True))
    async with maker() as s:
        max_agents = await _free_max_agents(s)
        assert await setup_agent_room(s, None) == {"limit": max_agents, "current": 0, "available": max_agents, "tier": "free"}


async def test_no_room_is_read_where_no_limit_holds(maker, monkeypatch):
    """AC1 — OSS (no EE) or an unlimited plan: nothing to say before [시작] (null), never a made-up limit."""
    from app.core.config import settings
    from app.models.org_subscription import OrgSubscription
    from app.models.organization import Organization
    from app.services.desktop_setup import setup_agent_room

    async with maker() as s:
        org_id = await _free_org(s)
    monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda _self: False))
    async with maker() as s:
        assert await setup_agent_room(s, org_id) is None
        assert await setup_agent_room(s, None) is None

    monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda _self: True))
    async with maker() as s:
        paid = Organization(id=uuid.uuid4(), name="Org4717p", slug=f"org4717p-{uuid.uuid4().hex[:8]}")
        s.add(paid)
        await s.flush()
        s.add(OrgSubscription(id=uuid.uuid4(), org_id=paid.id, tier="pro-legacy-4717", status="active"))  # unknown tier → fail-open
        await s.commit()
        assert await setup_agent_room(s, paid.id) is None
