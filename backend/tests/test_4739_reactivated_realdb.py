"""story 4739 (E-DESKTOP-2 · 1선 · PO 21:40Z «다시 켬» 바로 붙기) — a computer waiting out an agent's refusal is told when the agent is turned on again.

The daemon's receiving for an agent waits longer after each refusal (up to 10 minutes); a person who turned the agent off for a while and on again would
wait that long with nothing on screen. While the agent is off its own stream is refused (401), so the computer's DEVICE stream — open all that time —
carries one frame, `agent_reactivated {agent_member_id}`, which the daemon reads as «look again now» (the key proves itself at the connect, as always).

- the ONE place a member goes off → on is `TeamMemberRepository.apply_anchor_update`: the turn on is a conditional UPDATE of its own (`WHERE is_active =
  false … RETURNING`), so a PATCH of an agent that is already on still writes its other fields and signals nothing, and two at once signal once;
- the signal goes only to the computers this agent is bound to (`desktop_commands._agent_setups`: not revoked · exchanged · `members` names the agent);
- the stream looks again before it sends (`reactivated_to_send`): still bound · computer not revoked · the agent is an agent of its organization,
  not deleted and on — a mark that went stale never reaches the device; the frame carries the id and nothing else.
"""
from __future__ import annotations

import asyncio
import json
import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
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
from tests.test_4529_desktop_relay_realdb import _device, _remote_control_on, _tok  # noqa: F401 — _remote_control_on: the org's remote control is on (the stream answers 409 remote_control_off otherwise)
from tests.test_4554_relay_edges_realdb import _short_stream  # noqa: F401

pytestmark = pytest.mark.anyio

STREAM = "/api/v2/desktop/relay/stream"
FRAME = "agent_reactivated"


def _frames(text: str, name: str = FRAME) -> list[dict]:
    out: list[dict] = []
    for block in text.split("\n\n"):
        lines = block.strip().splitlines()
        if f"event: {name}" in lines:
            out.append(json.loads(next(line[len("data: "):] for line in lines if line.startswith("data: "))))
    return out


async def _registered(setup_id: str, timeout: float = 10.0) -> None:
    """the computer's stream is open and listening for wakes (polled, with a deadline — not a fixed wait)"""
    from app.routers.events import _agent_connections
    from app.services.desktop_relay import wake_key

    key = wake_key(uuid.UUID(setup_id))
    deadline = asyncio.get_running_loop().time() + timeout
    while not _agent_connections.get(key):
        assert asyncio.get_running_loop().time() < deadline, "the stream never registered"
        await asyncio.sleep(0.02)


async def _set(c, agent: str, **fields):
    return await c.patch(f"/api/v2/team-members/{agent}", json=fields, headers=_person(OWNER))


async def _row(agent: str) -> tuple:
    return tuple((await _sql(fetch=f"SELECT is_active, name FROM members WHERE id = '{agent}'"))[0])


async def test_01_turning_an_agent_on_tells_only_the_computer_it_is_bound_to(world, monkeypatch):
    _short_stream(monkeypatch, 6)
    async with _client() as c:
        one = await _device(c, name="d4739 one")
        two = await _device(c, name="d4739 two")
        a1, b1 = one["agents"][0]["member_id"], two["agents"][0]["member_id"]
        assert a1 != b1
        assert (await _set(c, a1, is_active=False)).status_code == 200
        s1 = asyncio.create_task(c.get(STREAM, headers=_tok(one["device_token"])))
        s2 = asyncio.create_task(c.get(STREAM, headers=_tok(two["device_token"])))
        await _registered(one["setup_id"]); await _registered(two["setup_id"])  # both open and listening
        assert (await _set(c, a1, is_active=True)).status_code == 200
        t1, t2 = (await s1).text, (await s2).text
        # the computer that holds the agent got one frame with its id and nothing else; the other computer (another agent) got none
        assert _frames(t1) == [{"agent_member_id": a1}], t1
        assert _frames(t2) == [], t2
        assert (await _row(a1))[0] is True


async def test_02_an_agent_already_on_signals_nothing_and_its_other_fields_are_still_written(world, monkeypatch):
    _short_stream(monkeypatch, 6)
    async with _client() as c:
        d = await _device(c, name="d4739 on")
        agent = d["agents"][0]["member_id"]
        stream = asyncio.create_task(c.get(STREAM, headers=_tok(d["device_token"])))
        await _registered(d["setup_id"])
        # the PATCH carries is_active:true for an agent that is on already, with a name — the name is written (the turn on is its own UPDATE, never a
        # condition on the whole row), and nothing is signaled
        r = await _set(c, agent, is_active=True, name="Renamed while on")
        assert r.status_code == 200, r.text
        r = await _set(c, agent, name="Renamed again")
        assert r.status_code == 200, r.text
        text = (await stream).text
        assert _frames(text) == [], text
        assert await _row(agent) == (True, "Renamed again")


async def test_03_off_then_on_signals_once_a_second_on_signals_nothing_more(world, monkeypatch):
    _short_stream(monkeypatch, 7)
    async with _client() as c:
        d = await _device(c, name="d4739 cycle")
        agent = d["agents"][0]["member_id"]
        stream = asyncio.create_task(c.get(STREAM, headers=_tok(d["device_token"])))
        await _registered(d["setup_id"])
        assert (await _set(c, agent, is_active=False)).status_code == 200  # turning off tells nobody
        assert (await _set(c, agent, is_active=True)).status_code == 200
        await asyncio.sleep(0.4)  # (an observation window, not a wait for the first frame: a wrong second signal would have reached the open stream by now)
        assert (await _set(c, agent, is_active=True)).status_code == 200  # already on: nothing more
        text = (await stream).text
        assert _frames(text) == [{"agent_member_id": agent}], text


async def test_04_the_stream_looks_again_before_it_sends_stale_unbound_and_revoked_marks_are_dropped(world):
    from app.core.database import async_session_factory
    from app.services import desktop_relay as relay

    async with _client() as c:
        d = await _device(c, name="d4739 stale")
        other = await _device(c, name="d4739 other")
        sid = uuid.UUID(d["setup_id"])
        a1, a2 = d["agents"][0]["member_id"], d["agents"][1]["member_id"]
        b1 = other["agents"][0]["member_id"]
        async with async_session_factory() as s:
            # on and bound: sent (sorted, parsed); junk and an agent this computer does not hold: dropped
            assert await relay.reactivated_to_send(s, sid, {a2, a1, "not-a-uuid", "", b1}) == sorted([uuid.UUID(a1), uuid.UUID(a2)])
            assert await relay.reactivated_to_send(s, sid, set()) == []
            assert await relay.reactivated_to_send(s, sid, {"x", "y"}) == []
        # turned off again meanwhile: the mark is stale
        assert (await _set(c, a1, is_active=False)).status_code == 200
        async with async_session_factory() as s:
            assert await relay.reactivated_to_send(s, sid, {a1, a2}) == [uuid.UUID(a2)]
        # deleted meanwhile (soft): dropped
        await _sql(f"UPDATE members SET deleted_at = now() WHERE id = '{a2}'")
        async with async_session_factory() as s:
            assert await relay.reactivated_to_send(s, sid, {a1, a2}) == []
        await _sql(f"UPDATE members SET deleted_at = NULL WHERE id = '{a2}'")
        # a computer revoked (its row kept, its list of agents untouched — only the revoke mark says it is gone): nothing reaches it
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{sid}'")
        async with async_session_factory() as s:
            assert await relay.reactivated_to_send(s, sid, {a2}) == []


async def test_05_the_one_place_a_direct_turn_on_signals_the_bound_computers_not_a_revoked_one_nor_an_agent_already_on(world, monkeypatch):
    from app.core.database import async_session_factory
    from app.repositories.team_member import TeamMemberRepository
    from app.services import desktop_relay as relay

    fired: list[tuple[uuid.UUID, uuid.UUID]] = []
    monkeypatch.setattr(relay, "_fire_agent_reactivated", lambda sid, aid: fired.append((sid, aid)))
    async with _client() as c:
        live = await _device(c, name="d4739 live")
        gone = await _device(c, name="d4739 gone")
        unbound = await _device(c, name="d4739 unbound")  # live, exchanged — but a different agent: this agent's turn on must not reach it
        # the same agent on two computers is not what the exchange makes; bind this agent to the second computer's list as well, then revoke that one
        agent = uuid.UUID(live["agents"][0]["member_id"])
        await _sql(
            "UPDATE desktop_setups SET members = members || CAST(:m AS jsonb) WHERE id = :sid",
            params={"m": json.dumps([{"stage": "writer", "member_id": str(agent), "kind": "agent", "runtime": "claude"}]), "sid": gone["setup_id"]},
        )
        assert (await c.delete(f"/api/v2/desktop/setups/{gone['setup_id']}", headers=_person(OWNER))).status_code == 200
        assert (await _set(c, str(agent), is_active=False)).status_code == 200
        fired.clear()
        async with async_session_factory() as s:
            repo = TeamMemberRepository(s, ORG)
            member = await repo.get(agent)
            await repo.apply_anchor_update(member, {"is_active": True, "name": "Direct"})
            await s.commit()
        assert fired == [(uuid.UUID(live["setup_id"]), agent)]  # the live computer that holds the agent only (the revoked one and the live one of another agent are not told) · exactly once
        assert unbound["setup_id"] != live["setup_id"]
        assert await _row(str(agent)) == (True, "Direct")
        # already on: the same call again writes its fields and signals nothing
        async with async_session_factory() as s:
            repo = TeamMemberRepository(s, ORG)
            member = await repo.get(agent)
            await repo.apply_anchor_update(member, {"is_active": True, "name": "Direct again"})
            await s.commit()
        assert len(fired) == 1 and await _row(str(agent)) == (True, "Direct again")
        # a rollback tells nobody (the signal waits for the commit)
        async with async_session_factory() as s:
            repo = TeamMemberRepository(s, ORG)
            member = await repo.get(agent)
            await repo.apply_anchor_update(member, {"is_active": False})
            await s.commit()
        async with async_session_factory() as s:
            repo = TeamMemberRepository(s, ORG)
            member = await repo.get(agent)
            await repo.apply_anchor_update(member, {"is_active": True})
            await s.rollback()
        assert len(fired) == 1 and (await _row(str(agent)))[0] is False

