"""story 5027 (security lens 5025 · F1) — a phone proves it holds the private key of the key it registers.

Before: `register_phone` took a public key and a label and nothing else. The public key of a person's phone is not a secret (the owner of a computer sees it in its pins), so a member of the organization could register ANOTHER person's key in their own name FIRST:
the server then held «that key = them» and the real owner's registration was refused (409 remote_device_taken). The new «this phone = this person» proofs of story 5025 stand on that table.

Now: the server hands the logged-in person a one-time value (`POST /remote-devices/challenge`); the phone signs `{v, kind, member_id, org_id, fingerprint, nonce}` with the key it is registering (`pop`); the server checks it with the key it was handed.
An older app sends no proof and is accepted as before — the key is then NOT proved (`pop_verified: false`). A key that is not proved can be taken by whoever proves it; a proved key stays with the one who proved it.

Real database. Each test goes red without the line it names.
"""
from __future__ import annotations

import base64
import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from app.core.config import settings
from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    PLAIN,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)

pytestmark = pytest.mark.anyio

PHONES = "/api/v2/remote-devices"
CHALLENGE = f"{PHONES}/challenge"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


class Phone:
    """a phone: a P-256 key (the private half never leaves this object), its public key as the app sends it, and its fingerprint"""

    def __init__(self) -> None:
        self.priv = ec.generate_private_key(ec.SECP256R1())
        self.der = self.priv.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
        self.pub = _b64(self.der)
        self.fp = "sha256:" + hashlib.sha256(self.der).hexdigest()

    def sign(self, payload: bytes) -> str:
        return _b64(self.priv.sign(payload, ec.ECDSA(hashes.SHA256())))  # DER — as the phone signs every command

    def proof(self, ch: dict, **over) -> dict:
        body = {"v": 1, "kind": "register_phone", "member_id": ch["member_id"], "org_id": ch["org_id"], "fingerprint": self.fp, "nonce": ch["nonce"], **over}
        raw = json.dumps(body, separators=(",", ":")).encode()
        return {"payload": _b64(raw), "sig": self.sign(raw)}


async def _challenge(c, who=OWNER) -> dict:
    r = await c.post(CHALLENGE, headers=_person(who))
    assert r.status_code == 200, r.text
    return r.json()


async def _register(c, phone: Phone, who=OWNER, label="iPhone", proof: bool | dict = True, expect=(200, 201)):
    pop = None
    if proof is True:
        pop = phone.proof(await _challenge(c, who))
    elif isinstance(proof, dict):
        pop = proof
    body = {"label": label, "public_key": phone.pub, **({"pop": pop} if pop is not None else {})}
    r = await c.post(PHONES, json=body, headers=_person(who))
    assert r.status_code in expect, r.text
    return r


async def _plain_member() -> uuid.UUID:
    """the fixture's PLAIN person has an org_members row only — give them their members row (same id, as 0075)"""
    tm = (await _sql(fetch=f"SELECT id FROM org_members WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'"))[0][0]
    await _sql(f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{tm}','{ORG}','{PLAIN}','human','Plain',true)")
    return tm


@pytest.fixture(autouse=True)
async def _jwt_secret(monkeypatch):
    monkeypatch.setattr(settings, "jwt_secret", "t5027-" + "s" * 40)
    yield


@pytest.fixture(autouse=True)
async def _remote_control_on(world):
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'")
    yield


@pytest.fixture(autouse=True)
async def _clean_phones(world):
    await _sql("DELETE FROM remote_devices")
    yield
    await _sql("DELETE FROM remote_devices")


async def _row(fp: str):
    rows = await _sql(fetch=f"SELECT member_id, org_id, label, revoked_at, pop_verified_at FROM remote_devices WHERE fingerprint = '{fp}'")
    return rows[0] if rows else None


async def _member_of(user) -> uuid.UUID:
    return (await _sql(fetch=f"SELECT id FROM members WHERE org_id = '{ORG}' AND user_id = '{user}'"))[0][0]


# ── AC1 — the squat, reproduced: the second person (the holder) used to be refused ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_a1_a_key_someone_registered_first_without_proving_it_is_taken_back_by_the_one_who_proves_it(world):
    await _plain_member()
    owner_phone = Phone()
    async with _client() as c:
        # the other person registers the owner's PUBLIC key in their own name first (an older app · no proof): accepted as before — and not proved
        squat = await _register(c, owner_phone, who=PLAIN, label="not theirs", proof=False, expect=(201,))
        assert squat.json()["pop_verified"] is False
        before = await _row(owner_phone.fp)
        assert before[0] == await _member_of(PLAIN) and before[4] is None
        # the real owner registers it WITH the proof: it is theirs now (200 — an existing row, taken back), no longer 409 remote_device_taken
        back = await _register(c, owner_phone, who=OWNER, label="my phone", expect=(200,))
        assert back.json()["pop_verified"] is True and back.json()["label"] == "my phone"
        after = await _row(owner_phone.fp)
        assert after[0] == await _member_of(OWNER) and after[2] == "my phone" and after[3] is None and after[4] is not None
        # the squatter's list no longer has it; the owner's does
        assert owner_phone.fp not in {d["fingerprint"] for d in (await c.get(PHONES, headers=_person(PLAIN))).json()["devices"]}
        assert owner_phone.fp in {d["fingerprint"] for d in (await c.get(PHONES, headers=_person(OWNER))).json()["devices"]}


async def test_a2_the_squatted_key_keeps_the_computers_pairings_and_they_now_belong_to_its_real_holder(world):
    """a pair is the COMPUTER's pin of that key: taking the key back must not unpair the computer the real owner paired by hand"""
    from tests.test_4529_desktop_relay_realdb import _device, _tok

    await _plain_member()
    owner_phone = Phone()
    async with _client() as c:
        device = await _device(c, name="d4424 mac 5027a")
        await _register(c, owner_phone, who=PLAIN, label="x", proof=False, expect=(201,))
        r = await c.put("/api/v2/desktop/relay/pairings", json={"pairings": [{"phone_key_fingerprint": owner_phone.fp, "paired_at": datetime.now(timezone.utc).isoformat()}]},
                        headers=_tok(device["device_token"]))
        assert r.status_code == 200, r.text
        pairs_before = await _sql(fetch=f"SELECT count(*) FROM remote_device_pairings p JOIN remote_devices d ON d.id = p.remote_device_id WHERE d.fingerprint = '{owner_phone.fp}' AND p.removed_at IS NULL")
        await _register(c, owner_phone, who=OWNER, expect=(200,))
        pairs_after = await _sql(fetch=f"SELECT count(*) FROM remote_device_pairings p JOIN remote_devices d ON d.id = p.remote_device_id WHERE d.fingerprint = '{owner_phone.fp}' AND p.removed_at IS NULL AND d.member_id = '{await _member_of(OWNER)}'")
        assert pairs_before[0][0] == 1 and pairs_after[0][0] == 1


async def test_a3_a_key_that_was_proved_stays_with_the_one_who_proved_it(world):
    await _plain_member()
    owner_phone = Phone()
    async with _client() as c:
        await _register(c, owner_phone, who=OWNER, expect=(201,))
        # the other person cannot take it: without the proof it is 409 as ever; with a proof they can only make with THEIR OWN key (the fingerprint inside differs) it is refused
        r = await c.post(PHONES, json={"label": "mine now", "public_key": owner_phone.pub}, headers=_person(PLAIN))
        assert r.status_code == 409 and r.json()["error"]["code"] == "remote_device_taken"
        thief = Phone()
        forged = thief.proof(await _challenge(c, PLAIN), fingerprint=owner_phone.fp)  # signed by the thief's key but naming the owner's fingerprint
        r2 = await c.post(PHONES, json={"label": "mine now", "public_key": owner_phone.pub, "pop": forged}, headers=_person(PLAIN))
        assert r2.status_code == 422 and r2.json()["error"]["code"] == "pop_invalid"
        row = await _row(owner_phone.fp)
        assert row[0] == await _member_of(OWNER) and row[4] is not None


async def test_a5_a_proved_key_stays_with_its_first_prover_even_when_another_account_proves_it_too(world):
    """two accounts that both hold the private key (one person, two logins): the key does NOT move — the first proof stands"""
    await _plain_member()
    phone = Phone()
    async with _client() as c:
        await _register(c, phone, who=OWNER, expect=(201,))
        r = await c.post(PHONES, json={"label": "other login", "public_key": phone.pub, "pop": phone.proof(await _challenge(c, PLAIN))}, headers=_person(PLAIN))
        assert r.status_code == 409 and r.json()["error"]["code"] == "remote_device_taken", r.text
        assert (await _row(phone.fp))[0] == await _member_of(OWNER)


async def test_a6_a_squatted_key_the_squatter_already_removed_is_taken_back_live_by_the_holder(world):
    await _plain_member()
    phone = Phone()
    async with _client() as c:
        squat = await _register(c, phone, who=PLAIN, proof=False, expect=(201,))
        assert (await c.delete(f"{PHONES}/{squat.json()['id']}", headers=_person(PLAIN))).status_code in (200, 204)
        assert (await _row(phone.fp))[3] is not None  # removed
        back = await _register(c, phone, who=OWNER, expect=(200,))  # an existing row, taken back — not a new one
        row = await _row(phone.fp)
        assert back.json()["pop_verified"] is True and row[0] == await _member_of(OWNER) and row[3] is None and row[4] is not None
        assert phone.fp in {d["fingerprint"] for d in (await c.get(PHONES, headers=_person(OWNER))).json()["devices"]}


async def test_a4_an_unproved_key_cannot_be_taken_without_a_proof_the_old_answer_stays(world):
    await _plain_member()
    phone = Phone()
    async with _client() as c:
        await _register(c, phone, who=PLAIN, proof=False, expect=(201,))
        r = await c.post(PHONES, json={"label": "x", "public_key": phone.pub}, headers=_person(OWNER))
        assert r.status_code == 409 and r.json()["error"]["code"] == "remote_device_taken"  # an older app of the other person gets what it always got
        assert (await _row(phone.fp))[0] == await _member_of(PLAIN)


# ── AC2 — an older app is accepted as before; a new app always proves ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_b1_an_older_app_registers_with_no_proof_and_the_key_says_it_is_not_proved(world):
    phone = Phone()
    async with _client() as c:
        first = await _register(c, phone, proof=False, expect=(201,))
        assert first.json()["pop_verified"] is False and (await _row(phone.fp))[4] is None
        again = await _register(c, phone, proof=False, expect=(200,))
        assert again.json()["id"] == first.json()["id"] and again.json()["pop_verified"] is False  # the same key again: the same row, still not proved
        listed = [d for d in (await c.get(PHONES, headers=_person(OWNER))).json()["devices"] if d["fingerprint"] == phone.fp]
        assert listed[0]["pop_verified"] is False


async def test_b2_the_same_person_proves_an_existing_key_later_and_it_becomes_proved_once(world):
    phone = Phone()
    async with _client() as c:
        await _register(c, phone, proof=False, expect=(201,))
        up = await _register(c, phone, expect=(200,))
        assert up.json()["pop_verified"] is True
        first_time = (await _row(phone.fp))[4]
        await _register(c, phone, expect=(200,))
        assert (await _row(phone.fp))[4] == first_time  # a key already proved keeps its first time


async def test_b3_a_new_key_with_a_proof_is_proved_from_the_start(world):
    phone = Phone()
    async with _client() as c:
        r = await _register(c, phone, expect=(201,))
        assert r.json()["pop_verified"] is True and (await _row(phone.fp))[4] is not None


async def test_b4_a_removed_key_comes_back_proved_when_its_person_proves_it(world):
    phone = Phone()
    async with _client() as c:
        first = await _register(c, phone, proof=False, expect=(201,))
        assert (await c.delete(f"{PHONES}/{first.json()['id']}", headers=_person(OWNER))).status_code in (200, 204)
        back = await _register(c, phone, expect=(201,))
        assert back.json()["id"] == first.json()["id"] and back.json()["pop_verified"] is True and (await _row(phone.fp))[3] is None


# ── a bad proof is refused before anything is read or written ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_c1_every_way_a_proof_can_be_wrong_is_422_and_nothing_is_stored(world):
    phone, other = Phone(), Phone()
    async with _client() as c:
        ch = await _challenge(c)
        good = phone.proof(ch)
        raw_good = base64.urlsafe_b64decode(good["payload"] + "=" * (-len(good["payload"]) % 4))
        cases = {
            "signed by another key": {"payload": good["payload"], "sig": other.sign(raw_good)},
            "signature of other bytes": {"payload": good["payload"], "sig": phone.sign(raw_good + b" ")},
            "tampered payload": {"payload": _b64(raw_good.replace(b"register_phone", b"register_phonX")), "sig": good["sig"]},
            "another person": phone.proof(ch, member_id=str(uuid.uuid4())),
            "another organization": phone.proof(ch, org_id=str(uuid.uuid4())),
            "another fingerprint": phone.proof(ch, fingerprint=other.fp),
            "another kind": phone.proof(ch, kind="send_prompt"),
            "another version": phone.proof(ch, v=2),
            "a value that is not ours": phone.proof(ch, nonce="1.abc.def"),
            "a value with a wrong mac": phone.proof(ch, nonce=ch["nonce"][:-2] + ("AA" if not ch["nonce"].endswith("AA") else "BB")),
            "a value for nothing": phone.proof(ch, nonce=""),
            "a value that is not text": phone.proof(ch, nonce=5),
            "not base64url": {"payload": "!!!", "sig": good["sig"]},
            "not json": {"payload": _b64(b"not json"), "sig": phone.sign(b"not json")},
            "a list": {"payload": _b64(b"[]"), "sig": phone.sign(b"[]")},
            "an extra field": {"payload": _b64(json.dumps({**json.loads(raw_good), "x": 1}).encode()), "sig": phone.sign(json.dumps({**json.loads(raw_good), "x": 1}).encode())},
            "a missing field": {"payload": _b64(json.dumps({k: v for k, v in json.loads(raw_good).items() if k != "nonce"}).encode()), "sig": good["sig"]},
        }
        for name, pop in cases.items():
            r = await c.post(PHONES, json={"label": "x", "public_key": phone.pub, "pop": pop}, headers=_person(OWNER))
            assert r.status_code == 422 and r.json()["error"]["code"] == "pop_invalid", f"{name}: {r.status_code} {r.text}"
        assert await _row(phone.fp) is None
        # the good one is accepted (the values above were not used up)
        assert (await c.post(PHONES, json={"label": "x", "public_key": phone.pub, "pop": good}, headers=_person(OWNER))).status_code == 201


async def test_c2_a_value_that_ran_out_says_so_and_a_value_from_the_future_is_refused(world):
    from app.services import agent_permissions as ap

    phone = Phone()
    async with _client() as c:
        ch = await _challenge(c)
        me, org = uuid.UUID(ch["member_id"]), uuid.UUID(ch["org_id"])
        old = ap.issue_registration_challenge(member_id=me, org_id=org, now=datetime.now(timezone.utc) - timedelta(minutes=6))
        r = await c.post(PHONES, json={"label": "x", "public_key": phone.pub, "pop": phone.proof(old)}, headers=_person(OWNER))
        assert r.status_code == 422 and r.json()["error"]["code"] == "pop_expired"
        edge = ap.issue_registration_challenge(member_id=me, org_id=org, now=datetime.now(timezone.utc) - timedelta(minutes=4, seconds=50))
        assert (await c.post(PHONES, json={"label": "x", "public_key": phone.pub, "pop": phone.proof(edge)}, headers=_person(OWNER))).status_code == 201
        another = Phone()  # ONE phone for the key and the proof — so only the clock can refuse it
        future = ap.issue_registration_challenge(member_id=me, org_id=org, now=datetime.now(timezone.utc) + timedelta(minutes=10))
        r2 = await c.post(PHONES, json={"label": "y", "public_key": another.pub, "pop": another.proof(future)}, headers=_person(OWNER))
        assert r2.status_code == 422 and r2.json()["error"]["code"] == "pop_invalid"
        near = ap.issue_registration_challenge(member_id=me, org_id=org, now=datetime.now(timezone.utc) + timedelta(seconds=10))  # a clock a few seconds ahead is a clock, not an attack
        r3 = await c.post(PHONES, json={"label": "z", "public_key": another.pub, "pop": another.proof(near)}, headers=_person(OWNER))
        assert r3.status_code == 201, r3.text


async def test_c3_a_value_made_for_one_person_is_no_good_for_another(world):
    await _plain_member()
    phone = Phone()
    async with _client() as c:
        owners = await _challenge(c, OWNER)
        # the other person signs the OWNER's value (naming the owner in it): the value's person is not the caller
        r = await c.post(PHONES, json={"label": "x", "public_key": phone.pub, "pop": phone.proof(owners)}, headers=_person(PLAIN))
        assert r.status_code == 422 and r.json()["error"]["code"] == "pop_invalid"
        # …and naming themselves with the owner's value: the mac is for the owner
        mine = await _challenge(c, PLAIN)
        swapped = phone.proof({**mine, "nonce": owners["nonce"]})
        r2 = await c.post(PHONES, json={"label": "x", "public_key": phone.pub, "pop": swapped}, headers=_person(PLAIN))
        assert r2.status_code == 422 and r2.json()["error"]["code"] == "pop_invalid"


async def test_c4_only_an_ecdsa_p256_key_can_prove_itself_other_keys_are_refused_with_their_own_code(world):
    rsa_priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    der = rsa_priv.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    pub = _b64(der)
    fp = "sha256:" + hashlib.sha256(der).hexdigest()
    async with _client() as c:
        ch = await _challenge(c)
        raw = json.dumps({"v": 1, "kind": "register_phone", "member_id": ch["member_id"], "org_id": ch["org_id"], "fingerprint": fp, "nonce": ch["nonce"]}).encode()
        r = await c.post(PHONES, json={"label": "x", "public_key": pub, "pop": {"payload": _b64(raw), "sig": _b64(b"x" * 64)}}, headers=_person(OWNER))
        assert r.status_code == 422 and r.json()["error"]["code"] == "pop_unsupported_key"
        # an old app with such a key (no proof) is still accepted as before
        assert (await c.post(PHONES, json={"label": "x", "public_key": pub}, headers=_person(OWNER))).status_code == 201


async def test_c5_a_malformed_proof_object_is_a_422_of_the_body_not_a_server_error(world):
    phone = Phone()
    async with _client() as c:
        for pop in ({}, {"payload": "x"}, {"sig": "x"}, {"payload": "", "sig": ""}, "text", 5, {"payload": "a", "sig": "b", "extra": 1}, {"payload": "a" * 3000, "sig": "b"}):
            r = await c.post(PHONES, json={"label": "x", "public_key": phone.pub, "pop": pop}, headers=_person(OWNER))
            assert r.status_code == 422, f"{pop!r}: {r.status_code}"
        assert await _row(phone.fp) is None


# ── the one-time value ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_d1_the_challenge_is_for_this_person_and_organization_private_and_not_stored(world):
    async with _client() as c:
        r = await c.post(CHALLENGE, headers=_person(OWNER))
        assert r.status_code == 200 and "no-store" in r.headers.get("cache-control", "")
        body = r.json()
        assert set(body) == {"nonce", "member_id", "org_id", "expires_at"} and body["org_id"] == str(ORG) and body["member_id"] == str(await _member_of(OWNER))
        assert len(body["nonce"].split(".")) == 3
        assert (await _challenge(c))["nonce"] != body["nonce"]  # each one is its own
        exp = datetime.fromisoformat(body["expires_at"])
        assert timedelta(minutes=4, seconds=30) < exp - datetime.now(timezone.utc) <= timedelta(minutes=5, seconds=1)
        assert (await c.post(CHALLENGE)).status_code in (401, 403)  # not signed in: nothing


async def test_d2_an_agent_key_gets_no_challenge_and_registers_no_phone(world):
    from tests.test_4529_desktop_relay_realdb import _device

    async with _client() as c:
        device = await _device(c, name="d4424 mac 5027b")
        agent_key = {"Authorization": f"Bearer {device['agents'][0]['api_key']}", "X-Org-Id": str(ORG)}
        assert (await c.post(CHALLENGE, headers=agent_key)).status_code == 403


def test_d3_without_any_signing_secret_the_server_makes_no_value(monkeypatch):
    """(no login can exist without the secret, so this is the function's own guard: a value is never made from an empty key)"""
    from app.services import agent_permissions as ap
    from app.services.desktop_relay import DesktopRelayError

    monkeypatch.setattr(settings, "jwt_secret", "")
    monkeypatch.delenv("JWT_SECRET", raising=False)
    with pytest.raises(DesktopRelayError) as exc:
        ap.issue_registration_challenge(member_id=uuid.uuid4(), org_id=uuid.uuid4())
    assert exc.value.status == 503 and exc.value.code == "pop_unavailable"


def test_d5_a_value_is_bound_to_its_organization_and_its_person_in_the_mac_itself(monkeypatch):
    """the proof's own fields name the person and the organization, but the VALUE must carry them too: a value made for one organization is no good in another, whatever the signed bytes say"""
    from app.services import agent_permissions as ap

    monkeypatch.setattr(settings, "jwt_secret", "t5027-" + "s" * 40)
    me, org_a, org_b = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    phone = Phone()
    ch_a = ap.issue_registration_challenge(member_id=me, org_id=org_a)

    def proof_for(member, org, ch):
        return ap.RegistrationProof(**phone.proof({"member_id": str(member), "org_id": str(org), "nonce": ch["nonce"]}))

    ap.check_registration_proof(proof_for(me, org_a, ch_a), der=phone.der, fingerprint=phone.fp, member_id=me, org_id=org_a)  # the right place: accepted
    with pytest.raises(ap.DesktopRelayError) as e1:  # the same value, claimed in another organization (the proof's fields say org B too)
        ap.check_registration_proof(proof_for(me, org_b, ch_a), der=phone.der, fingerprint=phone.fp, member_id=me, org_id=org_b)
    assert e1.value.code == "pop_invalid"
    with pytest.raises(ap.DesktopRelayError) as e2:  # the same value, claimed by another person
        other = uuid.uuid4()
        ap.check_registration_proof(proof_for(other, org_a, ch_a), der=phone.der, fingerprint=phone.fp, member_id=other, org_id=org_a)
    assert e2.value.code == "pop_invalid"


async def test_d4_a_secret_that_is_only_in_the_environment_is_used_as_the_login_tokens_are(world, monkeypatch):
    monkeypatch.setattr(settings, "jwt_secret", "")
    monkeypatch.setenv("JWT_SECRET", "t5027-env-" + "e" * 40)
    phone = Phone()
    async with _client() as c:
        assert (await _register(c, phone, expect=(201,))).json()["pop_verified"] is True


async def test_e00_two_people_taking_each_others_keys_back_at_once_do_not_wait_on_each_other(world, monkeypatch):
    """codex pass 3 (BLOCKER): a reclaim that locks the taker's OTHER rows after it holds the key's row makes a cycle when two people each hold the other's private key"""
    import asyncio

    from app.services import agent_permissions as ap

    await _plain_member()
    key_of_a_row, key_of_b_row = Phone(), Phone()  # a row each person holds that is NOT theirs to hold: the other person has its private key
    async with _client() as c:
        await _register(c, key_of_a_row, who=OWNER, proof=False, expect=(201,))
        await _register(c, key_of_b_row, who=PLAIN, proof=False, expect=(201,))
        real = ap._key_of_same_person

        async def slow(*a, **k):  # the pause between «the key's row is locked» and the next step: both requests are inside it together
            await asyncio.sleep(0.3)
            return await real(*a, **k)

        monkeypatch.setattr(ap, "_key_of_same_person", slow)
        # OWNER holds key_of_b_row's private half, PLAIN holds key_of_a_row's: each proves the key the other registered
        pops = [key_of_b_row.proof(await _challenge(c, OWNER)), key_of_a_row.proof(await _challenge(c, PLAIN))]
        results = await asyncio.gather(
            c.post(PHONES, json={"label": "a", "public_key": key_of_b_row.pub, "pop": pops[0]}, headers=_person(OWNER)),
            c.post(PHONES, json={"label": "b", "public_key": key_of_a_row.pub, "pop": pops[1]}, headers=_person(PLAIN)),
            return_exceptions=True,
        )
        assert [getattr(r, "status_code", repr(r)[:80]) for r in results] == [200, 200], results
        assert (await _row(key_of_b_row.fp))[0] == await _member_of(OWNER) and (await _row(key_of_a_row.fp))[0] == await _member_of(PLAIN)


async def test_e0_two_registrations_at_once_cannot_both_be_the_third_phone(world, monkeypatch):
    """codex pass 1 (BLOCKER): a row lock does not hold the gap where a new row lands — with two phones, a new key and a reclaim at the same moment both saw «two» and made four"""
    import asyncio

    from sqlalchemy.ext.asyncio import AsyncSession

    await _plain_member()
    squatted = Phone()
    async with _client() as c:
        await _register(c, squatted, who=PLAIN, label="squat", proof=False, expect=(201,))
        for i in range(2):
            await _register(c, Phone(), who=OWNER, label=f"p{i}", expect=(201,))
        fresh = Phone()
        real_flush = AsyncSession.flush

        async def slow_flush(self, *a, **k):  # every write waits a moment: the two requests overlap between «count» and «insert»
            await asyncio.sleep(0.2)
            return await real_flush(self, *a, **k)

        monkeypatch.setattr(AsyncSession, "flush", slow_flush)
        pops = [fresh.proof(await _challenge(c, OWNER)), squatted.proof(await _challenge(c, OWNER))]
        results = await asyncio.gather(
            c.post(PHONES, json={"label": "new", "public_key": fresh.pub, "pop": pops[0]}, headers=_person(OWNER)),
            c.post(PHONES, json={"label": "back", "public_key": squatted.pub, "pop": pops[1]}, headers=_person(OWNER)),
        )
        codes = sorted(r.status_code for r in results)
        assert codes in ([200, 409], [201, 409]), [(r.status_code, r.text[:120]) for r in results]  # exactly ONE got the third place
        live = await _sql(fetch=f"SELECT count(*) FROM remote_devices WHERE member_id = '{await _member_of(OWNER)}' AND revoked_at IS NULL")
        assert live[0][0] == 3


# ── limits and the same-person move ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_e1_taking_a_key_back_when_the_holder_already_has_three_changes_nothing(world):
    await _plain_member()
    owner_phone = Phone()
    async with _client() as c:
        await _register(c, owner_phone, who=PLAIN, label="squat", proof=False, expect=(201,))
        for i in range(3):
            await _register(c, Phone(), who=OWNER, label=f"p{i}", expect=(201,))
        r = await c.post(PHONES, json={"label": "mine", "public_key": owner_phone.pub, "pop": owner_phone.proof(await _challenge(c, OWNER))}, headers=_person(OWNER))
        assert r.status_code == 409 and r.json()["error"]["code"] == "remote_device_limit"
        row = await _row(owner_phone.fp)
        assert row[0] == await _member_of(PLAIN) and row[4] is None and row[2] == "squat"  # nothing was moved or marked


async def test_e2_a_key_that_moves_to_the_same_persons_member_of_another_organization_is_no_longer_proved_for_the_new_one(world):
    """the proof was made for the member and organization the key had: after a move it says nothing for the new ones"""
    from tests.test_4424_desktop_setup_realdb import ORG2

    phone = Phone()
    async with _client() as c:
        await _register(c, phone, expect=(201,))
        assert (await _row(phone.fp))[4] is not None
        org2_member = uuid.uuid4()  # the same person as a member of the second organization (the 4695 shape)
        await _sql(f"INSERT INTO org_members (id, org_id, user_id, role) VALUES ('{org2_member}', '{ORG2}', '{OWNER}', 'member')")
        await _sql(f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{org2_member}','{ORG2}','{OWNER}','human','Owner two',true)")
        await _sql(f"UPDATE remote_devices SET org_id = '{ORG2}', member_id = '{org2_member}' WHERE fingerprint = '{phone.fp}'")
        # back to the first organization with NO proof: it moves (the same person) and is not proved there
        r = await c.post(PHONES, json={"label": "x", "public_key": phone.pub}, headers=_person(OWNER, ORG))
        assert r.status_code in (200, 201), r.text
        assert (await _row(phone.fp))[4] is None and r.json()["pop_verified"] is False
