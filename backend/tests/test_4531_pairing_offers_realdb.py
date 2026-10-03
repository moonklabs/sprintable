"""story #4531 (E-DESKTOP-2 B-2 데스크톱 · contract 02d2cf71 v1.10 §10 ⑤) — a phone's answer to a desktop's pairing QR goes down
as `pairing_offer`, carried as it is.

The trust is not the server's: the QR's secret never comes here, so the server neither makes nor checks the MAC — it only checks
that the key is the caller's own, the computer is theirs to reach, remote control is on, the window is the QR's (≤5 min) and the
computer is there. The same offer again is the same row; the same offer with another key or MAC is refused (one answer per QR).
The frame goes on every connection until the window ends, and adds nothing by itself (the daemon pins only an offer it opened).
"""
from __future__ import annotations

import base64
import hmac
import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone

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
from tests.test_4533_agent_permissions_realdb import _plain_member, _register, _remote_control_on, _with_session  # noqa: F401

pytestmark = pytest.mark.anyio

OFFERS = "/api/v2/remote-devices/pairing-offers"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _mac(secret: bytes, offer_id: str, phone_id: str, public_key: str, setup_id: str, label: str = "iPhone") -> str:
    """The phone's side (contract §10 ⑤ · v1.11): HMAC-SHA256 over the canonical JSON (its name too), keys sorted, no spaces."""
    body = json.dumps({"label": label, "offer_id": offer_id, "phone_key_id": phone_id, "public_key": public_key, "setup_id": setup_id, "v": 1},
                      sort_keys=True, separators=(",", ":"))
    return _b64(hmac.new(secret, body.encode(), hashlib.sha256).digest())


def _offer(device, phone_id, public_key, *, offer_id=None, minutes=5, secret=b"s" * 32, **extra):
    offer_id = offer_id or str(uuid.uuid4())
    body = {"setup_id": device["setup_id"], "offer_id": offer_id, "phone_key_id": phone_id, "label": "iPhone",
            "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat(),
            "mac": _mac(secret, offer_id, phone_id, public_key, device["setup_id"])}
    body.update(extra)
    return body


async def _phone_key(phone_id) -> str:
    return (await _sql(fetch=f"SELECT public_key FROM remote_devices WHERE id = '{phone_id}'"))[0][0]


async def test_01_the_owner_carries_the_key_down_as_it_is_and_the_frame_goes_until_the_window_ends(world, monkeypatch):
    from app.routers import desktop_relay as router_mod

    monkeypatch.setattr(router_mod, "_LIFESPAN_SEC", 0.3)
    monkeypatch.setattr(router_mod, "_LIFESPAN_JITTER_SEC", 0)
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4531a")
        await _with_session(c, device)  # the computer has been heard from
        phone_id, _der = await _register(c)
        public_key = await _phone_key(phone_id)
        body = _offer(device, phone_id, public_key)

        r = await c.post(OFFERS, json=body, headers=_person(OWNER))
        assert (r.status_code, r.json()) == (202, {"state": "sent"})
        again = await c.post(OFFERS, json=body, headers=_person(OWNER))  # the same phone, the same offer: the same row
        assert again.status_code == 202
        assert (await _sql(fetch="SELECT count(*) FROM remote_device_pairing_offers"))[0][0] == 1

        text = (await c.get("/api/v2/desktop/relay/stream", headers=_tok(device["device_token"]))).text
        frames = [json.loads(line[6:]) for block in text.split("\n\n") if block.startswith("event: pairing_offer")
                  for line in block.split("\n") if line.startswith("data: ")]
        # the key, the label and the phone's MAC as they are — the server added nothing of its own, and holds no secret
        # v1.11: the label is the one the phone sent (inside its MAC), not the server's registry
        assert frames == [{"offer_id": body["offer_id"], "phone_key_id": phone_id, "public_key": public_key, "label": "iPhone",
                           "mac": body["mac"], "expires_at": frames[0]["expires_at"]}]
        assert "pairing_offer" in (await c.get("/api/v2/desktop/relay/stream", headers=_tok(device["device_token"]))).text

        # v1.11 — the desktop's random value (drawn after the MAC bound the key) goes back to the phone that sent the offer only
        state = f"{OFFERS}/{body['offer_id']}?setup_id={device['setup_id']}"
        assert (await c.get(state, headers=_person(OWNER))).json() == {"state": "sent", "reveal": None}
        reveal = _b64(b"r" * 32)
        up = f"/api/v2/desktop/relay/pairing-offers/{body['offer_id']}/reveal"
        assert (await c.post(up, json={"reveal": reveal}, headers=_tok(device["device_token"]))).status_code == 200
        assert (await c.post(up, json={"reveal": reveal}, headers=_tok(device["device_token"]))).status_code == 200  # the same again
        other = await c.post(up, json={"reveal": _b64(b"x" * 32)}, headers=_tok(device["device_token"]))
        assert (other.status_code, other.json()["error"]["code"]) == (409, "already_revealed")  # the number must not move
        assert (await c.get(state, headers=_person(OWNER))).json() == {"state": "revealed", "reveal": reveal}
        # someone else of the org · a key, not a person's session: the same «not found» / 403
        plain_tm = await _plain_member()
        assert plain_tm and (await c.get(state, headers=_person(PLAIN))).json()["error"]["code"] == "offer_not_found"
        assert (await c.post(up.replace(body["offer_id"], str(uuid.uuid4())), json={"reveal": reveal}, headers=_tok(device["device_token"]))).json()["error"]["code"] == "offer_not_found"
        assert (await c.post(up, json={"reveal": "short"}, headers=_tok(device["device_token"]))).status_code == 422
        assert (await c.post(up, json={"reveal": reveal}, headers=_person(OWNER))).status_code == 401  # a person cannot reveal for a device

        # past its window: no longer sent · the phone reads «expired» only while nothing was revealed (here: still revealed)
        await _sql("UPDATE remote_device_pairing_offers SET expires_at = now() - interval '1 second'")
        assert "pairing_offer" not in (await c.get("/api/v2/desktop/relay/stream", headers=_tok(device["device_token"]))).text
        late = await c.post(up, json={"reveal": reveal}, headers=_tok(device["device_token"]))
        assert (late.status_code, late.json()["error"]["code"]) == (410, "offer_expired")


async def test_02_one_answer_per_qr_another_key_or_mac_for_the_same_offer_is_refused(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4531b")
        await _with_session(c, device)
        first, _ = await _register(c)
        second, _ = await _register(c, label="old phone")
        offer_id = str(uuid.uuid4())
        assert (await c.post(OFFERS, json=_offer(device, first, await _phone_key(first), offer_id=offer_id), headers=_person(OWNER))).status_code == 202
        other = await c.post(OFFERS, json=_offer(device, second, await _phone_key(second), offer_id=offer_id), headers=_person(OWNER))
        assert (other.status_code, other.json()["error"]["code"]) == (409, "offer_used")
        swapped_mac = _offer(device, first, await _phone_key(first), offer_id=offer_id, secret=b"x" * 32)
        assert (await c.post(OFFERS, json=swapped_mac, headers=_person(OWNER))).json()["error"]["code"] == "offer_used"
        renamed = _offer(device, first, await _phone_key(first), offer_id=offer_id) | {"label": "Boss iPhone"}
        assert (await c.post(OFFERS, json=renamed, headers=_person(OWNER))).json()["error"]["code"] == "offer_used"


async def test_03_only_the_keys_owner_in_their_own_session_for_a_computer_they_can_reach(world):
    from app.core.database import async_session_factory
    from app.repositories.human_api_key import HumanApiKeyRepository

    plain_tm = await _plain_member()
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4531c")
        await _with_session(c, device)
        phone_id, _ = await _register(c)
        public_key = await _phone_key(phone_id)
        code = lambda r: (r.status_code, r.json()["error"]["code"])  # noqa: E731

        # someone else's key (another person of the org)
        assert code(await c.post(OFFERS, json=_offer(device, phone_id, public_key), headers=_person(PLAIN))) == (404, "phone_key_not_found")
        # a person's own API key · the device's agent key
        async with async_session_factory() as s:
            _k, plaintext = await HumanApiKeyRepository(s).create(member_id=OWNER_TM, name="d4531 script", expires_at=None)
            await s.commit()
        try:
            for headers in ({"Authorization": f"Bearer {plaintext}", "X-Org-Id": str(ORG)},
                            {"Authorization": f"Bearer {device['agents'][0]['api_key']}", "X-Org-Id": str(ORG)}):
                assert code(await c.post(OFFERS, json=_offer(device, phone_id, public_key), headers=headers)) == (403, "person_session_required")
        finally:
            await _sql(f"DELETE FROM human_api_keys WHERE member_id = '{OWNER_TM}'")
        # a computer that is not there for them: unknown id · disconnected — one answer
        assert code(await c.post(OFFERS, json=_offer(device, phone_id, public_key, setup_id=str(uuid.uuid4())), headers=_person(OWNER))) == (404, "setup_not_found")
        # the window: past · beyond five minutes
        assert code(await c.post(OFFERS, json=_offer(device, phone_id, public_key, minutes=-1), headers=_person(OWNER))) == (422, "invalid_expiry")
        assert code(await c.post(OFFERS, json=_offer(device, phone_id, public_key, minutes=30), headers=_person(OWNER))) == (422, "invalid_expiry")
        # a MAC that is not one (shape) · a field the contract has not
        assert (await c.post(OFFERS, json=_offer(device, phone_id, public_key, mac="short"), headers=_person(OWNER))).status_code == 422
        assert (await c.post(OFFERS, json=_offer(device, phone_id, public_key, secret_hint="x"), headers=_person(OWNER))).status_code == 422
        # a revoked key
        await _sql(f"UPDATE remote_devices SET revoked_at = now() WHERE id = '{phone_id}'")
        assert code(await c.post(OFFERS, json=_offer(device, phone_id, public_key), headers=_person(OWNER))) == (404, "phone_key_not_found")
        await _sql(f"UPDATE remote_devices SET revoked_at = NULL WHERE id = '{phone_id}'")
        # remote control off · a computer not heard from
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{ORG}'")
        assert code(await c.post(OFFERS, json=_offer(device, phone_id, public_key), headers=_person(OWNER))) == (409, "remote_control_off")
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'")
        await _sql("UPDATE desktop_device_tokens SET last_used_at = now() - interval '10 minutes'")
        assert code(await c.post(OFFERS, json=_offer(device, phone_id, public_key), headers=_person(OWNER))) == (409, "device_unreachable")
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{device['setup_id']}'")
        assert code(await c.post(OFFERS, json=_offer(device, phone_id, public_key), headers=_person(OWNER))) == (404, "setup_not_found")
        assert (await _sql(fetch="SELECT count(*) FROM remote_device_pairing_offers"))[0][0] == 0
        assert plain_tm  # PLAIN is a person of the org (their members row), only not the key's owner
