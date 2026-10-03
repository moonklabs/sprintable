"""story #4533 (E-DESKTOP-2 B-2) — an agent's permission request goes to the person who decides it; the phone's signed answer is
carried down as it is. Contract 02d2cf71 §9 · §10 (v1.7 · PO 13:21Z).

The recipient is the first person in the chain (① the recipe's next human stage · ② the org's recipe-gate default approver ·
③ who confirmed the device) with a phone paired to that device; with none, the chain's head only looks. An answer with a phone
not paired to that device is refused before the daemon sees it (409 phone_not_paired) and the request stays open. A removal
works at once here and goes down as `pairing_removed` until the device drops it — and nothing from the server adds a key.
"""
from __future__ import annotations

import base64
import hashlib
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
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

REQS = "/api/v2/agent-permission-requests"
PHONES = "/api/v2/remote-devices"


@pytest.fixture(autouse=True)
async def _remote_control_on(world):
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'")
    yield
    await _sql(f"DELETE FROM org_gate_policy WHERE org_id = '{ORG}'")


def _phone_key() -> tuple[str, bytes]:
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    der = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    return base64.urlsafe_b64encode(der).rstrip(b"=").decode(), der


def _fp(der: bytes) -> str:
    return "sha256:" + hashlib.sha256(der).hexdigest()


async def _plain_member() -> uuid.UUID:
    """The fixture's PLAIN person has an org_members row only — give them their members row (same id, as 0075)."""
    tm = (await _sql(fetch=f"SELECT id FROM org_members WHERE org_id = '{ORG}' AND user_id = '{PLAIN}'"))[0][0]
    await _sql(f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{tm}','{ORG}','{PLAIN}','human','Plain',true)")
    return tm


async def _register(c, who=OWNER, label="iPhone"):
    key, der = _phone_key()
    r = await c.post(PHONES, json={"label": label, "public_key": key}, headers=_person(who))
    assert r.status_code == 201, r.text
    return r.json()["id"], der


async def _pair(c, token, *ders, at=None):
    at = (at or datetime.now(timezone.utc)).isoformat()
    r = await c.put("/api/v2/desktop/relay/pairings", json={"pairings": [{"phone_key_fingerprint": _fp(d), "paired_at": at} for d in ders]},
                    headers=_tok(token))
    assert r.status_code == 200, r.text
    return r.json()


async def _with_session(c, device, agent=None):
    agent = agent or device["agents"][0]["member_id"]
    snap = {"report_seq": 1, "sessions": [{"session_key": "s-1", "agent_member_id": agent, "runtime": "claude", "state": "waiting_permission",
                                            "at": datetime.now(timezone.utc).isoformat()}]}
    assert (await c.put("/api/v2/desktop/relay/sessions", json=snap, headers=_tok(device["device_token"]))).status_code == 200
    return agent


def _ask(agent, request_id=None, **extra):
    return {"request_id": str(request_id or uuid.uuid4()), "session_key": "s-1", "agent_member_id": agent, "runtime": "claude",
            "tool": "Bash", "summary": "npm install --save ••••(가림)", "masked": True, "truncated": False, "workdir": "~/w",
            "input_hash": "sha256:" + "a" * 64, "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(), **extra}


async def _post_ask(c, device, body):
    return await c.post("/api/v2/desktop/relay/permission-requests", json=body, headers=_tok(device["device_token"]))


def _answer(phone_id, decision="allow", signed="eyJ2IjoxfQ.c2ln"):
    return {"decision": decision, "signed": signed, "phone_key_id": phone_id}


def test_the_confirmation_number_is_six_digits_of_the_keys_hash():
    from app.services.agent_permissions import confirm_number

    der = b"\x30\x59spki"
    n = int.from_bytes(hashlib.sha256(der).digest()[:4], "big") % 1_000_000
    assert confirm_number(der) == f"{n:06d}"[:3] + " " + f"{n:06d}"[3:]
    assert confirm_number(der).replace(" ", "").isdigit() and len(confirm_number(der)) == 7


async def test_a_person_registers_three_phones_with_their_own_session(world):
    async with _client() as c:
        key, der = _phone_key()
        first = await c.post(PHONES, json={"label": "iPhone", "public_key": key}, headers=_person(OWNER))
        assert first.status_code == 201 and first.json()["fingerprint"] == _fp(der)
        again = await c.post(PHONES, json={"label": "iPhone", "public_key": key}, headers=_person(OWNER))
        assert again.status_code == 200 and again.json()["id"] == first.json()["id"]  # the same key: the same row
        await _register(c)
        await _register(c)
        fourth = await c.post(PHONES, json={"label": "iPad", "public_key": _phone_key()[0]}, headers=_person(OWNER))
        assert fourth.status_code == 409 and fourth.json()["error"]["code"] == "remote_device_limit"
        assert len(fourth.json()["error"]["detail"]["devices"]) == 3

        device = await _device(c, name="d4424 mac 4533a")
        agent_key = {"Authorization": f"Bearer {device['agents'][0]['api_key']}", "X-Org-Id": str(ORG)}
        assert (await c.post(PHONES, json={"label": "x", "public_key": _phone_key()[0]}, headers=agent_key)).status_code == 403
        assert (await c.post(PHONES, json={"label": "x", "public_key": "bm90LWEta2V5"}, headers=_person(OWNER))).status_code == 422


async def test_a_paired_recipient_answers_once_and_the_signed_blob_goes_down_unopened(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4533b")
        token, sid = device["device_token"], device["setup_id"]
        agent = await _with_session(c, device)
        paired_id, der = await _register(c)
        unpaired_id, _ = await _register(c, label="old phone")
        await _pair(c, token, der)

        body = _ask(agent)
        made = await _post_ask(c, device, body)
        assert made.status_code == 201 and made.json()["recipient_reason"] == "paired", made.text
        assert (await _post_ask(c, device, body)).json()["id"] == made.json()["id"]  # the same request_id: one row

        [view] = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert (view["state"], view["answerable"], view["device_reachable"], view["role"]) == ("pending", True, True, "Writer")
        assert view["summary"] == "npm install --save ••••(가림)" and "input_hash" not in view

        # a phone of mine not paired with that computer: refused here, and the request stays open for the real answer
        wrong = await c.post(f"{REQS}/{view['id']}/answer", json=_answer(unpaired_id), headers=_person(OWNER))
        assert wrong.status_code == 409 and wrong.json()["error"]["code"] == "phone_not_paired"
        assert (await _sql(fetch=f"SELECT state FROM agent_permission_requests WHERE id = '{view['id']}'"))[0][0] == "pending"

        blob = "eyJ2IjoxLCJwYXlsb2FkIjoiLi4uIn0.only-the-phone-made-this"
        ok = await c.post(f"{REQS}/{view['id']}/answer", json=_answer(paired_id, signed=blob), headers=_person(OWNER))
        assert ok.status_code == 200 and ok.json()["state"] == "answered", ok.text
        cmd = await _sql(fetch=f"SELECT kind, idempotency_key, payload FROM desktop_commands WHERE setup_id = '{sid}'")
        assert [(k, i) for k, i, _p in cmd] == [("answer_approval", f"perm:{body['request_id']}")]
        assert cmd[0][2] == {"session_key": "s-1", "request_id": body["request_id"], "decision": "allow", "signed": blob}

        twice = await c.post(f"{REQS}/{view['id']}/answer", json=_answer(paired_id, "deny"), headers=_person(OWNER))
        assert twice.status_code == 409 and twice.json()["error"]["code"] == "already_answered"
        assert twice.json()["error"]["detail"] == {"answered_by_name": "Owner", "decision": "allow"}

        # the daemon refuses the signature → the request is rejected with its code
        cid = (await _sql(fetch=f"SELECT id FROM desktop_commands WHERE setup_id = '{sid}'"))[0][0]
        r = await c.post(f"/api/v2/desktop/relay/commands/{cid}/result", json={"state": "rejected", "result_code": "bad_signature"},
                         headers=_tok(token))
        assert r.status_code == 200
        row = await _sql(fetch=f"SELECT state, result_code FROM agent_permission_requests WHERE id = '{view['id']}'")
        assert tuple(row[0]) == ("rejected", "bad_signature")


async def test_the_first_person_in_the_chain_with_a_paired_phone_receives_it(world):
    """① the recipe's human stage (the owner) has no phone paired; ② the org's default approver (PLAIN) has — PLAIN receives."""
    plain_tm = await _plain_member()
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4533c")
        agent = await _with_session(c, device)
        await _register(c)  # the owner's phone, never paired with this computer
        _plain_phone, der = await _register(c, PLAIN)
        await _pair(c, device["device_token"], der)
        await _sql(f"INSERT INTO org_gate_policy (id, org_id, recipe_gate_default_approver_member_id) "
                   f"VALUES (gen_random_uuid(), '{ORG}', '{plain_tm}')")
        made = await _post_ask(c, device, _ask(agent))
        assert made.status_code == 201 and made.json()["recipient_reason"] == "paired"
        assert (await _sql(fetch=f"SELECT recipient_member_id FROM agent_permission_requests WHERE id = '{made.json()['id']}'"))[0][0] == plain_tm
        assert (await c.get(REQS, headers=_person(OWNER))).json()["requests"] == []  # not sent to anyone else in the chain
        assert len((await c.get(REQS, headers=_person(PLAIN))).json()["requests"]) == 1


async def test_with_no_paired_phone_in_the_chain_its_head_only_looks(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4533d")
        agent = await _with_session(c, device)
        phone_id, _der = await _register(c)  # registered, never paired
        made = await _post_ask(c, device, _ask(agent))
        assert made.status_code == 201 and made.json()["recipient_reason"] == "no_paired_phone"
        [view] = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]  # ① the human stage: the owner
        assert (view["recipient_reason"], view["answerable"]) == ("no_paired_phone", False)
        refused = await c.post(f"{REQS}/{view['id']}/answer", json=_answer(phone_id), headers=_person(OWNER))
        assert refused.json()["error"]["code"] == "phone_not_paired"


async def test_a_removal_works_at_once_and_goes_down_until_the_device_drops_it(world, monkeypatch):
    import app.routers.desktop_relay as router_mod

    monkeypatch.setattr(router_mod, "_LIFESPAN_SEC", 0.3)
    monkeypatch.setattr(router_mod, "_LIFESPAN_JITTER_SEC", 0)
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4533e")
        token, sid = device["device_token"], device["setup_id"]
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        paired_at = datetime.now(timezone.utc) - timedelta(minutes=5)
        await _pair(c, token, der, at=paired_at)
        view = (await _post_ask(c, device, _ask(agent))).json()

        gone = await c.delete(f"{PHONES}/{phone_id}/pairs/{sid}", headers=_person(OWNER))
        assert gone.status_code == 200 and gone.json() == {"removed": True}
        assert (await c.delete(f"{PHONES}/{phone_id}/pairs/{sid}", headers=_person(OWNER))).json() == {"removed": False}
        refused = await c.post(f"{REQS}/{view['id']}/answer", json=_answer(phone_id), headers=_person(OWNER))
        assert refused.json()["error"]["code"] == "phone_not_paired"  # at once, before the device hears of it

        frame = 'event: pairing_removed\ndata: {"phone_key_fingerprint": "%s"}' % _fp(der)
        assert frame in (await c.get("/api/v2/desktop/relay/stream", headers=_tok(token))).text
        await _pair(c, token, der, at=paired_at)  # still on the device: stays removed, the frame goes again
        assert frame in (await c.get("/api/v2/desktop/relay/stream", headers=_tok(token))).text
        # the Mac's clock a day ahead: its paired_at is later than the removal — still not revived (PO 13:55Z: no clock compare)
        await _pair(c, token, der, at=datetime.now(timezone.utc) + timedelta(days=1))
        again = await c.post(f"{REQS}/{view['id']}/answer", json=_answer(phone_id), headers=_person(OWNER))
        assert again.json()["error"]["code"] == "phone_not_paired"
        assert (await c.get(PHONES, headers=_person(OWNER))).json()["devices"][0]["pairs"] == []

        await _pair(c, token)  # the device dropped it: done, no more frames
        assert "pairing_removed" not in (await c.get("/api/v2/desktop/relay/stream", headers=_tok(token))).text
        await _pair(c, token, der)  # a new QR pairing after the removal: paired again
        assert len((await c.get(PHONES, headers=_person(OWNER))).json()["devices"][0]["pairs"]) == 1


async def test_a_late_withdrawn_or_unreachable_request_cannot_be_answered(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4533f")
        token, sid = device["device_token"], device["setup_id"]
        agent = await _with_session(c, device)
        phone_id, der = await _register(c)
        await _pair(c, token, der)
        late, gone, away = (await _post_ask(c, device, _ask(agent))).json(), None, None
        await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '1 second' WHERE id = '{late['id']}'")
        r = await c.post(f"{REQS}/{late['id']}/answer", json=_answer(phone_id), headers=_person(OWNER))
        assert (r.status_code, r.json()["error"]["code"]) == (410, "expired")
        assert [v["state"] for v in (await c.get(REQS, headers=_person(OWNER))).json()["requests"]] == ["expired"]

        body = _ask(agent)
        gone = (await _post_ask(c, device, body)).json()
        w = await c.post(f"/api/v2/desktop/relay/permission-requests/{body['request_id']}/withdraw", json={"reason": "answered_locally"},
                         headers=_tok(token))
        assert w.json()["state"] == "withdrawn"
        r = await c.post(f"{REQS}/{gone['id']}/answer", json=_answer(phone_id), headers=_person(OWNER))
        assert (r.status_code, r.json()["error"]["code"]) == (410, "withdrawn")

        away = (await _post_ask(c, device, _ask(agent))).json()
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '5 minutes' WHERE setup_id = '{sid}'")
        r = await c.post(f"{REQS}/{away['id']}/answer", json=_answer(phone_id), headers=_person(OWNER))
        assert (r.status_code, r.json()["error"]["code"]) == (409, "device_unreachable")
        assert [v["answerable"] for v in (await c.get(REQS, headers=_person(OWNER), params={"state": "pending"})).json()["requests"]] == [False]
        assert (await _sql(fetch=f"SELECT count(*) FROM desktop_commands WHERE setup_id = '{sid}'"))[0][0] == 0


async def test_the_report_carries_no_raw_input_and_only_this_devices_sessions_and_agents(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4533g")
        agent = await _with_session(c, device)
        for bad, code in (
            (_ask(agent, command="rm -rf ~"), 422),  # an extra field: no place for raw input
            (_ask(agent, session_key="s-9"), 422),  # not a session of this device
            (_ask(str(uuid.uuid4())), 422),  # not an agent of this device
            (_ask(agent, expires_at=(datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()), 422),
            (_ask(agent, input_hash="a" * 64), 422),
        ):
            assert (await _post_ask(c, device, bad)).status_code == code
        person = await c.post("/api/v2/desktop/relay/permission-requests", json=_ask(agent), headers=_person(OWNER))
        assert person.status_code == 401  # a person's token is no device
        assert (await _sql(fetch="SELECT count(*) FROM agent_permission_requests WHERE setup_id = :s",
                           params={"s": device["setup_id"]}))[0][0] == 0


async def test_a_persons_own_api_key_neither_answers_nor_adds_a_phone(world):
    """A script holding the owner's hu_live_ key must not answer for them or register a phone in their name — the person's own
    session (the phone app's login) does both."""
    from app.core.database import async_session_factory
    from app.repositories.human_api_key import HumanApiKeyRepository

    async with async_session_factory() as s:
        _hkey, plaintext = await HumanApiKeyRepository(s).create(member_id=OWNER_TM, name="d4533 script", expires_at=None)
        await s.commit()
    person_key = {"Authorization": f"Bearer {plaintext}", "X-Org-Id": str(ORG)}
    try:
        async with _client() as c:
            device = await _device(c, name="d4424 mac 4533h")
            agent = await _with_session(c, device)
            phone_id, der = await _register(c)
            await _pair(c, device["device_token"], der)
            made = (await _post_ask(c, device, _ask(agent))).json()
            refused = await c.post(f"{REQS}/{made['id']}/answer", json=_answer(phone_id), headers=person_key)
            assert refused.status_code == 403 and refused.json()["error"]["code"] == "person_session_required"
            assert (await _sql(fetch=f"SELECT state FROM agent_permission_requests WHERE id = '{made['id']}'"))[0][0] == "pending"
            added = await c.post(PHONES, json={"label": "x", "public_key": _phone_key()[0]}, headers=person_key)
            assert added.status_code == 403 and added.json()["error"]["code"] == "person_session_required"
            assert (await c.post(f"{REQS}/{made['id']}/answer", json=_answer(phone_id), headers=_person(OWNER))).status_code == 200
    finally:
        await _sql(f"DELETE FROM human_api_keys WHERE member_id = '{OWNER_TM}'")
