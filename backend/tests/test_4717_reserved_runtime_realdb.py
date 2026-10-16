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
