"""story #4529 (E-DESKTOP-2 B-1) — the device relay. Contract: doc «E-DESKTOP-2 B-1 — 기기 줄 계약 v1» (02d2cf71), its §5 table.

A real code → confirm → exchange (4424's world) gives a device its token; each refusal of the contract is pinned here.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    OWNER,
    _addresses,
    _client,
    _code,
    _confirm,
    _dispose_global_engine_after_test,
    _exchange,
    _person,
    _sql,
    anyio_backend,
    world,
)

pytestmark = pytest.mark.anyio


async def _device(c, name="d4529 mac"):
    code, verifier = await _code(c, name)
    assert (await _confirm(c, code)).status_code == 200
    r = await _exchange(c, code, verifier)
    assert r.status_code == 200, r.text
    return r.json()


def _tok(token):
    return {"x-desktop-device-token": token}


def _report(agent, seq, state="working", **extra):
    return {"report_seq": seq, "agent_member_id": agent, "runtime": "claude", "state": state,
            "at": datetime.now(timezone.utc).isoformat(), **extra}


async def _enqueue(setup_id, kind, payload, key):
    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.services.desktop_relay import enqueue_command

    async with async_session_factory() as s:
        setup = await s.get(DesktopSetup, uuid.UUID(setup_id))
        cmd = await enqueue_command(s, setup=setup, kind=kind, payload=payload, idempotency_key=key, requested_by=OWNER)
        await s.commit()
        return cmd


async def test_the_exchange_hands_the_device_its_own_token_and_only_the_relay_takes_it(world):
    async with _client() as c:
        d = await _device(c)
        token = d["device_token"]
        assert token.startswith("sdt_") and len(token) > 40
        agent_key = d["agents"][0]["api_key"]
        assert agent_key != token
        ok = await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 1, "sessions": []}, headers=_tok(token))
        assert ok.status_code == 200, ok.text
        # an agent key or a person is no device here
        assert (await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 2, "sessions": []},
                            headers={"x-agent-api-key": agent_key})).status_code == 401
        assert (await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 2, "sessions": []},
                            headers=_person(OWNER))).status_code == 401
        # the device token is no identity anywhere else
        assert (await c.get("/api/v2/me", headers=_tok(token))).status_code == 401
        # only its hash is kept
        rows = await _sql(fetch=f"SELECT token_hash FROM desktop_device_tokens WHERE setup_id = '{d['setup_id']}'")
        assert len(rows) == 1 and token not in rows[0][0]


async def test_disconnecting_the_device_revokes_its_token_and_ends_an_open_stream(world, monkeypatch):
    from app.core.database import async_session_factory
    from app.services.desktop_relay import device_still_valid

    async with _client() as c:
        d = await _device(c)
        sid, token = d["setup_id"], d["device_token"]
        async with async_session_factory() as s:
            assert await device_still_valid(s, uuid.UUID(sid))
        r = await c.delete(f"/api/v2/desktop/setups/{sid}", headers=_person(OWNER))
        assert r.status_code == 200, r.text
        async with async_session_factory() as s:
            assert not await device_still_valid(s, uuid.UUID(sid))  # what an open stream's recheck reads
        assert (await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 1, "sessions": []},
                            headers=_tok(token))).status_code == 401
        n = await _sql(fetch=f"SELECT count(*) FROM desktop_device_tokens WHERE setup_id = '{sid}' AND revoked_at IS NULL")
        assert n[0][0] == 0


async def test_an_open_stream_sends_its_commands_then_ends_on_access_revoked(world, monkeypatch):
    import app.routers.desktop_relay as router_mod

    monkeypatch.setattr(router_mod, "_LIFESPAN_SEC", 1)
    monkeypatch.setattr(router_mod, "_LIFESPAN_JITTER_SEC", 0)
    monkeypatch.setattr(router_mod, "_POLL_SEC", 0.1)
    async with _client() as c:
        d = await _device(c)
        sid, token = d["setup_id"], d["device_token"]
        agent = d["agents"][0]["member_id"]
        await _enqueue(sid, "start_session", {"agent_member_id": agent, "runtime": "claude"}, "k1")
        await _enqueue(sid, "stop_session", {"session_key": "s-1"}, "k2")
        r = await c.get("/api/v2/desktop/relay/stream", headers=_tok(token))
        assert r.status_code == 200
        body = r.text
        assert body.count("event: command") == 2 and "id: 1\n" in body and "id: 2\n" in body
        assert body.rstrip().endswith("event: lifespan_reconnect\ndata: {}")
        # resumed after id 1: only the second (still unacknowledged) one
        r2 = await c.get("/api/v2/desktop/relay/stream", headers={**_tok(token), "Last-Event-ID": "1"})
        assert r2.text.count("event: command") == 1 and "id: 2\n" in r2.text
        # the recheck finds the device disconnected → access_revoked, the stream ends
        monkeypatch.setattr(router_mod, "_RECHECK_SEC", 0)

        async def gone(*_a, **_k):
            return False

        monkeypatch.setattr(router_mod.relay, "device_still_valid", gone)
        r3 = await c.get("/api/v2/desktop/relay/stream", headers=_tok(token))
        assert "event: access_revoked" in r3.text and "event: command" not in r3.text


async def test_session_reports_refuse_an_old_number_a_foreign_agent_and_any_extra_field(world):
    async with _client() as c:
        d = await _device(c)
        token, agent = d["device_token"], d["agents"][0]["member_id"]
        url = "/api/v2/desktop/relay/sessions/s-1/state"
        assert (await c.post(url, json=_report(agent, 5), headers=_tok(token))).status_code == 200
        assert (await c.post(url, json=_report(agent, 5, "idle"), headers=_tok(token))).status_code == 409  # same number
        assert (await c.post(url, json=_report(agent, 4, "idle"), headers=_tok(token))).status_code == 409  # older
        assert (await c.post(url, json=_report(str(uuid.uuid4()), 6), headers=_tok(token))).status_code == 422
        for extra in ({"terminal": "\x1b[31mhi"}, {"prompt": "do it"}, {"api_key": "sk_live_x"}, {"cwd": "/Users/x"}):
            assert (await c.post(url, json=_report(agent, 7, **extra), headers=_tok(token))).status_code == 422, extra
        assert (await c.post(url, json=_report(agent, 8, "waiting_permission"), headers=_tok(token))).status_code == 200
        rows = await _sql(fetch=f"SELECT state, last_report_seq FROM desktop_sessions WHERE setup_id = '{d['setup_id']}'")
        assert [tuple(r) for r in rows] == [("waiting_permission", 8)]


async def test_a_snapshot_replaces_the_list_and_a_silent_device_shows_unknown(world):
    async with _client() as c:
        d = await _device(c)
        sid, token, agent = d["setup_id"], d["device_token"], d["agents"][0]["member_id"]
        snap = lambda seq, keys: {"report_seq": seq, "sessions": [  # noqa: E731
            {"session_key": k, "agent_member_id": agent, "runtime": "codex", "state": "idle", "at": datetime.now(timezone.utc).isoformat()}
            for k in keys]}
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap(1, ["a", "b"]), headers=_tok(token))).status_code == 200
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap(2, ["a"]), headers=_tok(token))).status_code == 200
        view = (await c.get(f"/api/v2/desktop/setups/{sid}/sessions", headers=_person(OWNER))).json()["sessions"]
        assert {(v["session_key"], v["state"]) for v in view} == {("a", "idle"), ("b", "stopped")}
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '91 seconds' WHERE setup_id = '{sid}'")
        view = (await c.get(f"/api/v2/desktop/setups/{sid}/sessions", headers=_person(OWNER))).json()["sessions"]
        assert {(v["session_key"], v["state"]) for v in view} == {("a", "unknown"), ("b", "stopped")}  # never «dead»
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '89 seconds' WHERE setup_id = '{sid}'")
        view = (await c.get(f"/api/v2/desktop/setups/{sid}/sessions", headers=_person(OWNER))).json()["sessions"]
        assert ("a", "idle") in {(v["session_key"], v["state"]) for v in view}


async def test_commands_four_kinds_a_schema_each_one_row_per_key_numbered_per_device(world):
    from app.services.desktop_relay import DesktopRelayError

    async with _client() as c:
        d = await _device(c)
        sid, agent = d["setup_id"], d["agents"][0]["member_id"]
        # a kind off the list is refused as such, even with a payload another kind would take
        with pytest.raises(DesktopRelayError) as e:
            await _enqueue(sid, "run_shell", {"session_key": "s"}, "bad-shell")
        assert (e.value.status, e.value.code) == (422, "unknown_command_kind")
        for kind, payload in (("run_shell", {"cmd": "ls"}), ("send_prompt", {"session_key": "s", "text": "hi", "keys": "x"}),
                              ("start_session", {"agent_member_id": str(uuid.uuid4()), "runtime": "claude"}),
                              ("send_prompt", {"session_key": "s", "text": "x" * 8001})):
            with pytest.raises(DesktopRelayError) as e:
                await _enqueue(sid, kind, payload, f"bad-{kind}")
            assert e.value.status == 422, (kind, payload)
        first = await _enqueue(sid, "send_prompt", {"session_key": "s", "text": "hi"}, "same")
        again = await _enqueue(sid, "send_prompt", {"session_key": "s", "text": "other"}, "same")
        assert again.id == first.id and again.payload == {"session_key": "s", "text": "hi"}
        second = await _enqueue(sid, "start_session", {"agent_member_id": agent, "runtime": "codex"}, "k2")
        assert (first.device_seq, second.device_seq) == (1, 2)


async def test_the_db_takes_only_the_listed_kinds_and_states_and_the_code_lists_match_it(world):
    """DB CHECK and COMMAND_KINDS · COMMAND_STATES are the same lists — one changed alone is RED."""
    import re

    from app.models.desktop_relay import COMMAND_KINDS, COMMAND_STATES

    defs = {r[0]: r[1] for r in await _sql(fetch=(
        "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN "
        "('ck_desktop_commands_kind','ck_desktop_commands_state')"))}
    assert set(re.findall(r"'([a-z_]+)'", defs["ck_desktop_commands_kind"])) == set(COMMAND_KINDS)
    assert set(re.findall(r"'([a-z_]+)'", defs["ck_desktop_commands_state"])) == set(COMMAND_STATES)
    async with _client() as c:
        d = await _device(c)
    with pytest.raises(Exception):
        await _sql(
            "INSERT INTO desktop_commands (id, setup_id, device_seq, kind, payload, idempotency_key, requested_by) VALUES "
            f"(gen_random_uuid(), '{d['setup_id']}', 99, 'run_shell', '{{}}', 'x', '{OWNER}')"
        )


async def test_a_command_result_moves_forward_only_and_never_for_another_device(world):
    async with _client() as c:
        d1, d2 = await _device(c, "mac one"), await _device(c, "mac two")
        cmd = await _enqueue(d1["setup_id"], "stop_session", {"session_key": "s"}, "k")
        url = f"/api/v2/desktop/relay/commands/{cmd.id}/result"
        assert (await c.post(url, json={"state": "acked"}, headers=_tok(d2["device_token"]))).status_code == 404
        assert (await c.post(url, json={"state": "acked"}, headers=_tok(d1["device_token"]))).status_code == 200
        assert (await c.post(url, json={"state": "acked"}, headers=_tok(d1["device_token"]))).status_code == 409
        assert (await c.post(url, json={"state": "done", "result_code": "stopped"}, headers=_tok(d1["device_token"]))).status_code == 200
        assert (await c.post(url, json={"state": "failed"}, headers=_tok(d1["device_token"]))).status_code == 409  # no way back
        assert (await c.post(url, json={"state": "done", "output": "secret"}, headers=_tok(d1["device_token"]))).status_code == 422
        # another device's session report never touches this device's sessions
        agent2 = d2["agents"][0]["member_id"]
        r = await c.post("/api/v2/desktop/relay/sessions/s/state", json=_report(agent2, 1), headers=_tok(d1["device_token"]))
        assert r.status_code == 422  # d2's agent is not on d1
