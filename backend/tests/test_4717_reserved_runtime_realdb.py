"""story 4717 (Kadir 10-16 · PO ①) — no customer write can set an agent's runtime_type to the publisher's value.

Since 4717 the plan's agent count leaves out runtime_type = 'system-publisher' (the server's «시스템 발행»). An agent a customer
could relabel to that value would drop out of the count, and the free plan's agent limit would have no end. So the team-member
PATCH refuses it with 409 SYSTEM_PUBLISHER_RESERVED before anything moves: the runtime stays, the count stays, the run profile is
not reset. Real PG over HTTP (the 4424 world: a free org, its owner, one agent), skipped without a DB URL.
"""
from __future__ import annotations

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    EXISTING,
    ORG,
    OWNER,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)

from tests.test_4424_desktop_setup_realdb import _RAW

pytestmark = [pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip"), pytest.mark.anyio]


async def _runtime(member) -> str | None:
    return (await _sql(fetch=f"SELECT runtime_type FROM members WHERE id = '{member}'"))[0][0]


async def _count() -> int:
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.services.agent_count import plan_agent_count
    from tests.test_4424_desktop_setup_realdb import _ASYNC

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            return await plan_agent_count(s, ORG)
    finally:
        await eng.dispose()


async def test_a_customer_cannot_relabel_an_agent_as_the_system_publisher(world):
    await _sql(f"UPDATE members SET runtime_type = 'codex' WHERE id = '{EXISTING}'")
    before = await _count()
    assert before == 1  # the world's one agent
    async with _client() as c:
        r = await c.patch(f"/api/v2/team-members/{EXISTING}", json={"runtime_type": "system-publisher"}, headers=_person(OWNER))
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "SYSTEM_PUBLISHER_RESERVED"
    assert await _runtime(EXISTING) == "codex"  # nothing moved
    assert await _count() == before  # still counted — the limit holds
    assert not await _sql(fetch=f"SELECT 1 FROM agent_run_profiles WHERE member_id = '{EXISTING}'")  # no reset ran either


async def test_an_ordinary_runtime_change_still_goes_through(world):
    async with _client() as c:
        r = await c.patch(f"/api/v2/team-members/{EXISTING}", json={"runtime_type": "claude-code"}, headers=_person(OWNER))
    assert r.status_code == 200, r.text
    assert await _runtime(EXISTING) == "claude-code"


async def _free_max_agents() -> int:
    rows = await _sql(fetch=(
        "SELECT max_agents FROM offering_versions WHERE tier = 'free' AND effective_to IS NULL ORDER BY currency LIMIT 1"
    ))
    assert rows and rows[0][0] is not None, "the free tier's agent limit is seeded by migration 0228"
    return int(rows[0][0])


async def test_after_the_refused_relabel_the_limit_still_refuses_the_next_agent(world, monkeypatch):
    """Kadir ③ — the whole bypass, end to end: the relabel is refused, the agent stays in the count, and once the org holds
    `max_agents` agents (the publisher left out) making one more is still 402 with current = max_agents."""
    from app.core.config import settings
    from tests.test_4424_desktop_setup_realdb import PROJ

    monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda _self: True))
    max_agents = await _free_max_agents()
    await _sql(
        f"UPDATE members SET runtime_type = 'codex' WHERE id = '{EXISTING}'",
        # the org's «시스템 발행», as the server makes it — never counted
        f"INSERT INTO members (id,org_id,type,name,is_active,runtime_type) VALUES (gen_random_uuid(),'{ORG}','agent','시스템 발행',true,'system-publisher')",
    )
    async with _client() as c:
        r = await c.patch(f"/api/v2/team-members/{EXISTING}", json={"runtime_type": "system-publisher"}, headers=_person(OWNER))
        assert r.status_code == 409, r.text
        for i in range(max_agents - 1):  # the world's agent + these = max_agents customer agents
            await _sql(f"INSERT INTO members (id,org_id,type,name,is_active,runtime_type) VALUES (gen_random_uuid(),'{ORG}','agent','a{i}',true,'claude-code')")
        assert await _count() == max_agents
        made = await c.post("/api/v2/agents", json={"name": "one more", "scope_mode": "projects", "project_ids": [str(PROJ)]}, headers=_person(OWNER))
    assert made.status_code == 402, made.text
    error = made.json()["error"]
    assert (error["code"], error["resource"], error["current"], error["limit"]) == ("PLAN_LIMIT_EXCEEDED", "agent", max_agents, max_agents)


@pytest.mark.parametrize("variant", ["System-Publisher", "system-publisher ", " SYSTEM-PUBLISHER"])
async def test_a_look_alike_value_is_not_the_publisher_and_stays_counted(world, variant):
    """Kadir ② — the guard and the count use the same exact value (system_publisher_guard.SYSTEM_PUBLISHER_RUNTIME_TYPE): a
    look-alike is not the publisher, so it is never left out of the count — whatever the PATCH answers, the limit holds."""
    before = await _count()
    async with _client() as c:
        await c.patch(f"/api/v2/team-members/{EXISTING}", json={"runtime_type": variant}, headers=_person(OWNER))
    assert await _count() == before
