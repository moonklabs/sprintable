"""story #4548 (E-DESKTOP-2 B-1) — an already set-up device gets its relay token by a person's confirmation, not by setting it
up again. Contract: doc 02d2cf71 v1.4 §1.1 · its §5 rows.

The code is asked with that setup's own agent key (every other caller: one answer, setup_not_found), an owner/admin of the
device's org confirms it, the app exchanges it with its verifier for the device token alone — the agents and their keys stay.
"""
from __future__ import annotations

import base64
import hashlib
import secrets
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
from tests.test_4529_desktop_relay_realdb import _device, _tok

pytestmark = pytest.mark.anyio


def _pkce() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    return verifier, base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def _key(device: dict) -> dict:
    return {"Authorization": f"Bearer {device['agents'][0]['api_key']}"}


async def _ask(c, setup_id, headers=None, challenge=None):
    verifier, ch = _pkce()
    r = await c.post("/api/v2/desktop/device-token-codes", json={"setup_id": str(setup_id), "challenge": challenge or ch},
                     headers=headers or {})
    return r, verifier


async def _snapshot_ok(c, token, seq):
    return (await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": seq, "sessions": []}, headers=_tok(token))).status_code


async def _state() -> tuple:
    rows = await _sql(fetch=(
        "SELECT "
        f"(SELECT count(*) FROM members WHERE org_id='{ORG}' AND type='agent'),"
        f"(SELECT count(*) FROM agent_api_keys k JOIN members m ON m.id=k.team_member_id WHERE m.org_id='{ORG}' AND k.revoked_at IS NULL)"
    ))
    return tuple(rows[0])


async def test_a_confirmed_code_gives_the_device_a_new_token_and_leaves_its_agents_and_keys(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4548")
        old = device["device_token"]
        before = await _state()

        r, verifier = await _ask(c, device["setup_id"], _key(device))
        assert r.status_code == 201, r.text
        assert r.headers["cache-control"] == "no-store"
        code = r.json()["code"]
        exchange = {"code": code, "verifier": verifier}

        pending = await c.post("/api/v2/desktop/device-token-codes/exchange", json=exchange)
        assert pending.status_code == 202 and pending.json() == {"status": "pending"}

        peek = await c.post("/api/v2/desktop/device-token-codes/peek", json={"code": code}, headers=_person(OWNER))
        assert peek.status_code == 200, peek.text
        assert peek.json()["device_name"] == "d4424 mac 4548" and peek.json()["org_name"]

        for _ in range(2):  # the same person pressing again: 200, nothing new
            ok = await c.post("/api/v2/desktop/device-token-codes/confirm", json={"code": code}, headers=_person(OWNER))
            assert ok.status_code == 200 and ok.json() == {"setup_id": device["setup_id"]}

        wrong = await c.post("/api/v2/desktop/device-token-codes/exchange", json={**exchange, "verifier": _pkce()[0]})
        assert wrong.status_code == 403 and wrong.json()["error"]["code"] == "verifier_mismatch"  # does not burn the code

        done = await c.post("/api/v2/desktop/device-token-codes/exchange", json=exchange)
        assert done.status_code == 200, done.text
        assert done.headers["cache-control"] == "no-store"
        new = done.json()["device_token"]
        assert set(done.json()) == {"setup_id", "device_token"} and new.startswith("sdt_") and new != old

        assert await _snapshot_ok(c, new, 1) == 200
        assert await _snapshot_ok(c, old, 2) == 401  # the device's earlier token is revoked
        assert await _state() == before  # no agent made · no key made or revoked
        again = await c.post("/api/v2/desktop/device-token-codes/exchange", json=exchange)
        assert again.status_code == 410 and again.json()["error"]["code"] == "code_used"


async def test_only_the_setups_own_agent_key_asks_and_every_other_caller_gets_one_answer(world):
    """PO 08:36Z — no key · another setup's key · a disconnected setup's key · a person · an unknown setup: the same 404."""
    async with _client() as c:
        mine = await _device(c, name="d4424 mac a")
        other = await _device(c, name="d4424 mac b")
        gone = await _device(c, name="d4424 mac c")
        assert (await c.delete(f"/api/v2/desktop/setups/{gone['setup_id']}", headers=_person(OWNER))).status_code == 200
        # a setup marked disconnected whose key somehow stayed live (the disconnect revokes both in one transaction — the
        # setup's own mark is checked too, not only the key's)
        half = await _device(c, name="d4424 mac d")
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{half['setup_id']}'")

        answers = []
        for setup_id, headers in (
            (mine["setup_id"], {}),                                  # no key
            (mine["setup_id"], _key(other)),                         # another setup's agent key
            (gone["setup_id"], _key(gone)),                          # a disconnected device's key
            (half["setup_id"], _key(half)),                          # a disconnected device whose key stayed live
            (mine["setup_id"], _person(OWNER)),                      # a person (even the owner)
            (mine["setup_id"], _tok(mine["device_token"])),          # the device token (the relay's only)
            (str(uuid.uuid4()), _key(mine)),                         # a setup that is not there
        ):
            r, _ = await _ask(c, setup_id, headers)
            answers.append((r.status_code, r.json()))
        assert all(a == answers[0] for a in answers), answers
        assert answers[0][0] == 404 and answers[0][1]["error"]["code"] == "setup_not_found"
        assert (await _sql(fetch="SELECT count(*) FROM desktop_device_token_codes"))[0][0] == 0


async def test_only_an_owner_or_admin_of_the_devices_org_sees_and_confirms_it(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4548b")
        r, verifier = await _ask(c, device["setup_id"], _key(device))
        code = r.json()["code"]
        body = {"code": code}
        for path in ("peek", "confirm"):
            url = f"/api/v2/desktop/device-token-codes/{path}"
            agent = await c.post(url, json=body, headers=_key(device))
            assert agent.status_code == 403 and agent.json()["error"]["code"] == "person_session_required"
            assert (await c.post(url, json=body, headers=_tok(device["device_token"]))).status_code == 401
            for who, org in ((OUTSIDER, None), (PLAIN, ORG)):  # an admin of another org · a plain member of this one
                headers = _person(who, org) if org else _person(who)
                refused = await c.post(url, json=body, headers=headers)
                assert refused.status_code == 403 and refused.json()["error"]["code"] == "not_org_admin", (path, who)
        pending = await c.post("/api/v2/desktop/device-token-codes/exchange", json={"code": code, "verifier": verifier})
        assert pending.status_code == 202  # nobody confirmed it


async def test_a_device_disconnected_or_a_code_expired_is_neither_confirmed_nor_exchanged(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4548c")
        r, verifier = await _ask(c, device["setup_id"], _key(device))
        code = r.json()["code"]
        assert (await c.post("/api/v2/desktop/device-token-codes/confirm", json={"code": code}, headers=_person(OWNER))).status_code == 200
        assert (await c.delete(f"/api/v2/desktop/setups/{device['setup_id']}", headers=_person(OWNER))).status_code == 200
        gone = await c.post("/api/v2/desktop/device-token-codes/exchange", json={"code": code, "verifier": verifier})
        assert gone.status_code == 409 and gone.json()["error"]["code"] == "setup_disconnected"
        refused = await c.post("/api/v2/desktop/device-token-codes/confirm", json={"code": code}, headers=_person(OWNER))
        assert refused.status_code == 409

        live = await _device(c, name="d4424 mac 4548d")
        r, verifier = await _ask(c, live["setup_id"], _key(live))
        code = r.json()["code"]
        await _sql(f"UPDATE desktop_device_token_codes SET expires_at = now() - interval '1 second' WHERE setup_id = '{live['setup_id']}'")
        late = await c.post("/api/v2/desktop/device-token-codes/confirm", json={"code": code}, headers=_person(OWNER))
        assert late.status_code == 410 and late.json()["error"]["code"] == "code_expired"
        late = await c.post("/api/v2/desktop/device-token-codes/exchange", json={"code": code, "verifier": verifier})
        assert late.status_code == 410


async def test_the_code_travels_in_bodies_only_and_the_request_shape_is_closed(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4548e")
        r, _ = await _ask(c, device["setup_id"], _key(device))
        code = r.json()["code"]
        extra = await c.post("/api/v2/desktop/device-token-codes",
                             json={"setup_id": device["setup_id"], "challenge": _pkce()[1], "device_name": "x"}, headers=_key(device))
        assert extra.status_code == 422
        bad = await c.post("/api/v2/desktop/device-token-codes", json={"setup_id": device["setup_id"], "challenge": "!" * 43},
                           headers=_key(device))
        assert bad.status_code == 422  # not base64url
        from app.main import app

        paths = [getattr(route, "path", "") for route in app.routes if "device-token-codes" in getattr(route, "path", "")]
        assert paths and all("{" not in p for p in paths)  # no route takes the code (or anything) in its path
        assert code not in str(paths)


async def test_a_revoked_key_asks_for_nothing_even_past_the_sign_in(world):
    """The sign-in already refuses a revoked key; the code service checks it again on its own (a key revoked between the two)."""
    from app.core.database import async_session_factory
    from app.services.desktop_device_token_codes import create_code
    from app.services.desktop_setup import DesktopSetupError

    async with _client() as c:
        device = await _device(c, name="d4424 mac 4548f")
    key_id = (await _sql(fetch=f"SELECT id FROM agent_api_keys WHERE desktop_setup_id = '{device['setup_id']}' LIMIT 1"))[0][0]
    await _sql(f"UPDATE agent_api_keys SET revoked_at = now() WHERE id = '{key_id}'")
    async with async_session_factory() as s:
        with pytest.raises(DesktopSetupError) as e:
            await create_code(s, api_key_id=str(key_id), setup_id=uuid.UUID(device["setup_id"]), challenge=_pkce()[1])
    assert e.value.code == "setup_not_found"



async def test_a_persons_own_api_key_is_not_a_person_at_the_browser(world):
    """codex 01a10155 T1 (PO 10:59Z) — the owner's hu_live_ key is refused where a person must confirm: the token code's peek
    and confirm, and the setup's own confirmation; the owner's web session still passes."""
    from app.core.database import async_session_factory
    from app.repositories.human_api_key import HumanApiKeyRepository
    from tests.test_4424_desktop_setup_realdb import _code, _ROLES

    async with async_session_factory() as s:
        _hkey, plaintext = await HumanApiKeyRepository(s).create(member_id=OWNER_TM, name="d4548 script", expires_at=None)
        await s.commit()
    person_key = {"Authorization": f"Bearer {plaintext}", "X-Org-Id": str(ORG)}
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4548g")
        r, _verifier = await _ask(c, device["setup_id"], _key(device))
        code = r.json()["code"]
        for path in ("peek", "confirm"):
            refused = await c.post(f"/api/v2/desktop/device-token-codes/{path}", json={"code": code}, headers=person_key)
            assert refused.status_code == 403 and refused.json()["error"]["code"] == "person_session_required", path
        setup_code, _v = await _code(c, "d4424 laptop 4548g")
        refused = await c.post("/api/v2/desktop/setup-codes/confirm", json={**_ROLES, "code": setup_code}, headers=person_key)
        assert refused.status_code == 403 and refused.json()["error"]["code"] == "person_session_required"
        ok = await c.post("/api/v2/desktop/device-token-codes/confirm", json={"code": code}, headers=_person(OWNER))
        assert ok.status_code == 200  # the web session: as before
    await _sql(f"DELETE FROM human_api_keys WHERE member_id = '{OWNER_TM}'")
