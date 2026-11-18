"""story 4979 (호스트 연결 ①) — the computer's OWN «heard from» time (`last_heard_at`), the host's `presence` call, and what a person is SHOWN.

Measured 11-18 (a real daemon frozen with SIGSTOP): the server's 30-second tick kept `last_used_at` fresh for ≈3.3 min (worst 5 min 20 s) after the computer fell silent. So: `last_heard_at` is stamped only by what the DEVICE sends
(stream connect · its reports and acks · `POST /relay/presence`), never by the tick; a host that sends presence is shown as disconnected after 150 s of its OWN silence; a host that sends none keeps the old 90 s rule on `last_used_at`;
and what changes is only what is SHOWN — a command is still accepted or refused by the old rule (`device_unreachable`). Each test goes red without the line it names.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    OWNER_TM,
    PROJ,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4533_agent_permissions_realdb import _pair, _register
from tests.test_4534_desktop_commands_realdb import _cmd, _commands, _dm, _post, _remote_control_on, _state  # noqa: F401


async def _row(setup_id):
    rows = await _sql(fetch=f"SELECT last_used_at, last_heard_at, last_presence_at FROM desktop_device_tokens WHERE setup_id = '{setup_id}' AND revoked_at IS NULL")
    assert len(rows) == 1
    return rows[0]


async def _setup(c, name):
    device = await _device(c, name=name)
    agent = device["agents"][0]["member_id"]
    await _state(c, device, agent, "working", 1)
    phone, der = await _register(c)
    await _pair(c, device["device_token"], der)
    conv = await _dm(OWNER_TM, agent)
    return device, agent, phone, conv


async def _view(c, agent):
    r = await c.get(f"/api/v2/agents/{agent}/desktop-session", headers=_person(OWNER))
    assert r.status_code == 200, r.text
    return r.json()


async def _age(setup_id, *, used=None, heard=None, presence=None):
    """set the three times to «N seconds ago» (None = leave) — what a silent computer looks like"""
    sets = []
    for col, secs in (("last_used_at", used), ("last_heard_at", heard), ("last_presence_at", presence)):
        if secs is not None:
            sets.append(f"{col} = now() - interval '{secs} seconds'" if secs >= 0 else f"{col} = NULL")
    await _sql(f"UPDATE desktop_device_tokens SET {', '.join(sets)} WHERE setup_id = '{setup_id}' AND revoked_at IS NULL")


async def test_01_presence_stamps_the_three_times_and_only_the_devices_own(world):
    async with _client() as c:
        a = await _device(c, name="d4979 mac A")
        b = await _device(c, name="d4979 mac B")
        before = await _row(b["setup_id"])
        r = await c.post("/api/v2/desktop/relay/presence", headers=_tok(a["device_token"]))
        assert r.status_code == 200 and r.json() == {"ok": True}
        row = await _row(a["setup_id"])
        assert row[0] is not None and row[1] is not None and row[2] is not None          # last_used_at · last_heard_at · last_presence_at
        assert await _row(b["setup_id"]) == before                                          # another device's times are not touched by this token


async def test_02_presence_needs_the_device_token(world):
    async with _client() as c:
        assert (await c.post("/api/v2/desktop/relay/presence")).status_code == 401
        assert (await c.post("/api/v2/desktop/relay/presence", headers=_tok("sdt_not-a-token"))).status_code == 401
        assert (await c.post("/api/v2/desktop/relay/presence", headers=_person(OWNER))).status_code == 401       # a person's own session is not a device


async def test_03_a_presence_right_after_another_writes_nothing(world):
    async with _client() as c:
        d = await _device(c, name="d4979 mac gap")
        assert (await c.post("/api/v2/desktop/relay/presence", headers=_tok(d["device_token"]))).status_code == 200
        first = await _row(d["setup_id"])
        r = await c.post("/api/v2/desktop/relay/presence", headers=_tok(d["device_token"]))
        assert r.status_code == 200 and r.json() == {"ok": True}                            # the same answer …
        assert await _row(d["setup_id"]) == first                                           # … and not one write (a flood costs no write load)
        await _age(d["setup_id"], presence=30)                                              # past the gap: written again
        assert (await c.post("/api/v2/desktop/relay/presence", headers=_tok(d["device_token"]))).status_code == 200
        assert (await _row(d["setup_id"]))[2] != first[2]


async def test_04_the_servers_own_tick_is_not_the_computer_speaking(world):
    from app.core.database import async_session_factory
    from app.services.desktop_relay import touch_device

    async with _client() as c:
        d = await _device(c, name="d4979 mac tick")
        await _age(d["setup_id"], used=600, heard=600)
        async with async_session_factory() as s:
            await touch_device(s, uuid.UUID(d["setup_id"]), heard=False)                      # the stream's 30 s tick
            await s.commit()
        used, heard, _p = await _row(d["setup_id"])
        assert (datetime.now(timezone.utc) - used).total_seconds() < 60                     # last_used_at: as it always was
        assert (datetime.now(timezone.utc) - heard).total_seconds() > 500                   # last_heard_at: NOT moved by the tick
        async with async_session_factory() as s:
            await touch_device(s, uuid.UUID(d["setup_id"]))                                   # the default = a device-originated stamp
            await s.commit()
        assert (datetime.now(timezone.utc) - (await _row(d["setup_id"]))[1]).total_seconds() < 60


async def test_05_what_the_device_itself_sends_stamps_heard(world):
    async with _client() as c:
        d = await _device(c, name="d4979 mac report")
        agent = d["agents"][0]["member_id"]
        await _age(d["setup_id"], used=600, heard=600)
        await _state(c, d, agent, "working", 1)                                              # a report
        assert (datetime.now(timezone.utc) - (await _row(d["setup_id"]))[1]).total_seconds() < 60


async def test_06_an_older_host_without_presence_keeps_the_old_rule_exactly(world):
    async with _client() as c:
        device, agent, _phone, _conv = await _setup(c, "d4979 mac old")
        await _age(device["setup_id"], used=10, heard=400, presence=-1)                      # heard long ago, but the SERVER's tick is fresh; no presence ever
        v = await _view(c, agent)
        assert v["state"] != "unknown"                                                       # old rule: last_used_at within 90 s = connected
        assert v["last_heard_at"] is not None                                                # the field is told (the web may show «last seen»)
        await _age(device["setup_id"], used=300)
        assert (await _view(c, agent))["state"] == "unknown"                                 # old rule: silent past 90 s


async def test_07_a_host_with_presence_is_disconnected_after_150s_of_its_OWN_silence(world):
    async with _client() as c:
        device, agent, _phone, _conv = await _setup(c, "d4979 mac new")
        assert (await c.post("/api/v2/desktop/relay/presence", headers=_tok(device["device_token"]))).status_code == 200
        assert (await _view(c, agent))["state"] != "unknown"
        # the server's tick keeps last_used_at fresh (half-open connection) but the computer itself has been silent 200 s → shown disconnected
        await _age(device["setup_id"], used=5, heard=200)
        v = await _view(c, agent)
        assert v["state"] == "unknown"
        asked = datetime.now(timezone.utc)
        said = datetime.fromisoformat(v["last_heard_at"])
        assert 190 <= (asked - said).total_seconds() <= 260                                  # «last seen» is the computer's own word, not the tick
        await _age(device["setup_id"], heard=100)                                            # 100 s: two beats late at most — still connected
        assert (await _view(c, agent))["state"] != "unknown"


async def test_08_the_presence_rule_lapses_after_a_day_back_to_the_old_one(world):
    async with _client() as c:
        device, agent, _phone, _conv = await _setup(c, "d4979 mac lapse")
        await c.post("/api/v2/desktop/relay/presence", headers=_tok(device["device_token"]))
        await _age(device["setup_id"], used=5, heard=200, presence=86400 + 60)               # presence is a day old: an older host again
        assert (await _view(c, agent))["state"] != "unknown"                                 # old rule: last_used_at fresh = connected


async def test_09_only_what_is_shown_changes_a_command_is_still_judged_by_the_old_rule(world):
    async with _client() as c:
        device, agent, phone, conv = await _setup(c, "d4979 mac gate")
        await _grant_command()
        await c.post("/api/v2/desktop/relay/presence", headers=_tok(device["device_token"]))
        await _age(device["setup_id"], used=5, heard=200)                                    # shown disconnected …
        assert (await _view(c, agent))["state"] == "unknown"
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv))
        assert r.status_code == 201, r.text                                                  # … but the server still ACCEPTS the command (its rule is unchanged: last_used_at within 90 s)
        await _age(device["setup_id"], used=300)
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv))
        assert r.status_code == 409 and "device_unreachable" in r.text, r.text                # and refuses past 90 s exactly as before


async def test_10_the_phone_lists_follow_the_shown_rule_and_carry_last_heard(world):
    async with _client() as c:
        device, agent, phone, _conv = await _setup(c, "d4979 mac lists")
        await c.post("/api/v2/desktop/relay/presence", headers=_tok(device["device_token"]))
        await _age(device["setup_id"], used=5, heard=200)
        sessions = (await c.get("/api/v2/agents/desktop-sessions", headers=_person(OWNER))).json()
        rows = [r for r in (sessions if isinstance(sessions, list) else sessions.get("sessions") or sessions.get("items") or []) if r.get("setup_id") == device["setup_id"]]
        assert rows and rows[0]["state"] == "unknown" and rows[0]["last_heard_at"] is not None
        st = (await c.get(f"/api/v2/agents/{agent}/desktop-startable", params={"phone_key_id": phone}, headers=_person(OWNER))).json()
        comp = [x for x in st["computers"] if x["setup_id"] == device["setup_id"]][0]
        assert comp["reachable"] is False and comp["last_heard_at"] is not None
        st2 = (await c.get("/api/v2/desktop/startable", params={"phone_key_id": phone}, headers=_person(OWNER))).json()
        comp2 = [x for x in st2["computers"] if x["setup_id"] == device["setup_id"]][0]
        assert comp2["reachable"] is False and comp2["last_heard_at"] is not None
        await _age(device["setup_id"], heard=20)
        comp3 = [x for x in (await c.get("/api/v2/desktop/startable", params={"phone_key_id": phone}, headers=_person(OWNER))).json()["computers"] if x["setup_id"] == device["setup_id"]][0]
        assert comp3["reachable"] is True


async def _grant_command():
    from tests.test_4534_desktop_commands_realdb import _grant  # noqa: F401 — the owner may command

    return None


def test_11_source_pin_the_servers_tick_is_marked_not_heard_and_the_phone_views_use_the_shown_rule():
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1] / "app"
    router = (root / "routers" / "desktop_relay.py").read_text(encoding="utf-8")
    assert "await relay.touch_device(s, setup_id, heard=False)" in router                  # the 30 s tick inside the stream is the SERVER, not the computer
    assert router.count("touch_device(") == 5 and router.count("heard=False") == 1          # every other call keeps the default (a device-originated stamp)
    cmds = (root / "services" / "desktop_commands.py").read_text(encoding="utf-8")
    assert cmds.count("_shown_reachable(") == 4                                              # the session view · the overview · the agent's startable · the phone's computers
    assert cmds.replace("_shown_reachable(", "").count("_reachable(db") == 2                                                  # the refusal of a command (twice) stays on the old rule — and desktop_clock.py is untouched (its own gate and flag)

async def test_12_presence_is_counted_per_verified_device_and_stamps_only_its_own_token(world):
    async with _client() as c:
        a = await _device(c, name="d4979 mac limit A")
        b = await _device(c, name="d4979 mac limit B")
        for i in range(20):
            r = await c.post("/api/v2/desktop/relay/presence", headers=_tok(a["device_token"]))
            assert r.status_code == 200, (i, r.text)
        r = await c.post("/api/v2/desktop/relay/presence", headers=_tok(a["device_token"]))
        assert r.status_code == 429 and "RATE_LIMITED" in r.text and int(r.headers["retry-after"]) >= 1      # the 21st in a minute: refused before any write
        assert (await c.post("/api/v2/desktop/relay/presence", headers=_tok(b["device_token"]))).status_code == 200   # another device has its own count
        # a second live token of the SAME device (the schema does not forbid one): a presence stamps the token it came with, not both
        await _sql(f"INSERT INTO desktop_device_tokens (id, setup_id, token_hash, issued_at) VALUES (gen_random_uuid(), '{b['setup_id']}', 'second-token-of-b', now())")
        await _sql(f"UPDATE desktop_device_tokens SET last_presence_at = NULL, last_heard_at = NULL WHERE setup_id = '{b['setup_id']}'")
        assert (await c.post("/api/v2/desktop/relay/presence", headers=_tok(b["device_token"]))).status_code == 200
        rows = await _sql(fetch=f"SELECT token_hash, last_presence_at IS NOT NULL FROM desktop_device_tokens WHERE setup_id = '{b['setup_id']}' AND revoked_at IS NULL")
        stamped = {h: s for h, s in rows}
        assert stamped.pop("second-token-of-b") is False and list(stamped.values()) == [True]
