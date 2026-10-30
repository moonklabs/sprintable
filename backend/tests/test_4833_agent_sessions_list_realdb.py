"""story #4833 (결함 ②, 서버 몫) — `GET /api/v2/agents/desktop-sessions`: every agent the person can open the DM of, in one read (the Today screen).

The rule per agent is the one-agent read's (`/{agent}/desktop-session`) — both come from the same function, and these tests hold the two reads
to saying the same thing about the same agent; plus: who may see (the list leaves out an agent the person cannot open the DM of), a computer
that is no longer heard reads `unknown`, a limit's facts come through, the live session is picked over a stopped one, and the number of
queries does not grow with the number of agents.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import event

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    OWNER_TM,
    PLAIN,
    PROJ,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device
from tests.test_4533_agent_permissions_realdb import _plain_member
from tests.test_4534_desktop_commands_realdb import _dm, _remote_control_on, _state  # noqa: F401 — autouse fixture too

pytestmark = pytest.mark.anyio

SAME = ("setup_id", "device_name", "state", "activity", "state_at", "limit", "first_screen")


async def _list(c, who=OWNER):
    return await c.get("/api/v2/agents/desktop-sessions", headers=_person(who))


async def _one(c, agent, who=OWNER):
    return await c.get(f"/api/v2/agents/{agent}/desktop-session", headers=_person(who))


def _row(rows, agent):
    return next(r for r in rows if r["agent_id"] == agent)


async def test_01_the_list_says_what_the_one_agent_read_says(world):
    async with _client() as c:
        device = await _device(c, name="d4833 mac a")
        agent = device["agents"][0]["member_id"]
        await _state(c, device, agent, "working", 1)
        listed = await _list(c)
        assert listed.status_code == 200, listed.text
        row = _row(listed.json(), agent)
        one = (await _one(c, agent)).json()
        for key in SAME:
            assert row[key] == one[key], key
        assert row["activity"] == "working" and row["device_name"] == "d4833 mac a"
        assert row["agent_name"] and listed.headers["X-Total-Count"] == str(len(listed.json()))


async def test_02_an_agent_the_person_cannot_open_the_dm_of_is_not_listed(world):
    async with _client() as c:
        device = await _device(c, name="d4833 mac b")
        agent = device["agents"][0]["member_id"]
        await _state(c, device, agent, "working", 1)
        assert any(r["agent_id"] == agent for r in (await _list(c)).json())
        # a plain org member with no access to the agent's project: the one-agent read is a 404, and the list leaves the agent out
        assert (await _one(c, agent, who=PLAIN)).status_code == 404
        hidden = await _list(c, who=PLAIN)
        assert hidden.status_code == 200
        assert all(r["agent_id"] != agent for r in hidden.json())


async def test_03_a_computer_that_is_no_longer_heard_reads_unknown_in_both(world):
    async with _client() as c:
        device = await _device(c, name="d4833 mac c")
        agent = device["agents"][0]["member_id"]
        await _state(c, device, agent, "working", 1)
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '1 day' WHERE setup_id = '{device['setup_id']}'")
        row = _row((await _list(c)).json(), agent)
        one = (await _one(c, agent)).json()
        assert row["activity"] == "unknown" == one["activity"]
        assert row["limit"] is None  # told only while the computer is heard


async def test_04_a_limit_s_facts_come_through_and_match_the_one_agent_read(world):
    async with _client() as c:
        device = await _device(c, name="d4833 mac d")
        agent = device["agents"][0]["member_id"]
        await _state(c, device, agent, "paused_limit", 1)
        await _sql(f"UPDATE desktop_sessions SET limited = true, limit_at = now(), limit_looks = true WHERE setup_id = '{device['setup_id']}' AND agent_member_id = '{agent}'")
        row = _row((await _list(c)).json(), agent)
        one = (await _one(c, agent)).json()
        assert row["activity"] == "paused_limit"
        assert row["limit"] and row["limit"] == one["limit"]
        assert row["limit"].get("looks") is True


async def test_05_the_live_session_is_picked_over_a_stopped_one_in_both(world):
    async with _client() as c:
        device = await _device(c, name="d4833 mac e")
        agent = device["agents"][0]["member_id"]
        await _state(c, device, agent, "working", 1, key="s-old")
        await _state(c, device, agent, "stopped", 2, key="s-old")
        await _state(c, device, agent, "working", 3, key="s-new")
        row = _row((await _list(c)).json(), agent)
        assert row["activity"] == "working" == (await _one(c, agent)).json()["activity"]


async def test_06_an_agent_with_no_session_yet_is_listed_with_no_state(world):
    async with _client() as c:
        device = await _device(c, name="d4833 mac f")
        agent = device["agents"][0]["member_id"]
        row = _row((await _list(c)).json(), agent)
        assert row["state"] is None and row["activity"] is None
        assert row["bound_device_name"] == "d4833 mac f"  # said even before any session was reported (4675)


async def test_06b_the_row_names_the_person_s_own_dm_with_the_agent_and_never_someone_else_s(world):
    plain_tm = await _plain_member()
    async with _client() as c:
        device = await _device(c, name="d4833 mac h")
        agent = device["agents"][0]["member_id"]
        before = _row((await _list(c)).json(), agent)["conversation_id"]  # connecting an agent may already have made one
        someone_elses = await _dm(plain_tm, agent)  # another person's DM with the same agent
        after = _row((await _list(c)).json(), agent)
        assert after["conversation_id"] == before != someone_elses, "another person's conversation must not be offered"
        three = await _dm(OWNER_TM, agent, plain_tm)  # a room typed `dm` with a third person in it is not «the conversation with that agent»
        assert _row((await _list(c)).json(), agent)["conversation_id"] == before != three
        own = await _dm(OWNER_TM, agent)  # the person's own, newer than any before
        row = _row((await _list(c)).json(), agent)
        assert row["conversation_id"] == own
        assert row["conversation_project_id"] == str(PROJ)


async def test_07_the_number_of_queries_does_not_grow_with_the_number_of_agents(world):
    from app.core.database import engine

    seen: list[str] = []

    def count(conn, cursor, statement, parameters, context, executemany):  # noqa: ARG001
        seen.append(statement)

    async with _client() as c:
        device = await _device(c, name="d4833 mac g")
        agent = device["agents"][0]["member_id"]
        await _state(c, device, agent, "working", 1)
        event.listen(engine.sync_engine, "before_cursor_execute", count)
        try:
            await _list(c)
            few = len(seen)
            extra = [str(uuid.uuid4()) for _ in range(6)]
            await _sql(
                *[f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{m}','{ORG}',NULL,'agent','Extra {i}',true)" for i, m in enumerate(extra)],
                *[f"INSERT INTO agent_project_profiles (id,member_id,project_id) VALUES (gen_random_uuid(),'{m}','{PROJ}')" for m in extra],
            )
            seen.clear()
            listed = await _list(c)
            many = len(seen)
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", count)
        assert len(listed.json()) >= 7
        assert many == few, f"{few} queries for the first list, {many} with six more agents — a query per agent is back"
