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
        used_before = (await _row(a["setup_id"]))[0]
        r = await c.post("/api/v2/desktop/relay/presence", headers=_tok(a["device_token"]))
        assert r.status_code == 200 and r.json() == {"ok": True}
        row = await _row(a["setup_id"])
        assert row[1] is not None and row[2] is not None                                    # last_heard_at · last_presence_at
        assert row[0] == used_before                                                        # last_used_at is NOT touched by a presence (Kadir 5851 ① — the server's «may a command go» rule reads it)
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
        for secs, writes in ((5, False), (15, True)):                                       # the gap is 10 s: 5 s ago → nothing is written · 15 s ago → written
            await _age(d["setup_id"], presence=secs)
            before = await _row(d["setup_id"])
            assert (await c.post("/api/v2/desktop/relay/presence", headers=_tok(d["device_token"]))).status_code == 200
            after = await _row(d["setup_id"])
            assert (after[2] != before[2]) is writes, (secs, before, after)


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


async def test_08_the_presence_rule_lapses_after_15_minutes_back_to_the_old_one(world):
    async with _client() as c:
        device, agent, _phone, _conv = await _setup(c, "d4979 mac lapse")
        await c.post("/api/v2/desktop/relay/presence", headers=_tok(device["device_token"]))
        await _age(device["setup_id"], used=5, heard=200, presence=600)                      # presence 10 min old: still a presence host → its own silence (200 s) shows it disconnected
        assert (await _view(c, agent))["state"] == "unknown"
        await _age(device["setup_id"], used=5, heard=200, presence=960)                      # 16 min old: an older host again → the old rule: last_used_at fresh = connected
        assert (await _view(c, agent))["state"] != "unknown"


async def test_09_the_gate_follows_the_shown_rule_a_silent_presence_host_is_refused_not_trapped_in_a_dead_stream(world):
    async with _client() as c:
        device, agent, phone, conv = await _setup(c, "d4979 mac gate")
        await _grant_command()
        await c.post("/api/v2/desktop/relay/presence", headers=_tok(device["device_token"]))
        await _age(device["setup_id"], used=5, heard=200)                                    # half-open: the server's tick keeps last_used_at fresh, the computer itself has been silent 200 s → SHOWN disconnected …
        assert (await _view(c, agent))["state"] == "unknown"
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv))
        assert r.status_code == 409 and "device_unreachable" in r.text, r.text                # … and a command is REFUSED (before the alignment: accepted, queued into the dead stream for up to 5 min 20 s)
        await _age(device["setup_id"], heard=100)                                            # two beats late at most: connected → accepted
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv))
        assert r.status_code == 201, r.text
        # the silence limit is exactly 150 s (Kadir 5853 · a 150→160 mutant used to survive: the test saw 100 and 200 only)
        await _age(device["setup_id"], used=5, heard=149)
        assert (await _post(c, agent, _cmd("send_prompt", phone, conv=conv))).status_code == 201
        await _age(device["setup_id"], used=5, heard=151)
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv))
        assert r.status_code == 409 and "device_unreachable" in r.text, r.text
        await _age(device["setup_id"], used=5, heard=100)
        # an older host (no presence): the old rule exactly — last_used_at within 90 s accepts, past it refuses
        await _age(device["setup_id"], used=300, heard=300, presence=-1)
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv))
        assert r.status_code == 409 and "device_unreachable" in r.text, r.text
        await _age(device["setup_id"], used=10)
        assert (await _post(c, agent, _cmd("send_prompt", phone, conv=conv))).status_code == 201


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
    assert router.count("touch_device(") == 8 and router.count("heard=False") == 1          # every other call keeps the default (a device-originated stamp; 8 with story 4977 B2's `put_record` (the computer keeps a sealed record = it is heard), 7 with story 4983's `put_files`, the sibling of `put_changes`, and story 4988's `put_files_chunk`, its sibling)
    cmds = (root / "services" / "desktop_commands.py").read_text(encoding="utf-8")
    assert cmds.count("_shown_reachable(") == 5                                              # the session view · the overview · the agent's startable · the phone's computers · the usage read (story 4981)
    assert cmds.replace("_shown_reachable(", "").count("_reachable(db") == 2
    perms = (root / "services" / "agent_permissions.py").read_text(encoding="utf-8")
    assert "return (await _shown_reachable(db, setup_ids, now))[0]" in perms               # story 4979 gate alignment: `_reachable` IS the shown rule (one rule for every gate and every screen)                                                  # the refusal of a command (twice) stays on the old rule — and desktop_clock.py is untouched (its own gate and flag)

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


async def test_13_a_host_that_says_it_is_here_takes_commands_even_while_its_stream_reconnects(world):
    async with _client() as c:
        device, agent, phone, conv = await _setup(c, "d4979 mac presence only")
        await _grant_command()
        await _age(device["setup_id"], used=300, heard=300, presence=-1)                      # no stream, no report, no presence for 5 min: refused as before
        assert (await _post(c, agent, _cmd("send_prompt", phone, conv=conv))).status_code == 409
        assert (await c.post("/api/v2/desktop/relay/presence", headers=_tok(device["device_token"]))).status_code == 200
        assert (await _view(c, agent))["state"] != "unknown"                                 # SHOWN connected: the computer itself just said it is here
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv))
        assert r.status_code == 201, r.text                                                   # … and a command goes to it (it is alive; the command waits for its stream to be back)


async def test_14_a_revoked_token_is_never_stamped_and_a_revoked_computer_is_never_shown_connected(world):
    from datetime import timedelta

    from app.core.database import async_session_factory
    from app.services.agent_permissions import _shown_reachable
    from app.services.desktop_relay import touch_presence

    async with _client() as c:
        d = await _device(c, name="d4979 mac revoked")
        sid = uuid.UUID(d["setup_id"])
        await _sql(f"INSERT INTO desktop_device_tokens (id, setup_id, token_hash, issued_at, revoked_at) VALUES (gen_random_uuid(), '{sid}', 'revoked-token-of-d', now(), now())")
        async with async_session_factory() as s:
            await touch_presence(s, sid, None)                                                # no token named: every LIVE token of the device
            await s.commit()
        rows = {h: p for h, p in await _sql(fetch=f"SELECT token_hash, last_presence_at IS NOT NULL FROM desktop_device_tokens WHERE setup_id = '{sid}'")}
        assert rows.pop("revoked-token-of-d") is False and list(rows.values()) == [True]      # the revoked row is left alone
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() WHERE setup_id = '{sid}' AND revoked_at IS NULL")   # its stream was just ticked (a presence host counts only with a ticked stream too — Kadir 5853 ①)
        async with async_session_factory() as s:
            connected, heard = await _shown_reachable(s, {sid}, datetime.now(timezone.utc))
        assert sid in connected and heard[sid] is not None
        # a REVOKED token's fresh times are nobody's word: the live token has been silent 10 min while the revoked row says «just now» → still not connected
        await _sql(f"UPDATE desktop_device_tokens SET last_heard_at = now(), last_presence_at = now(), last_used_at = now() WHERE setup_id = '{sid}' AND revoked_at IS NOT NULL")
        await _sql(f"UPDATE desktop_device_tokens SET last_heard_at = now() - interval '600 seconds', last_presence_at = now() - interval '600 seconds', last_used_at = now() - interval '600 seconds' WHERE setup_id = '{sid}' AND revoked_at IS NULL")
        async with async_session_factory() as s:
            connected, _heard = await _shown_reachable(s, {sid}, datetime.now(timezone.utc))
        assert sid not in connected
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{sid}'")         # the computer itself is closed
        async with async_session_factory() as s:
            connected, heard = await _shown_reachable(s, {sid}, datetime.now(timezone.utc) + timedelta(seconds=0))
        assert connected == set() and heard == {}                                              # never shown as connected, whatever its times say


async def test_15_the_admin_device_sessions_view_and_the_permission_list_follow_the_same_rule(world):
    from tests.test_4533_agent_permissions_realdb import REQS, _ask, _post_ask

    async with _client() as c:
        device, agent, _phone, _conv = await _setup(c, "d4979 mac same rule")
        await c.post("/api/v2/desktop/relay/presence", headers=_tok(device["device_token"]))
        ask = (await _post_ask(c, device, _ask(agent))).json()
        assert ask["state"] == "pending"
        await _age(device["setup_id"], used=5, heard=200)                                    # half-open: tick fresh, computer silent 200 s
        sess = (await c.get(f"/api/v2/desktop/setups/{device['setup_id']}/sessions", headers=_person(OWNER))).json()["sessions"]
        assert sess and all(x["activity"] == "unknown" for x in sess if x["state"] != "stopped")      # the admin's device view says the same as the chat strip
        listed = (await c.get(REQS, headers=_person(OWNER), params={"state": "pending"})).json()["requests"]
        assert [v["answerable"] for v in listed] == [False]                                  # the card's button follows the gate (and the gate the shown rule)
        await _age(device["setup_id"], heard=100)
        listed = (await c.get(REQS, headers=_person(OWNER), params={"state": "pending"})).json()["requests"]
        assert [v["answerable"] for v in listed] == [True]


async def test_16_a_presence_host_whose_stream_is_dead_for_good_is_refused_not_kept_connected_on_presence_alone(world):
    """Kadir 5853 ①: the stream's tick (last_used_at) 30 min old, the computer itself fresh on presence — «connected · working» with every command a 201 that sits `queued` with no expiry."""
    async with _client() as c:
        device, agent, phone, conv = await _setup(c, "d4979 mac dead stream")
        await _grant_command()
        assert (await c.post("/api/v2/desktop/relay/presence", headers=_tok(device["device_token"]))).status_code == 200
        await _age(device["setup_id"], used=1800, heard=5, presence=5)
        assert (await _view(c, agent))["state"] == "unknown"                                  # SHOWN disconnected: the strip says what the gates say
        queued_before = len(await _commands(device["setup_id"]))
        for kind in ("send_prompt", "stop_session", "end_session"):
            body = _cmd(kind, phone, conv=conv)
            r = await _post(c, agent, body)
            assert r.status_code == 409 and "device_unreachable" in r.text, (kind, r.text)
        assert len(await _commands(device["setup_id"])) == queued_before                          # nothing was queued: every refusal came before the row
        # a reconnect gap under 400 s stays «queued, delivered when the stream is back» (the 5853 intent) · past it the refusal of 5851 returns
        await _age(device["setup_id"], used=390, heard=5, presence=5)
        assert (await _post(c, agent, _cmd("send_prompt", phone, conv=conv))).status_code == 201
        await _age(device["setup_id"], used=410, heard=5, presence=5)
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv))
        assert r.status_code == 409 and "device_unreachable" in r.text, r.text
        await _age(device["setup_id"], used=-1, heard=5, presence=5)                         # a stream that was NEVER ticked (NULL) is no stream: presence alone does not make a computer reachable
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv))
        assert r.status_code == 409 and "device_unreachable" in r.text, r.text
        # an older host (no presence) is untouched by the new clause: the old 90 s rule on last_used_at, nothing more
        await _age(device["setup_id"], used=10, heard=1800, presence=-1)
        assert (await _post(c, agent, _cmd("send_prompt", phone, conv=conv))).status_code == 201
