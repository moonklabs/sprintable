"""story #4599 (relay contract v1.13 · alembic 0442 · PO 2026-10-07 12:27Z) — a turn held by a macOS window reaches the phone and the web:
the daemon reports `waiting_system`; a reader from before sees `working` (the turn is still a turn), the new web sees the word in
`activity`; a phone's [멈춤] is refused with its own closed reason (`system_wait_end_only` — the session is frozen, not stopped) · an
instruction is not taken · the one handle is a signed `end_session` (0443 · contract v1.13.2) · no turn-end notice comes of it (it is
not a resting word) · no usage limit rides on it."""
from __future__ import annotations

import re
from datetime import datetime, timezone

import pytest
from sqlalchemy import text

from app.models.desktop_relay import SESSION_LIMIT_STATES, SESSION_STATES
from app.services.desktop_commands import TURN_ENDED_STATES
from app.services.desktop_relay import legacy_state
from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    OWNER,
    OWNER_TM,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4534_desktop_commands_realdb import (  # noqa: F401
    _cmd,
    _commands,
    _post,
    _remote_control_on,
    _sent_and_done,
    _state,
    _turn_end_notices,
    _world,
)

pytestmark = pytest.mark.anyio
STATE = "/api/v2/desktop/relay/sessions/s-1/state"
WORD = "waiting_system"


def _now():
    return datetime.now(timezone.utc)


def _report(agent, seq, state, **extra):
    return {"report_seq": seq, "agent_member_id": agent, "runtime": "claude", "state": state, "at": _now().isoformat(), **extra}


async def _view(c, agent):
    r = await c.get(f"/api/v2/agents/{agent}/desktop-session", headers=_person(OWNER))
    assert r.status_code == 200, r.text
    return r.json()


def test_00_the_word_is_in_the_code_lists_as_a_working_word_not_a_resting_or_a_limit_one():
    assert WORD in SESSION_STATES
    assert legacy_state(WORD) == "working", "a reader from before sees the turn it still is"
    assert WORD not in SESSION_LIMIT_STATES, "no usage limit rides on a macOS window"
    assert WORD not in TURN_ENDED_STATES, "a held turn has not ended — no turn-end notice of it"


async def test_01_the_check_constraint_holds_the_nine_words(world):
    """0442's CHECK holds the model's words, the new one among them (one changed alone → RED)."""
    from app.core.database import async_session_factory

    async with async_session_factory() as s:
        (d,) = (await s.execute(text(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_desktop_sessions_state'"))).scalars().all()
    words = set(re.findall(r"'([a-z_]+)'", d))
    assert words == set(SESSION_STATES) and WORD in words


async def test_02_reported_as_itself_shown_as_working_to_a_reader_from_before_and_as_the_word_in_activity(world):
    async with _client() as c:
        d = await _device(c, name="d4599 window a")
        token, agent = d["device_token"], d["agents"][0]["member_id"]
        assert (await c.post(STATE, json=_report(agent, 1, "working"), headers=_tok(token))).status_code == 200
        assert (await c.post(STATE, json=_report(agent, 2, WORD), headers=_tok(token))).status_code == 200
        v = await _view(c, agent)
        assert (v["state"], v["activity"], v["limit"]) == ("working", WORD, None)
        rows = await _sql(fetch=f"SELECT state FROM desktop_sessions WHERE setup_id = '{d['setup_id']}'")
        assert [tuple(r) for r in rows] == [(WORD,)], "stored as itself — never folded on the way in"
        # the device's own list carries it the same way
        listed = await c.get(f"/api/v2/desktop/setups/{d['setup_id']}/sessions", headers=_person(OWNER))
        [s] = listed.json()["sessions"]
        assert (s["state"], s["activity"]) == ("working", WORD)
        # the window answered: the next report is the turn again
        assert (await c.post(STATE, json=_report(agent, 3, "working"), headers=_tok(token))).status_code == 200
        v = await _view(c, agent)
        assert (v["state"], v["activity"]) == ("working", "working")
        # a snapshot keeps the word too
        snap = {"report_seq": 4, "sessions": [{"session_key": "s-1", "agent_member_id": agent, "runtime": "claude", "state": WORD, "at": _now().isoformat()}]}
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap, headers=_tok(token))).status_code == 200
        assert (await _view(c, agent))["activity"] == WORD


async def test_03_a_limit_on_the_word_is_refused(world):
    async with _client() as c:
        d = await _device(c, name="d4599 window b")
        token, agent = d["device_token"], d["agents"][0]["member_id"]
        r = await c.post(STATE, json=_report(agent, 1, WORD, limit={}), headers=_tok(token))
        assert r.status_code == 422, r.text


async def test_04_a_phone_stop_on_a_held_turn_is_refused_with_its_own_reason_an_instruction_too_and_no_turn_end_notice_comes_of_it(world):
    """PO 12:40Z ④ · 14:18Z: a stop is never turned into an end of the session behind the person's back — an Esc cannot reach a
    process held in openat — and the session is not «stopped» either: it is frozen in that window. So a stop that arrives (the phone
    hides [멈춤] there; this is the race of a press just before the window) is refused with the closed reason `system_wait_end_only`
    (the daemon's word too — Mirko 385) · no command · NOT the «already_stopped» answer (a false answer to the phone · the web · an MCP
    caller — mutant: the old line alone gives 200 already_stopped → RED). An instruction goes only into a running turn. A held turn
    is not a turn that ended."""
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4424 mac 4599c")
        sid = device["setup_id"]
        # an instruction went in and was done — a resting word after it would tell the sender; the window word must not
        await _sent_and_done(c, device, agent, phone, conv, key="k-1")
        before = len(await _turn_end_notices(OWNER_TM))
        await _state(c, device, agent, WORD, 3)
        assert len(await _turn_end_notices(OWNER_TM)) == before, "held by a window: the turn has not ended"
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv, key="w-1"))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "session_not_working")
        r = await _post(c, agent, _cmd("stop_session", phone, key="w-2"))
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "system_wait_end_only", r.text
        assert "already_stopped" not in r.text
        kinds = [(k, s) for k, _p, _b, _i, s in await _commands(sid)]
        assert ("stop_session", "queued") not in kinds, "no stop command goes down onto a held turn"
        # the same key again: still the refusal (nothing was made to give back)
        r = await _post(c, agent, _cmd("stop_session", phone, key="w-2"))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "system_wait_end_only")
        # the window answered: the turn runs on, and a stop is taken as before
        await _state(c, device, agent, "working", 4)
        r = await _post(c, agent, _cmd("stop_session", phone, key="w-3"))
        assert r.status_code == 201, r.text


async def test_06_an_end_of_the_session_is_its_own_signed_kind_taken_on_a_held_turn_and_on_any_turn_not_stopped(world):
    """PO 14:08Z (Min's question): the one handle on a held turn is a new kind `end_session` — always ends · what the phone signed is
    what happens (never a stop re-read as an end). Carried like a stop (`{session_key, signed}` · no text · no conversation); the same
    key = the same command; the presser reads it; done → that session's waiting instructions close without a turn-end notice; on a
    session that has stopped → 200 already_stopped (nothing to end); on a running turn too (always ends). 0443 holds the kind."""
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4424 mac 4599d")
        sid = device["setup_id"]
        await _sent_and_done(c, device, agent, phone, conv, key="e-0")  # an instruction in — its sender would be told at the turn's end
        await _state(c, device, agent, WORD, 3)
        r = await _post(c, agent, _cmd("end_session", phone, key="e-x", conversation_id=conv))  # an end carries no conversation (nor text)
        assert r.status_code == 422, r.text
        r = await _post(c, agent, _cmd("end_session", phone, key="e-1"))
        assert r.status_code == 201, r.text
        cid = r.json()["command_id"]
        [(kind, payload, by, idem, state)] = [row for row in await _commands(sid) if row[0] == "end_session"]
        assert (kind, state, str(by), idem) == ("end_session", "queued", str(OWNER_TM), f"b3:{OWNER_TM}:e-1")
        assert payload == {"session_key": "s-1", "signed": "eyJ2IjoxfQ.signed-by-the-phone"}, "the stop's shape — the signed blob as is"
        r = await _post(c, agent, _cmd("end_session", phone, key="e-1"))
        assert r.json()["command_id"] == cid, "the same key gives back the same command"
        assert len([row for row in await _commands(sid) if row[0] == "end_session"]) == 1
        r = await c.get(f"/api/v2/agents/{agent}/desktop-commands/{cid}", headers=_person(OWNER))
        assert (r.status_code, r.json()["kind"], r.json()["state"]) == (200, "end_session", "queued"), r.text
        # the daemon ended it (SIGHUP → SIGKILL · Mirko 385): done → the waiting instruction closes, no turn-end notice of it
        before = len(await _turn_end_notices(OWNER_TM))
        done = await c.post(f"/api/v2/desktop/relay/commands/{cid}/result", json={"state": "done"}, headers=_tok(device["device_token"]))
        assert done.status_code == 200, done.text
        rows = await _sql(fetch=f"SELECT turn_end_notified_at IS NOT NULL FROM desktop_commands WHERE setup_id = '{sid}' AND kind = 'send_prompt'")
        assert [tuple(r) for r in rows] == [(True,)], "closed by the end — the sender is not told of a turn that was ended for them"
        await _state(c, device, agent, "stopped", 4)
        assert len(await _turn_end_notices(OWNER_TM)) == before
        # nothing to end on a session that has stopped
        r = await _post(c, agent, _cmd("end_session", phone, key="e-2"))
        assert (r.status_code, r.json()) == (200, {"state": "already_stopped"}), r.text
        # a running turn: ended too (always ends — the phone shows the button on the held turn only, the server does not second-guess the signature)
        await _state(c, device, agent, "working", 5)
        r = await _post(c, agent, _cmd("end_session", phone, key="e-3"))
        assert r.status_code == 201, r.text
    from app.core.database import async_session_factory
    from app.models.desktop_relay import COMMAND_KINDS

    async with async_session_factory() as s:
        (d,) = (await s.execute(text(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_desktop_commands_kind'"))).scalars().all()
    assert set(re.findall(r"'([a-z_]+)'", d)) == set(COMMAND_KINDS) and "end_session" in COMMAND_KINDS


async def test_05_the_windows_folder_rides_with_the_word_only_a_closed_list_and_clears_with_the_next_word(world):
    """Kadir lens ③ · Yuna ①: `system: {folder}` — the folder the window asks about, from a closed list, carried with waiting_system
    only; the DM header and the device list show it (`system.folder` · null when not read); any other word clears it; a folder outside
    the list, a path, or `system` on another word → 422; the CHECK holds the list."""
    from app.models.desktop_relay import SESSION_SYSTEM_FOLDERS

    async with _client() as c:
        d = await _device(c, name="d4599 window c")
        token, agent = d["device_token"], d["agents"][0]["member_id"]
        assert (await c.post(STATE, json=_report(agent, 1, "working"), headers=_tok(token))).status_code == 200
        assert (await c.post(STATE, json=_report(agent, 2, WORD, system={"folder": "desktop"}), headers=_tok(token))).status_code == 200
        v = await _view(c, agent)
        assert (v["state"], v["activity"], v["system"]) == ("working", WORD, {"folder": "desktop"})
        [s] = (await c.get(f"/api/v2/desktop/setups/{d['setup_id']}/sessions", headers=_person(OWNER))).json()["sessions"]
        assert s["system"] == {"folder": "desktop"}
        # the window seen by its owner alone: the word without a folder
        assert (await c.post(STATE, json=_report(agent, 3, WORD, system={}), headers=_tok(token))).status_code == 200
        assert (await _view(c, agent))["system"] == {"folder": None}
        assert (await c.post(STATE, json=_report(agent, 4, WORD), headers=_tok(token))).status_code == 200
        assert (await _view(c, agent))["system"] == {"folder": None}
        # the hold is over: the next word carries none, and the row's folder is gone
        assert (await c.post(STATE, json=_report(agent, 5, WORD, system={"folder": "icloud"}), headers=_tok(token))).status_code == 200
        assert (await c.post(STATE, json=_report(agent, 6, "working"), headers=_tok(token))).status_code == 200
        v = await _view(c, agent)
        assert v["system"] is None
        rows = await _sql(fetch=f"SELECT system_folder FROM desktop_sessions WHERE setup_id = '{d['setup_id']}'")
        assert [tuple(r) for r in rows] == [(None,)]
        # refused: a folder outside the list · a path · an extra field · system on another word
        for seq, (state, system) in enumerate([(WORD, {"folder": "pictures"}), (WORD, {"folder": "/Users/p/Documents"}), (WORD, {"folder": "documents", "path": "x"}),
                                               ("working", {"folder": "documents"}), ("waiting_permission", {})], start=7):
            r = await c.post(STATE, json=_report(agent, seq, state, system=system), headers=_tok(token))
            assert r.status_code == 422, (state, system, r.text)
        # the snapshot carries it the same way, and a dropped session loses it
        snap = {"report_seq": 20, "sessions": [{"session_key": "s-1", "agent_member_id": agent, "runtime": "claude", "state": WORD, "at": _now().isoformat(), "system": {"folder": "downloads"}}]}
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap, headers=_tok(token))).status_code == 200
        assert (await _view(c, agent))["system"] == {"folder": "downloads"}
        assert (await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 21, "sessions": []}, headers=_tok(token))).status_code == 200
        rows = await _sql(fetch=f"SELECT state, system_folder FROM desktop_sessions WHERE setup_id = '{d['setup_id']}'")
        assert [tuple(r) for r in rows] == [("stopped", None)]
    from app.core.database import async_session_factory

    async with async_session_factory() as s:
        (d,) = (await s.execute(text(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_desktop_sessions_system_folder'"))).scalars().all()
    assert set(re.findall(r"'([a-z_]+)'", d)) == set(SESSION_SYSTEM_FOLDERS)
