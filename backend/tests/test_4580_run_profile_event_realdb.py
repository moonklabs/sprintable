"""story #4580 (C) — a run profile change reaches the daemon at once: one `desktop.run_profile` Event down the agent's own stream.

Contract `~/.sprintable-shared/4580/run-profile-event-contract.md` (Mirko · PO 08:04Z): the web «허용 주소» [빼기] reached the daemon only
through its 10-min check (run 13 ⑥: 4 min 12 s open while the product says «빼면 바로 적용돼요»). Each path that moves the version
writes exactly one trigger event for that agent — payload exactly {event_type, agent_id, version} (no hosts · no model · no effort;
the daemon re-reads the profile with its own key) · nothing when no version moved · nothing when the change rolls back · never
for another org.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    _ASYNC,
    ORG,
    OUTSIDER,
    OWNER,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device

pytestmark = pytest.mark.anyio

EVENT = "desktop.run_profile"
MANY = "/api/v2/agents/run-profile"


def _one(agent) -> str:
    return f"/api/v2/agents/{agent}/run-profile"


def _rm(agent, host) -> str:
    return f"/api/v2/agents/{agent}/run-profile/allowed-hosts/{host}"


async def _events(agent) -> list[tuple]:
    return await _sql(fetch=(
        "SELECT payload, recipient_type, source_entity_type, source_entity_id::text, org_id::text, project_id::text, "
        f"recipient_seq, status FROM events WHERE recipient_id = '{agent}' AND event_type = '{EVENT}' ORDER BY recipient_seq"
    ))


async def _version(agent) -> int | None:
    rows = await _sql(fetch=f"SELECT version FROM agent_run_profiles WHERE member_id = '{agent}'")
    return rows[0][0] if rows else None


async def _set_runtime(agent, runtime: str) -> None:
    await _sql(f"UPDATE members SET runtime_type = '{runtime}' WHERE id = '{agent}'")


async def _setup_project(device) -> str:
    rows = await _sql(fetch=f"SELECT project_id::text FROM desktop_setups WHERE id = '{device['setup_id']}'")
    return rows[0][0]


def _check(ev: tuple, agent, version: int, project: str) -> None:
    payload, rtype, stype, sid, org, proj, seq, status = ev
    assert payload == {"event_type": EVENT, "agent_id": str(agent), "version": version}  # exactly these three keys
    assert (rtype, stype, sid, org, proj, status) == ("agent", "agent_run_profile", str(agent), str(ORG), project, "pending")
    assert seq is not None  # assign_recipient_seq ran (the daemon's stream reads by recipient_seq)


async def test_01_removing_a_host_writes_one_trigger_with_the_saved_version(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4580c1")
        agent = device["agents"][0]["member_id"]
        await _set_runtime(agent, "claude-code")
        await _sql(f"INSERT INTO agent_allowed_hosts (member_id, host) VALUES ('{agent}', 'pypi.org')")
        before = await _events(agent)

        r = await c.delete(_rm(agent, "pypi.org"), headers=_person(OWNER))
        assert r.status_code == 200, r.text
        assert r.json()["removed"] is True
        new = (await _events(agent))[len(before):]
        assert len(new) == 1
        _check(new[0], agent, await _version(agent), await _setup_project(device))

        # the same [빼기] again: nothing went, no version, no event
        again = await c.delete(_rm(agent, "pypi.org"), headers=_person(OWNER))
        assert again.status_code == 200 and again.json()["removed"] is False
        assert len(await _events(agent)) == len(before) + 1


async def test_02_a_put_writes_one_and_the_same_put_again_none(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4580c2")
        agent = device["agents"][0]["member_id"]
        await _set_runtime(agent, "claude-code")
        before = await _events(agent)

        r = await c.put(_one(agent), json={"model": "opus", "effort": "xhigh"}, headers=_person(OWNER))
        assert r.status_code == 200, r.text
        new = (await _events(agent))[len(before):]
        assert len(new) == 1
        _check(new[0], agent, await _version(agent), await _setup_project(device))
        assert set(new[0][0]) == {"event_type", "agent_id", "version"}  # no model · effort in the payload

        same = await c.put(_one(agent), json={"model": "opus", "effort": "xhigh"}, headers=_person(OWNER))
        assert same.status_code == 200, same.text
        assert len(await _events(agent)) == len(before) + 1  # nothing moved → nothing sent


async def test_03_a_put_for_many_writes_one_per_agent_that_moved(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4580c3")
        a, b = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        for x in (a, b):
            await _set_runtime(x, "claude-code")
        assert (await c.put(_one(b), json={"model": "opus", "effort": None}, headers=_person(OWNER))).status_code == 200
        before_a, before_b = len(await _events(a)), len(await _events(b))

        r = await c.put(MANY, json={"agent_ids": [a, b], "model": "opus"}, headers=_person(OWNER))  # b already opus
        assert r.status_code == 200, r.text
        new_a = (await _events(a))[before_a:]
        assert len(new_a) == 1
        _check(new_a[0], a, await _version(a), await _setup_project(device))
        assert len(await _events(b)) == before_b  # b did not move


async def test_04_a_runtime_change_writes_one(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4580c4")
        agent = device["agents"][0]["member_id"]
        await _set_runtime(agent, "codex")
        before = await _events(agent)

        p = await c.patch(f"/api/v2/team-members/{agent}", json={"runtime_type": "claude-code"}, headers=_person(OWNER))
        assert p.status_code == 200, p.text
        new = (await _events(agent))[len(before):]
        assert len(new) == 1
        _check(new[0], agent, await _version(agent), await _setup_project(device))


async def test_05_a_rolled_back_change_sends_nothing(world):
    from app.models.member import Member  # noqa: F401 — mapper registry
    from app.services.agent_run_profile import _bump

    async with _client() as c:
        device = await _device(c, name="d4424 mac 4580c5")
        agent = device["agents"][0]["member_id"]
        before_events, before_version = len(await _events(agent)), await _version(agent)

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            await _bump(s, member_id=uuid.UUID(agent), updated_by=None)
            await s.rollback()  # the caller's transaction failed after the bump
    finally:
        await eng.dispose()
    assert len(await _events(agent)) == before_events
    assert await _version(agent) == before_version


async def test_06_another_orgs_person_moves_nothing_and_no_event_crosses_orgs(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4580c6")
        agent = device["agents"][0]["member_id"]
        await _set_runtime(agent, "claude-code")
        await _sql(f"INSERT INTO agent_allowed_hosts (member_id, host) VALUES ('{agent}', 'gitlab.com')")
        before = await _events(agent)

        r = await c.delete(_rm(agent, "gitlab.com"), headers=_person(OUTSIDER))
        assert r.status_code in (403, 404), r.text
        assert len(await _events(agent)) == len(before)
        rows = await _sql(fetch=f"SELECT count(*) FROM events WHERE event_type = '{EVENT}' AND recipient_id = '{agent}' AND org_id <> '{ORG}'")
        assert rows[0][0] == 0
