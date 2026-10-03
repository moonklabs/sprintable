"""story #4535 (E-DESKTOP-2 B-4 · AC1) — an organization's «원격 제어» switch. Contract 02d2cf71 §2 (v1.5).

Off by default · only an owner turns it on and off. While off the device line is off as a whole: the relay refuses every call
(the device token stays valid), an open stream ends with `access_revoked {reason: remote_control_off}`, no command is made, and
turning it off rejects the devices' open commands. Turning it on wakes each live device through its agents' own streams.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OUTSIDER,
    OWNER,
    OWNER_TM,
    PLAIN,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _enqueue, _tok

pytestmark = pytest.mark.anyio

URL = f"/api/v2/organizations/{ORG}/remote-control"


async def _switch(c, enabled: bool, who=OWNER):
    return await c.put(URL, json={"enabled": enabled}, headers=_person(who))


async def _snapshot(c, token, seq):
    return await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": seq, "sessions": []}, headers=_tok(token))


async def test_it_starts_off_and_only_an_owner_changes_it(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4535a")
        key = {"Authorization": f"Bearer {device['agents'][0]['api_key']}"}
        owner = await c.get(URL, headers=_person(OWNER))
        assert owner.status_code == 200 and owner.json() == {"enabled": False, "enabled_at": None, "can_change": True}
        plain = await c.get(URL, headers=_person(PLAIN))
        assert plain.status_code == 200 and plain.json()["can_change"] is False
        outsider = await c.get(URL, headers=_person(OUTSIDER))  # not of this org: refused, and nothing of it shown
        assert outsider.status_code >= 400 and "enabled" not in outsider.text
        assert (await c.get(URL, headers=key)).status_code == 403  # an agent key

        refused = await _switch(c, True, PLAIN)
        assert refused.status_code == 403 and refused.json()["error"]["code"] == "owner_required"
        assert (await c.put(URL, json={"enabled": True}, headers=key)).status_code == 403
        assert (await c.put(URL, json={"enabled": True, "x": 1}, headers=_person(OWNER))).status_code == 422
        assert (await c.get(URL, headers=_person(OWNER))).json()["enabled"] is False  # nothing changed

        on = await _switch(c, True)
        assert on.status_code == 200 and on.json()["enabled"] is True and on.json()["enabled_at"]
        audit = await _sql(fetch=f"SELECT enabled, actor_id FROM org_remote_control_audit_logs WHERE org_id = '{ORG}'")
        assert [tuple(a) for a in audit] == [(True, OWNER_TM)]
        assert (await _switch(c, True)).status_code == 200  # the same value again: no second audit line
        assert len(await _sql(fetch=f"SELECT 1 FROM org_remote_control_audit_logs WHERE org_id = '{ORG}'")) == 1


async def test_while_off_the_device_line_is_off_as_a_whole_and_the_token_stays(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4535b")
        token = device["device_token"]
        off = await _snapshot(c, token, 1)
        assert off.status_code == 403 and off.json()["error"]["code"] == "remote_control_off"  # reports too (PO 08:55Z ⓐ)
        assert (await c.get("/api/v2/desktop/relay/stream", headers=_tok(token))).status_code == 403
        from app.services.desktop_relay import DesktopRelayError

        with pytest.raises(DesktopRelayError) as e:
            await _enqueue(device["setup_id"], "stop_session", {"session_key": "s-1"}, "k-off")
        assert (e.value.status, e.value.code) == (409, "remote_control_off")
        live = await _sql(fetch=f"SELECT count(*) FROM desktop_device_tokens WHERE setup_id = '{device['setup_id']}' AND revoked_at IS NULL")
        assert live[0][0] == 1  # the token is not revoked — turning on again needs no new confirmation

        assert (await _switch(c, True)).status_code == 200
        assert (await _snapshot(c, token, 2)).status_code == 200  # the same token goes on


async def test_turning_off_rejects_the_open_commands_and_turning_on_wakes_each_device_through_its_agents(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4535c")
        sid = device["setup_id"]
        agents = sorted(a["member_id"] for a in device["agents"])
        assert (await _switch(c, True)).status_code == 200
        woken = await _sql(fetch=(f"SELECT recipient_id::text, payload->>'setup_id', payload->>'enabled' FROM events "
                                  f"WHERE event_type = 'desktop.remote_control' AND source_entity_id = '{sid}' ORDER BY recipient_id"))
        assert [(r[0], r[1], r[2]) for r in woken] == [(a, sid, "true") for a in agents]

        await _enqueue(sid, "stop_session", {"session_key": "s-1"}, "k1")
        await _enqueue(sid, "stop_session", {"session_key": "s-2"}, "k2")
        await _sql(f"UPDATE desktop_commands SET state = 'done' WHERE setup_id = '{sid}' AND idempotency_key = 'k2'")
        assert (await _switch(c, False)).status_code == 200
        rows = await _sql(fetch=f"SELECT idempotency_key, state, result_code FROM desktop_commands WHERE setup_id = '{sid}' ORDER BY idempotency_key")
        assert [tuple(r) for r in rows] == [("k1", "rejected", "remote_control_off"), ("k2", "done", None)]


async def test_an_open_stream_ends_with_remote_control_off_when_the_org_turns_it_off(world, monkeypatch):
    import app.routers.desktop_relay as router_mod
    from app.services import remote_control

    monkeypatch.setattr(router_mod, "_RECHECK_SEC", 0)
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4535d")
        assert (await _switch(c, True)).status_code == 200
        calls = {"n": 0}
        real = remote_control.is_enabled

        async def turned_off_after_connecting(db, org_id):
            calls["n"] += 1
            return await real(db, org_id) if calls["n"] == 1 else False

        monkeypatch.setattr(remote_control, "is_enabled", turned_off_after_connecting)
        r = await c.get("/api/v2/desktop/relay/stream", headers=_tok(device["device_token"]))
        assert r.status_code == 200
        assert 'event: access_revoked\ndata: {"reason": "remote_control_off"}' in r.text


async def test_the_device_reads_its_orgs_state_with_its_own_agent_key(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4535e")
        key = {"Authorization": f"Bearer {device['agents'][0]['api_key']}"}
        assert (await c.get("/api/v2/desktop/remote-control", headers=key)).json() == {"enabled": False}
        await _switch(c, True)
        assert (await c.get("/api/v2/desktop/remote-control", headers=key)).json() == {"enabled": True}
        assert (await c.get("/api/v2/desktop/remote-control", headers=_person(OWNER))).status_code == 404  # not a device's key


async def test_the_token_code_checks_the_key_first_then_the_switch(world):
    """PO 08:55Z ⓑ — refusals before the key stay one answer (setup_not_found); past the key, «off» is said (409)."""
    import base64
    import hashlib
    import secrets

    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4535f")
        key = {"Authorization": f"Bearer {device['agents'][0]['api_key']}"}
        body = {"setup_id": device["setup_id"], "challenge": challenge}
        nokey = await c.post("/api/v2/desktop/device-token-codes", json=body)
        assert nokey.status_code == 404 and nokey.json()["error"]["code"] == "setup_not_found"
        off = await c.post("/api/v2/desktop/device-token-codes", json=body, headers=key)
        assert off.status_code == 409 and off.json()["error"]["code"] == "remote_control_off"

        await _switch(c, True)
        code = (await c.post("/api/v2/desktop/device-token-codes", json=body, headers=key)).json()["code"]
        await _switch(c, False)  # the org turns it off while the person looks at the page
        for path in ("peek", "confirm"):
            r = await c.post(f"/api/v2/desktop/device-token-codes/{path}", json={"code": code}, headers=_person(OWNER))
            assert r.status_code == 409 and r.json()["error"]["code"] == "remote_control_off", path
        x = await c.post("/api/v2/desktop/device-token-codes/exchange", json={"code": code, "verifier": verifier})
        assert x.status_code == 409 and x.json()["error"]["code"] == "remote_control_off"



async def test_an_owners_own_api_key_does_not_turn_remote_control_on(world):
    """PO 12:41Z (as 4548 T1) — opening remote control is a person at a browser: the owner's hu_live_ key is 403 on the PUT; the
    owner's web session still changes it; the read stays open to the org's people."""
    from app.core.database import async_session_factory
    from app.repositories.human_api_key import HumanApiKeyRepository

    async with async_session_factory() as s:
        _hkey, plaintext = await HumanApiKeyRepository(s).create(member_id=OWNER_TM, name="d4535 script", expires_at=None)
        await s.commit()
    person_key = {"Authorization": f"Bearer {plaintext}", "X-Org-Id": str(ORG)}
    try:
        async with _client() as c:
            refused = await c.put(URL, json={"enabled": True}, headers=person_key)
            assert refused.status_code == 403 and refused.json()["error"]["code"] == "person_session_required"
            assert (await c.get(URL, headers=_person(OWNER))).json()["enabled"] is False
            assert (await _switch(c, True)).status_code == 200  # the web session
    finally:
        await _sql(f"DELETE FROM human_api_keys WHERE member_id = '{OWNER_TM}'")
