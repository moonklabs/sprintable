"""story 4972 (design ② §5-2 «숫자 절차») — pairing on the new procedure, the server's half: four small PUBLIC messages are carried between a computer and a phone, in ORDER and with «ONE».

host registers the QR's offer → phone COMMIT → (frame) → host NONCE → phone reads it → phone REVEAL → (frame) → host. The server holds no secret and checks no cryptography (the 8-digit number the two people compare is the check); it enforces who may
send (a commitment only from a member of the computer's organization with a key of their own · a reveal only by the one who committed · the host's messages only by its device token), the order (the database says so too · 0481), the «one» (a second
different commitment — from anyone — ends the offer for good, and that burn must survive the refusal) and the window; and a computer on this procedure is never offered the old six-digit one (no downgrade — PO 11-16).
"""
from __future__ import annotations

import asyncio
import base64
import json
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    ORG2,
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
from tests.test_4531_pairing_offers_realdb import _offer, _phone_key

pytestmark = pytest.mark.anyio

REL = "/api/v2/desktop/relay"
PHONE = "/api/v2/remote-devices"


def _b(n: int, fill: bytes = b"x") -> str:
    return base64.urlsafe_b64encode((fill * n)[:n]).rstrip(b"=").decode()


COMMIT = _b(32, b"c")     # 43 chars
NM = _b(16, b"m")         # 22 chars
SIG = _b(70, b"s")        # 94 chars
NP = _b(16, b"p")
BOX = _b(32, b"b")


def _exp(minutes: float = 5) -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()


async def _register_offer(c, device, offer_id=None, minutes=5):
    offer_id = offer_id or str(uuid.uuid4())
    r = await c.post(f"{REL}/pairing-sessions", json={"offer_id": offer_id, "expires_at": _exp(minutes)}, headers=_tok(device["device_token"]))
    return offer_id, r


def _commit_body(device, phone_id, commit=COMMIT):
    return {"setup_id": device["setup_id"], "phone_key_id": phone_id, "commit": commit}


def _reveal_body(device, spki, **over):
    return {"setup_id": device["setup_id"], "phone_spki": spki, "phone_box_pub": BOX, "n_p": NP, "label": "iPhone", "binding_sig": SIG, **over}


async def _row(offer_id) -> dict:
    r = (await _sql(fetch=f"SELECT commitment, n_m, reveal IS NOT NULL, burned_at IS NOT NULL, burn_reason FROM remote_device_pairing_sessions WHERE offer_id = '{offer_id}'"))[0]
    return {"commit": r[0], "n_m": r[1], "revealed": r[2], "burned": r[3], "reason": r[4]}


async def _burned_of(c, device, offer_id):
    return [f for f in await _frames(c, device, "pairing_burned") if f["offer_id"] == offer_id]


async def _frames(c, device, name):
    text = (await c.get(f"{REL}/stream", headers=_tok(device["device_token"]))).text
    return [json.loads(line[6:]) for block in text.split("\n\n") if block.startswith(f"event: {name}") for line in block.split("\n") if line.startswith("data: ")]


async def _frames_until(c, device, name, *, count=1, within=20.0):
    """The frames a computer is TOLD, read until at least `count` are there — not through one 0.3-second stream window.
    `_short_stream` gives every read its own 0.3 s connection; on a loaded runner the connection can be slow enough that its lifespan is over before its first pass, and it then says
    `lifespan_reconnect` and ends with NO frame (nothing was sent on it — the next connection tells the same frames again: each connection is told every frame of the offers it has).
    A positive expectation therefore reads again, each read a whole snapshot, until the frames are there or `within` seconds have passed (then the last snapshot is returned, so the
    assertion shows what was really told); an expectation of NOTHING still reads once (`_frames`)."""
    end = time.monotonic() + within
    while True:
        got = await _frames(c, device, name)
        if len(got) >= count or time.monotonic() >= end:
            return got
        await asyncio.sleep(0.05)


async def _burned_until(c, device, offer_id, *, within=20.0):
    return [f for f in await _frames_until(c, device, "pairing_burned", count=1, within=within) if f["offer_id"] == offer_id]


@pytest.fixture(autouse=True)
def _short_stream(monkeypatch):
    from app.routers import desktop_relay as router_mod

    monkeypatch.setattr(router_mod, "_LIFESPAN_SEC", 0.3)
    monkeypatch.setattr(router_mod, "_LIFESPAN_JITTER_SEC", 0)


async def _ready(c):
    """a computer that has been heard from, and a phone key of the owner"""
    device = await _device(c, name="d4424 mac 4972p")
    await _with_session(c, device)
    phone_id, _der = await _register(c)
    return device, phone_id, await _phone_key(phone_id)


async def test_01_the_whole_procedure_in_order_and_each_message_reaches_the_other_side_as_it_is(world):
    async with _client() as c:
        device, phone_id, spki = await _ready(c)
        offer_id, r = await _register_offer(c, device)
        assert (r.status_code, r.json()) == (201, {"state": "registered"})
        again = await c.post(f"{REL}/pairing-sessions", json={"offer_id": offer_id, "expires_at": (await _sql(fetch=f"SELECT expires_at FROM remote_device_pairing_sessions WHERE offer_id = '{offer_id}'"))[0][0].isoformat()}, headers=_tok(device["device_token"]))
        assert again.status_code == 201  # the same registration again (a reconnect): the same offer

        url = f"{PHONE}/pairing-sessions/{offer_id}"
        state = f"{url}?setup_id={device['setup_id']}"
        assert (await c.get(state, headers=_person(OWNER))).status_code == 404  # nobody has committed: nothing of the phone's yet
        r = await c.post(f"{url}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))
        assert (r.status_code, r.json()) == (202, {"state": "committed"})
        assert (await c.get(state, headers=_person(OWNER))).json() == {"state": "committed", "n_m": None, "sig": None, "confirmed_sig": None}
        # the computer hears the commitment, as it is, with the phone key's id (the server's name for the key)
        assert await _frames(c, device, "pairing_commit") == [{"offer_id": offer_id, "phone_key_id": phone_id, "commit": COMMIT}]

        up = f"{REL}/pairing-sessions/{offer_id}/nonce"
        r = await c.post(up, json={"n_m": NM, "sig": SIG}, headers=_tok(device["device_token"]))
        assert (r.status_code, r.json()) == (200, {"state": "nonce"})
        assert (await c.post(up, json={"n_m": NM, "sig": SIG}, headers=_tok(device["device_token"]))).status_code == 200  # the same again
        other = await c.post(up, json={"n_m": _b(16, b"z"), "sig": SIG}, headers=_tok(device["device_token"]))
        assert (other.status_code, other.json()["error"]["code"]) == (409, "nonce_used")
        assert (await _row(offer_id))["burned"] is False  # the computer's own second nonce does not end the offer
        assert (await c.get(state, headers=_person(OWNER))).json() == {"state": "nonce", "n_m": NM, "sig": SIG, "confirmed_sig": None}
        assert await _frames(c, device, "pairing_commit") == []  # answered: no commitment frame any more

        r = await c.post(f"{url}/reveal", json=_reveal_body(device, spki), headers=_person(OWNER))
        assert (r.status_code, r.json()) == (202, {"state": "revealed"})
        assert (await c.post(f"{url}/reveal", json=_reveal_body(device, spki), headers=_person(OWNER))).status_code == 202  # the same again
        assert (await c.get(state, headers=_person(OWNER))).json()["state"] == "revealed"
        assert await _frames(c, device, "pairing_reveal") == [{"offer_id": offer_id, "phone_key_id": phone_id, "phone_spki": spki, "phone_box_pub": BOX, "n_p": NP, "label": "iPhone", "binding_sig": SIG}]


async def test_02_the_order_is_enforced_in_the_service_and_in_the_database(world):
    async with _client() as c:
        device, phone_id, spki = await _ready(c)
        offer_id, _r = await _register_offer(c, device)
        url = f"{PHONE}/pairing-sessions/{offer_id}"
        nonce = lambda: c.post(f"{REL}/pairing-sessions/{offer_id}/nonce", json={"n_m": NM, "sig": SIG}, headers=_tok(device["device_token"]))  # noqa: E731
        r = await nonce()
        assert (r.status_code, r.json()["error"]["code"]) == (409, "no_commit")  # a nonce before any commitment
        # a commitment for an offer the computer never registered
        r = await c.post(f"{PHONE}/pairing-sessions/{uuid.uuid4()}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))
        assert (r.status_code, r.json()["error"]["code"]) == (404, "offer_not_found")
        assert (await c.post(f"{url}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).status_code == 202
        r = await c.post(f"{url}/reveal", json=_reveal_body(device, spki), headers=_person(OWNER))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "no_nonce")  # a reveal before the computer's nonce
        # the database says it too: a nonce with no commitment · a reveal with no nonce · a half-written commitment
        for sql in (
            f"UPDATE remote_device_pairing_sessions SET n_m = '{NM}', nonce_sig = '{SIG}', nonced_at = now() WHERE offer_id = '{offer_id}' AND commitment IS NULL",
        ):
            await _sql(sql)  # (matches no row: the offer has a commitment) — the real checks are below, on fresh rows
        o2, _ = await _register_offer(c, device)
        for bad in (
            f"UPDATE remote_device_pairing_sessions SET n_m = '{NM}', nonce_sig = '{SIG}', nonced_at = now() WHERE offer_id = '{o2}'",
            f"UPDATE remote_device_pairing_sessions SET reveal = '{{}}'::jsonb, revealed_at = now() WHERE offer_id = '{o2}'",
            f"UPDATE remote_device_pairing_sessions SET commitment = '{COMMIT}' WHERE offer_id = '{o2}'",
            f"UPDATE remote_device_pairing_sessions SET burned_at = now() WHERE offer_id = '{o2}'",
            f"UPDATE remote_device_pairing_sessions SET commitment = 'short', committed_by = '{OWNER_TM}', phone_key_id = '{phone_id}', committed_at = now() WHERE offer_id = '{o2}'",
        ):
            with pytest.raises(Exception):
                await _sql(bad)


async def test_03_a_second_different_commitment_from_anyone_ends_the_offer_for_good_and_the_burn_stays(world):
    async with _client() as c:
        device, phone_id, _spki = await _ready(c)
        plain_tm = await _plain_member()
        offer_id, _r = await _register_offer(c, device)
        url = f"{PHONE}/pairing-sessions/{offer_id}"
        assert (await c.post(f"{url}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).status_code == 202
        assert (await c.post(f"{url}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).status_code == 202  # the same retry: the same answer
        assert (await _row(offer_id))["burned"] is False
        # other bytes (the same person · the same key): the offer ends — and the burn is committed with the refusal
        r = await c.post(f"{url}/commit", json=_commit_body(device, phone_id, commit=_b(32, b"d")), headers=_person(OWNER))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "offer_burned")
        assert await _row(offer_id) | {} == {"commit": COMMIT, "n_m": None, "revealed": False, "burned": True, "reason": "second_commit"}
        # nothing goes through on a dead offer — from either side
        assert (await c.post(f"{url}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).json()["error"]["code"] == "offer_burned"
        n = await c.post(f"{REL}/pairing-sessions/{offer_id}/nonce", json={"n_m": NM, "sig": SIG}, headers=_tok(device["device_token"]))
        assert (n.status_code, n.json()["error"]["code"]) == (409, "offer_burned")
        assert await _frames(c, device, "pairing_commit") == []  # and the computer is told nothing of it
        # another person of the org commits first on a fresh offer, then the owner: the second ends it too
        o2, _ = await _register_offer(c, device)
        pk, _der = await _register(c, who=PLAIN, label="plain phone") if plain_tm else (None, None)
        assert (await c.post(f"{PHONE}/pairing-sessions/{o2}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).status_code == 202
        r = await c.post(f"{PHONE}/pairing-sessions/{o2}/commit", json=_commit_body(device, pk), headers=_person(PLAIN))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "offer_burned")
        assert (await _row(o2))["reason"] == "second_commit"


async def test_04_who_may_commit_a_person_outside_the_org_or_a_key_that_is_not_theirs_is_refused_and_burns_nothing(world):
    async with _client() as c:
        device, phone_id, _spki = await _ready(c)
        offer_id, _r = await _register_offer(c, device)
        url = f"{PHONE}/pairing-sessions/{offer_id}/commit"
        # outside the computer's organization: «no such computer» — the same answer as the old offer's — and the offer is untouched
        r = await c.post(url, json=_commit_body(device, phone_id), headers=_person(OUTSIDER))
        assert r.status_code in (403, 404)
        assert (await _row(offer_id))["burned"] is False and (await _row(offer_id))["commit"] is None
        # a member of the computer's org who ALSO belongs to another org, with a phone key registered THERE, committing under that org's header: the computer is not in that org — «no such computer», the offer untouched
        tm2 = uuid.uuid4()
        await _sql(f"INSERT INTO org_members (id, org_id, user_id, role) VALUES ('{tm2}', '{ORG2}', '{OWNER}', 'member')",
                   f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{tm2}','{ORG2}','{OWNER}','human','Owner2',true)")
        try:
            key2, _der2 = __import__("tests.test_4533_agent_permissions_realdb", fromlist=["_phone_key"])._phone_key()
            reg = await c.post(PHONE, json={"label": "iPhone org2", "public_key": key2}, headers=_person(OWNER, ORG2))
            assert reg.status_code == 201, reg.text
            r = await c.post(url, json=_commit_body(device, reg.json()["id"]), headers=_person(OWNER, ORG2))
            assert (r.status_code, r.json()["error"]["code"]) == (404, "setup_not_found"), r.text
        finally:
            await _sql(f"DELETE FROM remote_devices WHERE org_id = '{ORG2}'", f"DELETE FROM members WHERE id = '{tm2}'", f"DELETE FROM org_members WHERE org_id = '{ORG2}' AND user_id = '{OWNER}'")
        assert (await _row(offer_id))["commit"] is None and (await _row(offer_id))["burned"] is False
        # someone else's key
        plain_tm = await _plain_member()
        pk, _ = await _register(c, who=PLAIN, label="plain phone") if plain_tm else (None, None)
        r = await c.post(url, json=_commit_body(device, pk), headers=_person(OWNER))
        assert (r.status_code, r.json()["error"]["code"]) == (404, "phone_key_not_found")
        # a device token is not a person's session · a person is not a device
        assert (await c.post(url, json=_commit_body(device, phone_id), headers=_tok(device["device_token"]))).status_code in (401, 403)
        assert (await c.post(f"{REL}/pairing-sessions", json={"offer_id": str(uuid.uuid4()), "expires_at": _exp()}, headers=_person(OWNER))).status_code == 401
        assert (await c.post(f"{REL}/pairing-sessions/{offer_id}/nonce", json={"n_m": NM, "sig": SIG}, headers=_person(OWNER))).status_code == 401
        assert (await _row(offer_id))["burned"] is False and (await _row(offer_id))["commit"] is None
        # malformed bytes are refused by shape (nothing stored)
        for bad in ({"commit": "short"}, {"commit": COMMIT + "A"}, {"commit": "!" * 43}):
            assert (await c.post(url, json=_commit_body(device, phone_id) | bad, headers=_person(OWNER))).status_code == 422
        assert (await _row(offer_id))["commit"] is None


async def test_05_the_reveal_only_by_the_phone_that_committed_once_and_for_its_own_registered_key(world):
    async with _client() as c:
        device, phone_id, spki = await _ready(c)
        plain_tm = await _plain_member()
        offer_id, _r = await _register_offer(c, device)
        url = f"{PHONE}/pairing-sessions/{offer_id}"
        assert (await c.post(f"{url}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).status_code == 202
        assert (await c.post(f"{REL}/pairing-sessions/{offer_id}/nonce", json={"n_m": NM, "sig": SIG}, headers=_tok(device["device_token"]))).status_code == 200
        # someone else of the org: the same «not found»; their state read too
        if plain_tm:
            assert (await c.post(f"{url}/reveal", json=_reveal_body(device, spki), headers=_person(PLAIN))).json()["error"]["code"] == "offer_not_found"
            assert (await c.get(f"{url}?setup_id={device['setup_id']}", headers=_person(PLAIN))).json()["error"]["code"] == "offer_not_found"
        # a key that is not the one the commitment named: ends the offer (and the burn stays)
        other_spki = _b(91, b"k")
        assert len(other_spki) == 122
        r = await c.post(f"{url}/reveal", json=_reveal_body(device, other_spki), headers=_person(OWNER))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "offer_burned")
        assert (await _row(offer_id))["reason"] == "key_mismatch"
        # a second, different reveal ends an offer too
        o2, _ = await _register_offer(c, device)
        u2 = f"{PHONE}/pairing-sessions/{o2}"
        assert (await c.post(f"{u2}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).status_code == 202
        assert (await c.post(f"{REL}/pairing-sessions/{o2}/nonce", json={"n_m": NM, "sig": SIG}, headers=_tok(device["device_token"]))).status_code == 200
        assert (await c.post(f"{u2}/reveal", json=_reveal_body(device, spki), headers=_person(OWNER))).status_code == 202
        r = await c.post(f"{u2}/reveal", json=_reveal_body(device, spki, label="another name"), headers=_person(OWNER))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "offer_burned")
        assert (await _row(o2))["reason"] == "second_reveal"
        assert await _frames(c, device, "pairing_reveal") == []  # a burned offer is told to nobody
        # shapes
        for bad in ({"phone_spki": "short"}, {"phone_box_pub": "short"}, {"n_p": "short"}, {"label": ""}, {"label": "x" * 65}, {"binding_sig": "!"}):
            assert (await c.post(f"{u2}/reveal", json=_reveal_body(device, spki) | bad, headers=_person(OWNER))).status_code == 422


async def test_06_the_window_a_new_qr_replaces_the_one_before_and_the_old_six_digit_offer_is_refused_for_a_computer_on_the_new_procedure(world):
    async with _client() as c:
        device, phone_id, spki = await _ready(c)
        # the window: past or beyond the QR's 5 minutes is refused
        for minutes in (-1, 6):
            _o, r = await _register_offer(c, device, minutes=minutes)
            assert (r.status_code, r.json()["error"]["code"]) == (422, "invalid_expiry")
        # before any registration the old procedure still works for this computer
        old = _offer(device, phone_id, spki)
        assert (await c.post(f"{PHONE}/pairing-offers", json=old, headers=_person(OWNER))).status_code == 202
        # one registration is the mark: from now on the old offer is refused (no downgrade), whatever its window
        first, r = await _register_offer(c, device)
        assert r.status_code == 201
        refused = await c.post(f"{PHONE}/pairing-offers", json=_offer(device, phone_id, spki), headers=_person(OWNER))
        assert (refused.status_code, refused.json()["error"]["code"]) == (409, "pairing_protocol_mismatch")
        # a new QR ends the one before it; two registrations of the same id with different windows are refused
        second, r = await _register_offer(c, device)
        assert r.status_code == 201
        assert (await _row(first))["reason"] == "superseded" and (await _row(second))["burned"] is False
        r = await c.post(f"{PHONE}/pairing-sessions/{first}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "offer_burned")
        clash = await c.post(f"{REL}/pairing-sessions", json={"offer_id": second, "expires_at": _exp(1)}, headers=_tok(device["device_token"]))
        assert (clash.status_code, clash.json()["error"]["code"]) == (409, "offer_used")
        # another computer is not marked: its old offer still goes (the mark is per computer)
        other = await _device(c, name="d4424 mac 4972q")
        await _with_session(c, other)
        assert (await c.post(f"{PHONE}/pairing-offers", json=_offer(other, phone_id, spki), headers=_person(OWNER))).status_code == 202
        # an offer past its window: gone
        await _sql(f"UPDATE remote_device_pairing_sessions SET expires_at = now() - interval '1 second' WHERE offer_id = '{second}'")
        r = await c.post(f"{PHONE}/pairing-sessions/{second}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))
        assert (r.status_code, r.json()["error"]["code"]) == (410, "offer_expired")


async def test_07_either_side_can_end_the_offer_and_remote_control_off_refuses(world):
    async with _client() as c:
        device, phone_id, _spki = await _ready(c)
        o1, _ = await _register_offer(c, device)
        assert (await c.post(f"{PHONE}/pairing-sessions/{o1}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).status_code == 202
        r = await c.post(f"{PHONE}/pairing-sessions/{o1}/close", json={"setup_id": device["setup_id"]}, headers=_person(OWNER))
        assert (r.status_code, r.json()) == (200, {"state": "burned"})
        assert (await _row(o1))["reason"] == "phone_declined"
        assert (await c.post(f"{PHONE}/pairing-sessions/{o1}/close", json={"setup_id": device["setup_id"]}, headers=_person(OWNER))).status_code == 200  # idempotent
        o2, _ = await _register_offer(c, device)
        r = await c.post(f"{REL}/pairing-sessions/{o2}/close", headers=_tok(device["device_token"]))
        assert (r.status_code, r.json()) == (200, {"state": "burned"})
        assert (await _row(o2))["reason"] == "host_closed"
        assert (await c.post(f"{REL}/pairing-sessions/{uuid.uuid4()}/close", headers=_tok(device["device_token"]))).status_code == 404
        # remote control off: neither a registration nor a commitment goes
        o3, _ = await _register_offer(c, device)
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = NULL WHERE id = '{ORG}'")
        _o, r = await _register_offer(c, device)
        assert (r.status_code, r.json()["error"]["code"]) == (409, "remote_control_off")
        r = await c.post(f"{PHONE}/pairing-sessions/{o3}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "remote_control_off")


async def test_08_an_old_style_offer_made_before_the_registration_is_not_carried_on_and_registrations_do_not_both_stay_live(world):
    import asyncio

    async with _client() as c:
        device, phone_id, spki = await _ready(c)
        old = _offer(device, phone_id, spki)
        assert (await c.post(f"{PHONE}/pairing-offers", json=old, headers=_person(OWNER))).status_code == 202
        assert [f["offer_id"] for f in await _frames(c, device, "pairing_offer")] == [old["offer_id"]]  # before the registration: sent as always
        _o, r = await _register_offer(c, device)
        assert r.status_code == 201
        # after it: the old offer is sent no more, and its reveal is refused (409) — the computer is on the new procedure for good
        assert await _frames(c, device, "pairing_offer") == []
        up = f"{REL}/pairing-offers/{old['offer_id']}/reveal"
        refused = await c.post(up, json={"reveal": _b(32, b"r")}, headers=_tok(device["device_token"]))
        assert (refused.status_code, refused.json()["error"]["code"]) == (409, "pairing_protocol_mismatch")
        # two registrations at the same moment with different ids: one stays live, the other is superseded
        a, b = str(uuid.uuid4()), str(uuid.uuid4())
        ra, rb = await asyncio.gather(
            c.post(f"{REL}/pairing-sessions", json={"offer_id": a, "expires_at": _exp()}, headers=_tok(device["device_token"])),
            c.post(f"{REL}/pairing-sessions", json={"offer_id": b, "expires_at": _exp()}, headers=_tok(device["device_token"])),
        )
        assert (ra.status_code, rb.status_code) == (201, 201)
        live = (await _sql(fetch=f"SELECT count(*) FROM remote_device_pairing_sessions WHERE setup_id = '{device['setup_id']}' AND burned_at IS NULL AND expires_at > now()"))[0][0]
        assert live == 1


async def test_09_phone_calls_and_registrations_at_the_same_moment_do_not_deadlock_or_fail(world):
    import asyncio

    async with _client() as c:
        device, phone_id, spki = await _ready(c)
        offer_id, _ = await _register_offer(c, device)
        url = f"{PHONE}/pairing-sessions/{offer_id}"
        assert (await c.post(f"{url}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).status_code == 202
        state = f"{url}?setup_id={device['setup_id']}"
        calls = []
        for _i in range(5):
            calls.append(c.get(state, headers=_person(OWNER)))
            calls.append(c.post(f"{url}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER)))           # the same retry
            calls.append(c.post(f"{url}/reveal", json=_reveal_body(device, spki), headers=_person(OWNER)))              # before the nonce: 409
            calls.append(c.post(f"{REL}/pairing-sessions/{offer_id}/nonce", json={"n_m": NM, "sig": SIG}, headers=_tok(device["device_token"])))
            calls.append(c.post(f"{url}/close", json={"setup_id": device["setup_id"]}, headers=_person(OWNER)))
            calls.append(c.post(f"{REL}/pairing-sessions/{offer_id}/close", headers=_tok(device["device_token"])))
            calls.append(c.post(f"{REL}/pairing-sessions", json={"offer_id": str(uuid.uuid4()), "expires_at": _exp()}, headers=_tok(device["device_token"])))
        done = await asyncio.wait_for(asyncio.gather(*calls), timeout=90)  # a deadlock would show as a timeout (or a 500 from the database's own deadlock break)
        assert all(r.status_code in (200, 201, 202, 404, 409, 410, 422) for r in done), [(r.status_code, r.text[:80]) for r in done if r.status_code not in (200, 201, 202, 404, 409, 410, 422)]


async def test_10_the_cutover_is_decided_under_the_computers_row_lock(world):
    """the old six-digit offer (or its reveal) waits for a registration that is being made, then is refused — deterministic: the registration is held open in another connection"""
    import asyncio

    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.services import pairing_sessions

    async with _client() as c:
        device, phone_id, spki = await _ready(c)
        old = _offer(device, phone_id, spki)
        assert (await c.post(f"{PHONE}/pairing-offers", json=old, headers=_person(OWNER))).status_code == 202
        for what in ("reveal", "offer"):
            async with async_session_factory() as s1:
                setup = await s1.get(DesktopSetup, uuid.UUID(device["setup_id"]))
                body = pairing_sessions.SessionRegister(offer_id=uuid.uuid4(), expires_at=datetime.now(timezone.utc) + timedelta(minutes=5))
                await pairing_sessions.register(s1, setup, body)  # the registration is open — holding the computer's row
                if what == "reveal":
                    task = asyncio.create_task(c.post(f"{REL}/pairing-offers/{old['offer_id']}/reveal", json={"reveal": _b(32, b"r")}, headers=_tok(device["device_token"])))
                else:
                    task = asyncio.create_task(c.post(f"{PHONE}/pairing-offers", json=_offer(device, phone_id, spki), headers=_person(OWNER)))
                done, _pending = await asyncio.wait({task}, timeout=1.0)
                assert not done, f"the old {what} did not wait for the registration (the lock is gone)"
                await s1.commit()
            r = await asyncio.wait_for(task, timeout=15)
            assert (r.status_code, r.json()["error"]["code"]) == (409, "pairing_protocol_mismatch"), (what, r.text)
            await _sql(f"UPDATE desktop_setups SET pairing_v2_at = NULL WHERE id = '{device['setup_id']}'", f"DELETE FROM remote_device_pairing_sessions WHERE setup_id = '{device['setup_id']}'")


async def test_11_the_new_procedure_mark_outlives_the_session_rows(world):
    async with _client() as c:
        device, phone_id, spki = await _ready(c)
        _o, r = await _register_offer(c, device)
        assert r.status_code == 201
        assert (await _sql(fetch=f"SELECT pairing_v2_at IS NOT NULL FROM desktop_setups WHERE id = '{device['setup_id']}'"))[0][0] is True
        # the rows go (a cleanup · a cascade from a deleted phone key): the mark stays, the old offer is still refused
        await _sql(f"DELETE FROM remote_device_pairing_sessions WHERE setup_id = '{device['setup_id']}'")
        refused = await c.post(f"{PHONE}/pairing-offers", json=_offer(device, phone_id, spki), headers=_person(OWNER))
        assert (refused.status_code, refused.json()["error"]["code"]) == (409, "pairing_protocol_mismatch")
        # and it is never turned off by a later registration
        _o2, r2 = await _register_offer(c, device)
        assert r2.status_code == 201
        assert (await _sql(fetch=f"SELECT count(*) FROM desktop_setups WHERE id = '{device['setup_id']}' AND pairing_v2_at IS NOT NULL"))[0][0] == 1


async def test_12_an_ended_offer_is_told_to_the_computer_once_and_a_registration_again_learns_it_ended(world):
    async with _client() as c:
        device, phone_id, spki = await _ready(c)
        plain_tm = await _plain_member()
        # a second commitment (a hand that peeked at the QR commits first, the real phone second — or the other way round): the offer ends and the computer is told
        o1, _ = await _register_offer(c, device)
        assert (await c.post(f"{PHONE}/pairing-sessions/{o1}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).status_code == 202
        assert (await c.post(f"{PHONE}/pairing-sessions/{o1}/commit", json=_commit_body(device, phone_id, commit=_b(32, b"d")), headers=_person(OWNER))).status_code == 409
        assert await _frames_until(c, device, "pairing_burned") == [{"offer_id": o1, "reason": "second_commit"}]
        assert await _frames(c, device, "pairing_commit") == [] and await _frames(c, device, "pairing_reveal") == []  # nothing else of a dead offer
        # the registration again: the real state, not «registered»
        again = await c.post(f"{REL}/pairing-sessions", json={"offer_id": o1, "expires_at": _exp()}, headers=_tok(device["device_token"]))
        assert (again.status_code, again.json()["error"]["code"]) == (409, "offer_burned")
        # the phone's [달라요] · a second reveal · a key that is not the committed one
        o2, _ = await _register_offer(c, device)
        u2 = f"{PHONE}/pairing-sessions/{o2}"
        assert (await c.post(f"{u2}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).status_code == 202
        assert (await c.post(f"{u2}/close", json={"setup_id": device["setup_id"]}, headers=_person(OWNER))).status_code == 200
        assert await _burned_until(c, device, o2) == [{"offer_id": o2, "reason": "phone_declined"}]
        for kind in ("second_reveal", "key_mismatch"):
            o, _ = await _register_offer(c, device)
            u = f"{PHONE}/pairing-sessions/{o}"
            assert (await c.post(f"{u}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).status_code == 202
            assert (await c.post(f"{REL}/pairing-sessions/{o}/nonce", json={"n_m": NM, "sig": SIG}, headers=_tok(device["device_token"]))).status_code == 200
            if kind == "second_reveal":
                assert (await c.post(f"{u}/reveal", json=_reveal_body(device, spki), headers=_person(OWNER))).status_code == 202
                assert (await c.post(f"{u}/reveal", json=_reveal_body(device, spki, label="other"), headers=_person(OWNER))).status_code == 409
            else:
                assert (await c.post(f"{u}/reveal", json=_reveal_body(device, _b(91, b"k")), headers=_person(OWNER))).status_code == 409
            assert await _burned_until(c, device, o) == [{"offer_id": o, "reason": kind}]
        # the computer's own closing and its own newer QR are its own acts: not told back
        o3, _ = await _register_offer(c, device)
        assert (await c.post(f"{REL}/pairing-sessions/{o3}/close", headers=_tok(device["device_token"]))).status_code == 200
        assert await _burned_of(c, device, o3) == []
        # a window that has passed: nothing is told
        await _sql(f"UPDATE remote_device_pairing_sessions SET expires_at = now() - interval '1 second' WHERE offer_id = '{o1}'")
        assert await _burned_of(c, device, o1) == []
        assert plain_tm is not None


async def test_13_a_name_the_host_would_refuse_is_not_carried(world):
    async with _client() as c:
        device, phone_id, spki = await _ready(c)
        offer_id, _ = await _register_offer(c, device)
        url = f"{PHONE}/pairing-sessions/{offer_id}"
        assert (await c.post(f"{url}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).status_code == 202
        assert (await c.post(f"{REL}/pairing-sessions/{offer_id}/nonce", json={"n_m": NM, "sig": SIG}, headers=_tok(device["device_token"]))).status_code == 200
        # 33 emoji = 33 code points (the server's old limit passes) but 66 UTF-16 code units (the host's count): refused here, before the host would kill the offer
        r = await c.post(f"{url}/reveal", json=_reveal_body(device, spki, label="😀" * 33), headers=_person(OWNER))
        assert r.status_code == 422
        assert (await c.post(f"{url}/reveal", json=_reveal_body(device, spki, label="😀" * 32), headers=_person(OWNER))).status_code == 202  # 32 = 64 units: the limit itself goes


async def test_14_a_burn_wakes_the_computer_at_once(world, monkeypatch):
    from app.services import pairing_sessions

    woken = []
    real = pairing_sessions._wake_device_after_commit
    monkeypatch.setattr(pairing_sessions, "_wake_device_after_commit", lambda db, setup_id: (woken.append(str(setup_id)), real(db, setup_id))[1])
    async with _client() as c:
        device, phone_id, spki = await _ready(c)
        o1, _ = await _register_offer(c, device)
        assert (await c.post(f"{PHONE}/pairing-sessions/{o1}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).status_code == 202
        woken.clear()  # (the commitment itself wakes it too)
        assert (await c.post(f"{PHONE}/pairing-sessions/{o1}/commit", json=_commit_body(device, phone_id, commit=_b(32, b"d")), headers=_person(OWNER))).status_code == 409
        assert woken == [device["setup_id"]], "a burn by a second commitment wakes the computer"
        o2, _ = await _register_offer(c, device)
        assert (await c.post(f"{PHONE}/pairing-sessions/{o2}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).status_code == 202
        woken.clear()
        assert (await c.post(f"{PHONE}/pairing-sessions/{o2}/close", json={"setup_id": device["setup_id"]}, headers=_person(OWNER))).status_code == 200
        assert woken == [device["setup_id"]], "the phone's [달라요] wakes the computer"


# ── story 4972 · wiring 4a: the computer's signed receipt «I confirmed THIS offer» (the server carries it, the phone checks it) ────────────────────────────────────────────────────────────────────

RECEIPT = _b(71, b"r")  # a DER ECDSA P-256 signature is 70-72 bytes: 95 chars


async def _to_reveal(c, device, phone_id, spki):
    offer_id, _ = await _register_offer(c, device)
    url = f"{PHONE}/pairing-sessions/{offer_id}"
    assert (await c.post(f"{url}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).status_code == 202
    assert (await c.post(f"{REL}/pairing-sessions/{offer_id}/nonce", json={"n_m": NM, "sig": SIG}, headers=_tok(device["device_token"]))).status_code == 200
    assert (await c.post(f"{url}/reveal", json=_reveal_body(device, spki), headers=_person(OWNER))).status_code == 202
    return offer_id, url, f"{url}?setup_id={device['setup_id']}"


async def _receipt_row(offer_id) -> tuple:
    r = (await _sql(fetch=f"SELECT confirmed_sig, confirmed_at IS NOT NULL, burned_at IS NOT NULL FROM remote_device_pairing_sessions WHERE offer_id = '{offer_id}'"))[0]
    return (r[0], r[1], r[2])


async def test_15_the_receipt_is_written_once_by_the_offers_own_computer_and_read_by_the_phone(world):
    async with _client() as c:
        device, phone_id, spki = await _ready(c)
        offer_id, url, state = await _to_reveal(c, device, phone_id, spki)
        up = f"{REL}/pairing-sessions/{offer_id}/confirmed"
        assert (await c.get(state, headers=_person(OWNER))).json()["confirmed_sig"] is None  # nothing yet
        r = await c.post(up, json={"sig": RECEIPT}, headers=_tok(device["device_token"]))
        assert (r.status_code, r.json()) == (200, {"state": "confirmed"})
        assert await _receipt_row(offer_id) == (RECEIPT, True, False)  # the receipt does not end the offer
        assert (await c.post(up, json={"sig": RECEIPT}, headers=_tok(device["device_token"]))).status_code == 200  # the same again (a retry): fine
        other = await c.post(up, json={"sig": _b(71, b"q")}, headers=_tok(device["device_token"]))
        assert (other.status_code, other.json()["error"]["code"]) == (409, "already_confirmed")
        assert await _receipt_row(offer_id) == (RECEIPT, True, False), "another value never overwrites the first"
        body = (await c.get(state, headers=_person(OWNER))).json()
        assert body["confirmed_sig"] == RECEIPT and body["state"] == "revealed" and body["sig"] == SIG
        # the phone may read it a moment AFTER the window ran out (its own end is a little after the QR's)
        await _sql(f"UPDATE remote_device_pairing_sessions SET expires_at = now() - interval '1 second' WHERE offer_id = '{offer_id}'")
        late = (await c.get(state, headers=_person(OWNER))).json()
        assert late == {"state": "expired", "n_m": None, "sig": None, "confirmed_sig": RECEIPT}


async def test_16_the_receipt_is_refused_before_a_reveal_on_a_dead_offer_and_from_another_computer(world):
    async with _client() as c:
        device, phone_id, spki = await _ready(c)
        mine = _tok(device["device_token"])
        # before the phone revealed
        o1, _ = await _register_offer(c, device)
        up1 = f"{REL}/pairing-sessions/{o1}/confirmed"
        r = await c.post(up1, json={"sig": RECEIPT}, headers=mine)
        assert (r.status_code, r.json()["error"]["code"]) == (409, "no_reveal")
        assert (await _receipt_row(o1))[0] is None
        # an offer that was ended
        o2, url2, _state2 = await _to_reveal(c, device, phone_id, spki)
        assert (await c.post(f"{url2}/close", json={"setup_id": device["setup_id"]}, headers=_person(OWNER))).status_code == 200
        r = await c.post(f"{REL}/pairing-sessions/{o2}/confirmed", json={"sig": RECEIPT}, headers=mine)
        assert (r.status_code, r.json()["error"]["code"]) == (409, "offer_burned")
        assert (await _receipt_row(o2))[0] is None
        # an offer whose window passed more than the grace (the phone's own provisional-pin window: the offer's end + 15 s)
        o3, _url3, state3 = await _to_reveal(c, device, phone_id, spki)
        await _sql(f"UPDATE remote_device_pairing_sessions SET expires_at = now() - interval '16 seconds' WHERE offer_id = '{o3}'")
        r = await c.post(f"{REL}/pairing-sessions/{o3}/confirmed", json={"sig": RECEIPT}, headers=mine)
        assert (r.status_code, r.json()["error"]["code"]) == (410, "offer_expired")
        assert (await _receipt_row(o3))[0] is None
        # …but a person who pressed [같아요] just before the end, whose computer needed a moment, still gets the receipt through (inside the grace)
        o3b, _url3b, _state3b = await _to_reveal(c, device, phone_id, spki)
        await _sql(f"UPDATE remote_device_pairing_sessions SET expires_at = now() - interval '10 seconds' WHERE offer_id = '{o3b}'")
        assert (await c.post(f"{REL}/pairing-sessions/{o3b}/confirmed", json={"sig": RECEIPT}, headers=mine)).status_code == 200
        assert (await _receipt_row(o3b))[0] == RECEIPT
        # ANOTHER computer's device token can neither write the receipt of this offer nor block the real one (the one write is the real computer's)
        o4, _url4, state4 = await _to_reveal(c, device, phone_id, spki)
        other = await _device(c, name="d4424 mac 4972q")
        r = await c.post(f"{REL}/pairing-sessions/{o4}/confirmed", json={"sig": _b(71, b"z")}, headers=_tok(other["device_token"]))
        assert (r.status_code, r.json()["error"]["code"]) == (404, "offer_not_found")
        assert (await _receipt_row(o4))[0] is None
        assert (await c.post(f"{REL}/pairing-sessions/{o4}/confirmed", json={"sig": RECEIPT}, headers=mine)).status_code == 200
        assert (await _receipt_row(o4))[0] == RECEIPT
        # a person's token (not a device's) is refused · the body is exactly one field of the right shape
        assert (await c.post(f"{REL}/pairing-sessions/{o4}/confirmed", json={"sig": RECEIPT}, headers=_person(OWNER))).status_code == 401
        o5, _u5, _s5 = await _to_reveal(c, device, phone_id, spki)
        for bad in ({"sig": "short"}, {"sig": "!" * 40}, {"sig": _b(80, b"x") + "xxxxxxxxxxxxxxxxxxxxxxxxxx"}, {"sig": RECEIPT, "extra": 1}, {}):
            assert (await c.post(f"{REL}/pairing-sessions/{o5}/confirmed", json=bad, headers=mine)).status_code == 422, bad
        assert (await _receipt_row(o5))[0] is None


async def test_17_the_database_says_the_same_a_receipt_only_whole_after_a_reveal_and_of_one_size(world):
    async with _client() as c:
        device, phone_id, spki = await _ready(c)
        o1, _ = await _register_offer(c, device)
        o2, _u2, _s2 = await _to_reveal(c, device, phone_id, spki)
        for bad in (
            f"UPDATE remote_device_pairing_sessions SET confirmed_sig = '{RECEIPT}', confirmed_at = now() WHERE offer_id = '{o1}'",  # no reveal yet
            f"UPDATE remote_device_pairing_sessions SET confirmed_sig = '{RECEIPT}' WHERE offer_id = '{o2}'",  # half
            f"UPDATE remote_device_pairing_sessions SET confirmed_at = now() WHERE offer_id = '{o2}'",  # the other half
            f"UPDATE remote_device_pairing_sessions SET confirmed_sig = 'short', confirmed_at = now() WHERE offer_id = '{o2}'",  # too small
            f"UPDATE remote_device_pairing_sessions SET confirmed_sig = '{'x' * 101}', confirmed_at = now() WHERE offer_id = '{o2}'",  # too large
        ):
            with pytest.raises(Exception):
                await _sql(bad)
        await _sql(f"UPDATE remote_device_pairing_sessions SET confirmed_sig = '{RECEIPT}', confirmed_at = now() WHERE offer_id = '{o2}'")  # the whole one goes


async def test_18_an_offer_the_computer_has_receipted_is_a_finished_pairing_only_the_phones_own_decline_ends_it(world):
    async with _client() as c:
        device, phone_id, spki = await _ready(c)
        offer_id, url, state = await _to_reveal(c, device, phone_id, spki)
        up = f"{REL}/pairing-sessions/{offer_id}/confirmed"
        assert (await c.post(up, json={"sig": RECEIPT}, headers=_tok(device["device_token"]))).status_code == 200
        # a NEW QR of the same computer does not end it (the computer already holds the phone: the receipt must stay readable)
        o2, r2 = await _register_offer(c, device)
        assert r2.status_code == 201
        assert (await _receipt_row(offer_id)) == (RECEIPT, True, False), "the new QR did not burn the receipted offer"
        assert (await c.get(state, headers=_person(OWNER))).json()["confirmed_sig"] == RECEIPT
        # …while an offer WITHOUT a receipt is still ended by it (the old rule)
        o3, _ = await _register_offer(c, device)
        assert (await _receipt_row(o2))[2] is True
        # a second commitment · a second reveal (anyone who knows the offer id) are refused and burn nothing
        r = await c.post(f"{url}/commit", json=_commit_body(device, phone_id, commit=_b(32, b"d")), headers=_person(OWNER))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "already_confirmed")
        r = await c.post(f"{url}/reveal", json=_reveal_body(device, spki, label="Another"), headers=_person(OWNER))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "already_confirmed")
        assert await _receipt_row(offer_id) == (RECEIPT, True, False), "neither burned it"
        # the computer closing its own window afterwards does not hide the receipt either
        assert (await c.post(f"{REL}/pairing-sessions/{offer_id}/close", headers=_tok(device["device_token"]))).status_code == 200
        assert await _receipt_row(offer_id) == (RECEIPT, True, False)
        # a retry of the SAME bytes after the window is still 200 (a host that lost the answer must not read it as a failure); other bytes are 409 — never 410
        await _sql(f"UPDATE remote_device_pairing_sessions SET expires_at = now() - interval '20 minutes' WHERE offer_id = '{offer_id}'")
        assert (await c.post(up, json={"sig": RECEIPT}, headers=_tok(device["device_token"]))).status_code == 200
        other = await c.post(up, json={"sig": _b(71, b"q")}, headers=_tok(device["device_token"]))
        assert (other.status_code, other.json()["error"]["code"]) == (409, "already_confirmed")
        del o3


async def test_19_the_phones_own_decline_ends_a_receipted_offer_and_a_dead_offer_shows_no_receipt(world):
    async with _client() as c:
        device, phone_id, spki = await _ready(c)
        offer_id, url, state = await _to_reveal(c, device, phone_id, spki)
        up = f"{REL}/pairing-sessions/{offer_id}/confirmed"
        assert (await c.post(up, json={"sig": RECEIPT}, headers=_tok(device["device_token"]))).status_code == 200
        assert (await c.post(f"{url}/close", json={"setup_id": device["setup_id"]}, headers=_person(OWNER))).status_code == 200  # the person on the phone said no
        assert (await _receipt_row(offer_id))[2] is True
        body = (await c.get(state, headers=_person(OWNER))).json()
        assert body == {"state": "burned", "n_m": None, "sig": None, "confirmed_sig": None}, "a dead offer shows no receipt (nothing is carried on it)"
        assert (await c.post(up, json={"sig": RECEIPT}, headers=_tok(device["device_token"]))).status_code == 200  # the same bytes again: stored already


async def test_20_a_stream_that_ends_before_its_first_pass_says_nothing_and_the_frame_is_still_there_for_the_next_read(world, monkeypatch):
    """The failure the CI showed once for test_12 (a burned offer read as `[]`), made certain: a connection whose lifespan is already over when its first pass comes ends with
    `lifespan_reconnect` and NO frame — the frame was not marked as told, so a read that goes on finds it. (`_frames_until` is what a positive expectation uses.)"""
    from app.routers import desktop_relay as router_mod

    async with _client() as c:
        device, phone_id, _spki = await _ready(c)
        o1, _ = await _register_offer(c, device)
        assert (await c.post(f"{PHONE}/pairing-sessions/{o1}/commit", json=_commit_body(device, phone_id), headers=_person(OWNER))).status_code == 202
        assert (await c.post(f"{PHONE}/pairing-sessions/{o1}/commit", json=_commit_body(device, phone_id, commit=_b(32, b"d")), headers=_person(OWNER))).status_code == 409
        with monkeypatch.context() as m:
            m.setattr(router_mod, "_LIFESPAN_SEC", -5.0)  # every connection is over before its first pass: the window «missed»
            assert await _frames(c, device, "pairing_burned") == [], "the slow connection said nothing"
            assert await _frames_until(c, device, "pairing_burned", within=0.3) == [], "and a retry that has no time says nothing either"
        # the same frame, not lost: a connection with its window reads it
        assert await _frames_until(c, device, "pairing_burned") == [{"offer_id": o1, "reason": "second_commit"}]


async def test_21_frames_until_reads_again_until_the_snapshot_has_enough_frames_and_gives_up_after_its_time(monkeypatch):
    calls = []
    answers = [[], [], [{"a": 1}, {"a": 2}]]

    async def fake(c, device, name):
        calls.append(name)
        return answers.pop(0) if answers else []

    monkeypatch.setattr(sys.modules[__name__], "_frames", fake)
    assert await _frames_until(None, None, "pairing_burned", count=2, within=5.0) == [{"a": 1}, {"a": 2}] and len(calls) == 3, "it read again until a snapshot had two frames"
    calls.clear()
    answers[:] = [[{"a": 9}]] * 100
    t0 = time.monotonic()
    assert await _frames_until(None, None, "pairing_burned", count=2, within=0.2) == [{"a": 9}], "with too few coming it stops after its time and returns what was told"
    assert 0.2 <= time.monotonic() - t0 < 2.0 and len(calls) >= 2
