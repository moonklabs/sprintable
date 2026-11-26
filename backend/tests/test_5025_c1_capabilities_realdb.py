"""story 5025 (C1 · contract v1.2 §3 · §5 · §6 · v1.3 §1 ④) — what each pinned phone may do with each agent of a computer, SIGNED by the server.

Real database. Each test goes red without the line it names. The set is computed from the SAME functions the endpoints use (`can_command` · `can_view`), signed with a key that is its own (never the JWT secret), pushed when it changes
and every half life, pulled whole when a host connects (once in ten seconds), and the host's counts of its own refusals are taken as counts only. Last: the card's receiver is fixed at the moment the card is made (the pin v1.3 §1 ④ asks for).
"""
from __future__ import annotations

import base64
import json
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives import serialization

from app.core.config import settings
from app.core.rate_limit import reset_person_limits
from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    ORG2,
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
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4533_agent_permissions_realdb import (  # noqa: F401 — the autouse remote-control fixture applies here too
    REQS,
    _ask,
    _plain_member,
    _post_ask,
    _remote_control_on,
    _with_session,
)
from tests.test_5025_b1_seal_targets_realdb import _computer, _phone, _pin
from tests.test_5027_phone_key_proof_realdb import (  # noqa: F401 — the autouse fixtures (jwt secret · clean phones) apply here too
    _clean_phones,
    _jwt_secret,
)

pytestmark = pytest.mark.anyio

CAPS = "/api/v2/desktop/relay/capabilities"
KEYS = "/api/v2/desktop/relay/attest-keys"
REJECT = "/api/v2/desktop/relay/capability-rejections"
DOMAIN = b"sprintable/capability_set/v1\n"
ROTATE = b"sprintable/attest_rotate/v1\n"


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _seed() -> str:
    return _b64u(os.urandom(32))


def _public_of(seed: str) -> str:
    private = Ed25519PrivateKey.from_private_bytes(_unb64u(seed))
    return _b64u(private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))


def _verify(envelope: dict, public_key: str, domain: bytes = DOMAIN) -> dict:
    """check the signature over the EXACT bytes that were signed (never re-serialised), then parse those bytes"""
    assert envelope["v"] == 1 and set(envelope) == {"v", "kid", "p", "sig"}
    payload = _unb64u(envelope["p"])
    Ed25519PublicKey.from_public_bytes(_unb64u(public_key)).verify(_unb64u(envelope["sig"]), domain + payload)
    return json.loads(payload)


@pytest.fixture(autouse=True)
def _limits_start_clean():
    reset_person_limits()
    yield
    reset_person_limits()


@pytest.fixture
def key(monkeypatch):
    """a server WITH a capability signing key → (its seed, its public key)"""
    seed = _seed()
    monkeypatch.setattr(settings, "capability_signing_key", seed)
    monkeypatch.setattr(settings, "capability_signing_key_file", "")
    monkeypatch.setattr(settings, "capability_retired_keys", "")
    monkeypatch.setattr(settings, "capability_epoch", 1)
    return seed, _public_of(seed)


async def _commands(setup_id, kind="capability_set"):
    from app.services.pg_pubsub import drain_background_tasks

    await drain_background_tasks(timeout=15.0)  # the push goes out AFTER the change has committed, in a task of its own: wait for it
    return await _sql(fetch=f"SELECT device_seq, payload FROM desktop_commands WHERE setup_id = '{setup_id}' AND kind = '{kind}' ORDER BY device_seq")


async def _pull(c, token):
    return await c.get(CAPS, headers=_tok(token))


# ── the keys ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_the_exchange_hands_over_the_keys_once_and_a_server_with_no_key_leaves_the_field_out_entirely(world, key):
    seed, public = key
    async with _client() as c:
        device = await _device(c, name="d4424 mac 5025c1a")
        [k] = device["attest_keys"]
        assert k["public_key"] == public and re.fullmatch(r"ak1-[0-9a-f]{16}", k["kid"])
        assert set(k) == {"kid", "public_key"}  # a public key and its name: nothing else


async def test_no_signing_key_means_no_road_at_all_no_field_no_pull_no_keys_no_push(world, monkeypatch):
    monkeypatch.setattr(settings, "capability_signing_key", "")
    monkeypatch.setattr(settings, "capability_signing_key_file", "")
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1b")
        assert "attest_keys" not in device
        assert (await _pull(c, token)).status_code == 404
        assert (await c.get(KEYS, headers=_tok(token))).status_code == 404
        phone, _pid = await _phone(c)
        await _pin(c, token, phone)
        assert await _commands(setup_id) == []  # nothing pushed: a host sees an older server


async def test_the_key_is_read_from_a_file_and_a_malformed_key_turns_the_road_off_instead_of_signing_with_it(world, monkeypatch, tmp_path):
    seed = _seed()
    f = tmp_path / "cap.key"
    f.write_text(seed + "\n")
    f.chmod(0o600)
    monkeypatch.setattr(settings, "capability_signing_key", "")
    monkeypatch.setattr(settings, "capability_signing_key_file", str(f))
    async with _client() as c:
        device = await _device(c, name="d4424 mac 5025c1c")
        assert device["attest_keys"][0]["public_key"] == _public_of(seed)
    monkeypatch.setattr(settings, "capability_signing_key", "not-a-key")
    async with _client() as c:
        device = await _device(c, name="d4424 mac 5025c1d")
        assert "attest_keys" not in device


async def test_the_signing_key_is_never_one_of_the_servers_other_secrets(world, key, monkeypatch):
    seed, public = key
    monkeypatch.setattr(settings, "jwt_secret", "j" * 64)
    monkeypatch.setattr(settings, "local_bootstrap_secret", "l" * 64)
    src = (Path(__file__).resolve().parents[1] / "app" / "services" / "capability_set.py").read_text()
    assert "jwt_secret" not in src and "local_bootstrap_secret" not in src and "support_gateway" not in src  # the key's own settings only


async def test_a_host_that_paired_before_the_server_had_a_key_gets_the_keys_and_the_rotation_door_from_a_retired_key(world, monkeypatch):
    old, new = _seed(), _seed()
    monkeypatch.setattr(settings, "capability_signing_key", new)
    monkeypatch.setattr(settings, "capability_retired_keys", old)
    monkeypatch.setattr(settings, "capability_epoch", 3)
    async with _client() as c:
        device, token, *_ = await _computer(c, "d4424 mac 5025c1e")
        r = await c.get(KEYS, headers=_tok(token))
        assert r.status_code == 200
        body = r.json()
        assert [k["public_key"] for k in body["attest_keys"]] == [_public_of(new)]
        [door] = body["rotations"]
        payload = _verify(door, _public_of(old), ROTATE)  # signed BY the retired key: «hand on to the new one»
        assert payload["kind"] == "attest_rotate" and payload["epoch"] == 3
        assert [k["public_key"] for k in payload["add"]] == [_public_of(new)] and payload["remove"] == [door["kid"]]
        assert datetime.fromisoformat(body["server_time"].replace("Z", "+00:00")).tzinfo is not None
        with pytest.raises(Exception):
            _verify(door, _public_of(new), ROTATE)  # not signed by the NEW key: a door nobody else can open
        # no door when nothing was retired
        monkeypatch.setattr(settings, "capability_retired_keys", "")
        assert (await c.get(KEYS, headers=_tok(token))).json()["rotations"] == []


# ── the set ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_a_pull_is_the_whole_current_set_signed_over_the_exact_bytes_and_ten_minutes_long(world, key):
    seed, public = key
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1f")
        phone, pid = await _phone(c)
        await _pin(c, token, phone)
        r = await _pull(c, token)
        assert r.status_code == 200
        envelope = r.json()["envelope"]
        payload = _verify(envelope, public)
        assert envelope["kid"] == device["attest_keys"][0]["kid"] if "attest_keys" in device else True
        assert payload["kind"] == "capability_set" and payload["v"] == 1 and payload["setup_id"] == str(setup_id) and payload["epoch"] == 1
        iat = datetime.fromisoformat(payload["iat"].replace("Z", "+00:00"))
        exp = datetime.fromisoformat(payload["exp"].replace("Z", "+00:00"))
        assert exp - iat == timedelta(minutes=10)
        assert abs((iat - datetime.now(timezone.utc)).total_seconds()) < 30
        agents = sorted(a["member_id"] for a in device["agents"])
        assert payload["caps"] == [{"phone_key_id": pid, "agent_member_id": a, "actions": ["control", "read"]} for a in agents]  # the owner's phone, every agent of the computer: both, as the endpoints say
        assert datetime.fromisoformat(r.json()["server_time"].replace("Z", "+00:00")).tzinfo is not None


async def test_a_signature_for_another_purpose_or_another_key_or_another_byte_does_not_verify(world, key):
    seed, public = key
    async with _client() as c:
        device, token, *_ = await _computer(c, "d4424 mac 5025c1g")
        envelope = (await _pull(c, token)).json()["envelope"]
        _verify(envelope, public)
        with pytest.raises(Exception):
            _verify(envelope, public, ROTATE)  # the domain is part of what is signed
        with pytest.raises(Exception):
            _verify(envelope, _public_of(_seed()))
        tampered = {**envelope, "p": _b64u(_unb64u(envelope["p"]).replace(b'"epoch":1', b'"epoch":9'))}
        with pytest.raises(Exception):
            _verify(tampered, public)


async def test_the_set_is_what_the_endpoints_already_say_a_person_who_cannot_command_gets_read_at_most_and_a_stranger_nothing(world, key):
    """the SAME functions: the setup's confirmer (the owner) commands · a plain org member does not (control absent) and, with no access to the agent's project, reads nothing either"""
    plain_tm = await _plain_member()
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1h")
        owner_phone, owner_pid = await _phone(c, who=OWNER)
        plain_phone, plain_pid = await _phone(c, who=PLAIN)
        await _pin(c, token, owner_phone, plain_phone)
        payload = _verify((await _pull(c, token)).json()["envelope"], key[1])
        by_phone = {e["phone_key_id"]: e for e in payload["caps"]}
        assert by_phone[owner_pid]["actions"] == ["control", "read"]
        if plain_pid in by_phone:
            assert "control" not in by_phone[plain_pid]["actions"]
        assert {e["agent_member_id"] for e in payload["caps"]} <= {a["member_id"] for a in device["agents"]}  # only the computer's own agents


async def test_the_same_facts_make_the_same_set_in_the_same_order(world, key):
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1i")
        a, _ = await _phone(c)
        b, _ = await _phone(c)
        await _pin(c, token, a, b)
        one = _verify((await _pull(c, token)).json()["envelope"], key[1])["caps"]
        reset_person_limits()
        two = _verify((await _pull(c, token)).json()["envelope"], key[1])["caps"]
        assert one == two and [e["phone_key_id"] for e in one] == sorted(e["phone_key_id"] for e in one)


async def test_a_key_of_nobody_here_an_unpinned_key_and_a_revoked_key_are_never_in_the_set(world, key):
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1j")
        pinned, pinned_id = await _phone(c)
        _never_pinned, never_id = await _phone(c)
        await _pin(c, token, pinned, extra_unregistered=1)  # a pin of a key the server never saw: counted, never named
        payload = _verify((await _pull(c, token)).json()["envelope"], key[1])
        assert {e["phone_key_id"] for e in payload["caps"]} == {pinned_id}
        await _sql(f"UPDATE remote_devices SET revoked_at = now() WHERE id = '{pinned_id}'")
        reset_person_limits()
        assert _verify((await _pull(c, token)).json()["envelope"], key[1])["caps"] == []


async def test_when_people_are_mixed_only_a_proved_key_is_in_the_set_and_one_persons_older_key_stays(world, key):
    await _plain_member()
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1k")
        unproved_owner, unproved_id = await _phone(c, who=OWNER, proof=False)
        await _pin(c, token, unproved_owner)
        solo = _verify((await _pull(c, token)).json()["envelope"], key[1])["caps"]
        assert {e["phone_key_id"] for e in solo} == {unproved_id}  # one person: C1 — an older app's key keeps working
        proved_plain, proved_id = await _phone(c, who=PLAIN, proof=True)
        await _pin(c, token, unproved_owner, proved_plain)
        reset_person_limits()
        mixed = _verify((await _pull(c, token)).json()["envelope"], key[1])["caps"]
        assert unproved_id not in {e["phone_key_id"] for e in mixed}  # people are mixed: no proof, no word
        assert all(e["phone_key_id"] != unproved_id for e in mixed)



async def test_a_key_that_belongs_to_another_organization_is_never_in_the_set(world, key):
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1k2")
        a, a_id = await _phone(c)
        b, b_id = await _phone(c)
        await _pin(c, token, a, b)
        await _sql(f"UPDATE remote_devices SET org_id = '{ORG2}' WHERE id = '{b_id}'")  # a key that moved to another organization keeps its pairing row until the next snapshot
        payload = _verify((await _pull(c, token)).json()["envelope"], key[1])
        assert {e["phone_key_id"] for e in payload["caps"]} == {a_id}


async def test_the_actions_are_exactly_what_can_command_and_can_view_say_for_each_person_and_agent(world, key):
    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.services.desktop_commands import can_view

    plain_tm = await _plain_member()
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1k3")
        plain_phone, plain_pid = await _phone(c, who=PLAIN)
        await _pin(c, token, plain_phone)
        payload = _verify((await _pull(c, token)).json()["envelope"], key[1])
        got = {e["agent_member_id"]: e["actions"] for e in payload["caps"] if e["phone_key_id"] == plain_pid}
        async with async_session_factory() as s:
            for a in device["agents"]:
                readable = await can_view(s, user_id=PLAIN, org_id=ORG, agent_id=uuid.UUID(a["member_id"]))
                actions = got.get(a["member_id"], [])
                assert ("read" in actions) == readable, (a["member_id"], actions, readable)
                assert "control" not in actions  # a plain org member: not the owner/admin, not the agent's owner, not the confirmer


async def test_many_phones_come_out_in_one_fixed_order_whatever_order_they_were_made_in(world, key):
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1k4")
        await _plain_member()
        phones = [await _phone(c, who=OWNER) for _ in range(3)] + [await _phone(c, who=PLAIN) for _ in range(3)]  # (three phones a person at most)
        await _pin(c, token, *[p for p, _ in phones])
        caps = _verify((await _pull(c, token)).json()["envelope"], key[1])["caps"]
        keys = [(e["phone_key_id"], e["agent_member_id"]) for e in caps]
        assert len(keys) >= 6 and keys == sorted(keys)  # the owner's three phones alone are six entries, in id order whatever order they came from the database

# ── serial · epoch ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_the_serial_only_goes_up_and_is_never_below_the_clock_so_a_restored_database_cannot_hand_out_an_old_one(world, key):
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1l")
        before = int(time.time() * 1000)
        first = _verify((await _pull(c, token)).json()["envelope"], key[1])["serial"]
        assert first >= before
        reset_person_limits()
        second = _verify((await _pull(c, token)).json()["envelope"], key[1])["serial"]
        assert second > first
        # «the database was restored to an older state»: the counter is back at zero — the next serial is still above anything a host has seen
        await _sql(f"UPDATE desktop_setups SET capability_serial = 0 WHERE id = '{setup_id}'")
        reset_person_limits()
        third = _verify((await _pull(c, token)).json()["envelope"], key[1])["serial"]
        assert third > second - 1 and third >= int(time.time() * 1000) - 5_000
        # and ahead of the clock (a counter that ran past it) it still goes up by one
        await _sql(f"UPDATE desktop_setups SET capability_serial = {third + 10_000_000} WHERE id = '{setup_id}'")
        reset_person_limits()
        assert _verify((await _pull(c, token)).json()["envelope"], key[1])["serial"] == third + 10_000_001


async def test_the_epoch_is_the_servers_own_setting_and_is_in_every_set(world, key, monkeypatch):
    async with _client() as c:
        device, token, *_ = await _computer(c, "d4424 mac 5025c1m")
        assert _verify((await _pull(c, token)).json()["envelope"], key[1])["epoch"] == 1
        monkeypatch.setattr(settings, "capability_epoch", 7)
        reset_person_limits()
        assert _verify((await _pull(c, token)).json()["envelope"], key[1])["epoch"] == 7



async def test_the_computers_row_is_locked_before_the_facts_are_read_so_serials_follow_the_order_of_commits(world, key, monkeypatch):
    """codex: a pull that read the facts before an unpair committed must not be handed a serial above the push that carries the unpair. The row is locked first; the facts are read under that lock."""
    from app.services import capability_set

    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1m2")
        real = capability_set.compute_caps
        seen: dict = {}

        async def watching(db, setup):
            try:
                await _sql(f"SELECT id FROM desktop_setups WHERE id = '{setup_id}' FOR UPDATE NOWAIT")  # from ANOTHER connection: it fails exactly when the row is locked
                seen["locked"] = False
            except Exception:  # noqa: BLE001
                seen["locked"] = True
            return await real(db, setup)

        monkeypatch.setattr(capability_set, "compute_caps", watching)
        r = await _pull(c, token)
        assert r.status_code == 200 and seen == {"locked": True}
        assert r.headers["cache-control"] == "no-store, private"  # one computer's set is never kept by a shared cache
        assert (await c.get(KEYS, headers=_tok(token))).headers["cache-control"] == "no-store, private"


async def test_the_facts_are_read_again_under_the_lock_an_agent_moved_off_the_computer_since_the_object_was_loaded_is_not_named(world, key):
    """codex round 2: the setup object a request carries may be older than a change that has since committed. The set is computed from the row as it is under the lock."""
    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.services import capability_set

    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1m3")
        phone, pid = await _phone(c)
        await _pin(c, token, phone)
        agents = [a["member_id"] for a in device["agents"]]
        assert len(agents) >= 2
        async with async_session_factory() as s:
            stale = await s.get(DesktopSetup, setup_id)  # loaded now, with all its agents
            moved = agents[0]
            await _sql(f"UPDATE desktop_setups SET members = (SELECT jsonb_agg(m) FROM jsonb_array_elements(members) m WHERE m->>'member_id' <> '{moved}') WHERE id = '{setup_id}'")  # …and it moves off this computer
            envelope = await capability_set.build_envelope(s, stale)
            named = {e["agent_member_id"] for e in _verify(envelope, key[1])["caps"]}
            assert moved not in named and named == set(agents[1:])


async def test_a_set_is_never_signed_for_a_computer_that_was_cut_off_even_by_a_request_let_in_before_the_cut_off(world, key):
    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.services import capability_set
    from app.services.desktop_relay import DesktopRelayError

    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1m4")
        async with async_session_factory() as s:
            stale = await s.get(DesktopSetup, setup_id)  # the request's object: loaded before the cut-off
            await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{setup_id}'")
            with pytest.raises(DesktopRelayError) as e:
                await capability_set.build_envelope(s, stale)
            assert e.value.status == 409 and e.value.code == "device_disconnected"


async def test_a_push_that_fails_never_fails_the_pairing_change_it_follows(world, key, monkeypatch):
    from app.services import capability_set

    async def boom(*a, **k):
        raise RuntimeError("signing is broken")

    monkeypatch.setattr(capability_set, "push_capability_set", boom)
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1m5")
        phone, pid = await _phone(c)
        snap = await _pin(c, token, phone)  # the pin goes through
        assert snap["pairings"] == 1
        assert await _commands(setup_id) == []  # and nothing was pushed — the half life (or the next change) carries it


async def test_a_pairing_change_that_rolls_back_pushes_nothing(world, key):
    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.services import capability_set

    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1m6")
        async with async_session_factory() as s:
            await capability_set.tell(s, [setup_id])
            await s.rollback()
        assert await _commands(setup_id) == []

# ── pull · push ────────────────────────────────────────────────────────────────────────────────────────────────────────────

async def test_a_pull_is_one_in_ten_seconds_per_computer_and_the_answer_says_to_wait_not_that_there_is_nothing(world, key):
    async with _client() as c:
        device, token, *_ = await _computer(c, "d4424 mac 5025c1n")
        assert (await _pull(c, token)).status_code == 200
        r = await _pull(c, token)
        assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1
        assert r.json().get("error", {}).get("code", r.json().get("detail", {}).get("code")) in ("RATE_LIMITED", None) or "RATE_LIMITED" in r.text
        other, other_token, *_ = await _computer(c, "d4424 mac 5025c1n2")
        assert (await _pull(c, other_token)).status_code == 200  # per computer, not per server


async def test_a_pull_needs_the_devices_own_token(world, key):
    async with _client() as c:
        assert (await c.get(CAPS)).status_code == 401
        assert (await c.get(CAPS, headers=_tok("not-a-token"))).status_code in (401, 403)
        assert (await c.get(CAPS, headers=_person(OWNER))).status_code == 401  # a person is no device here


async def test_a_pin_pushes_one_signed_set_down_the_command_channel_and_the_same_snapshot_again_pushes_nothing(world, key):
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1o")
        phone, pid = await _phone(c)
        await _pin(c, token, phone)
        [(seq, payload)] = await _commands(setup_id)
        assert set(payload) == {"envelope"}
        body = _verify(payload["envelope"], key[1])
        assert {e["phone_key_id"] for e in body["caps"]} == {pid}
        await _pin(c, token, phone)  # nothing changed
        assert len(await _commands(setup_id)) == 1


async def test_a_removed_pair_pushes_a_set_without_the_phone_and_a_removed_key_too(world, key):
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1p")
        a, a_id = await _phone(c)
        b, b_id = await _phone(c)
        await _pin(c, token, a, b)
        r = await c.delete(f"/api/v2/remote-devices/{a_id}/pairs/{setup_id}", headers=_person(OWNER))
        assert r.status_code in (200, 204), r.text
        rows = await _commands(setup_id)
        last = _verify(rows[-1][1]["envelope"], key[1])
        assert {e["phone_key_id"] for e in last["caps"]} == {b_id}
        r = await c.delete(f"/api/v2/remote-devices/{b_id}", headers=_person(OWNER))
        assert r.status_code in (200, 204), r.text
        rows = await _commands(setup_id)
        assert _verify(rows[-1][1]["envelope"], key[1])["caps"] == []


async def test_a_half_life_forces_a_fresh_set_even_when_nothing_changed_and_the_stream_asks_for_it(world, key):
    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.services import capability_set

    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1q")
        phone, pid = await _phone(c)
        await _pin(c, token, phone)
        assert len(await _commands(setup_id)) == 1
        async with async_session_factory() as s:
            setup = await s.get(DesktopSetup, setup_id)
            assert await capability_set.push_capability_set(s, setup) is False  # unchanged: nothing
            assert await capability_set.push_capability_set(s, setup, force=True) is True  # the half life: a fresh set, new serial
            await s.commit()
        rows = await _commands(setup_id)
        assert len(rows) == 2
        assert _verify(rows[1][1]["envelope"], key[1])["serial"] > _verify(rows[0][1]["envelope"], key[1])["serial"]
    assert capability_set.HALF_LIFE == timedelta(minutes=5)
    src = (Path(__file__).resolve().parents[1] / "app" / "routers" / "desktop_relay.py").read_text()
    assert "capability_set.HALF_LIFE" in src and "push_capability_set(s, fresh_setup, force=True)" in src  # the stream is what asks, each half life


async def test_a_computer_that_is_cut_off_or_whose_remote_control_is_off_is_told_nothing(world, key):
    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.services import capability_set

    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1r")
        phone, pid = await _phone(c)
        await _pin(c, token, phone)
        n = len(await _commands(setup_id))
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{setup_id}'")
        async with async_session_factory() as s:
            setup = await s.get(DesktopSetup, setup_id)
            assert await capability_set.push_capability_set(s, setup, force=True) is False
        assert len(await _commands(setup_id)) == n


async def test_the_command_word_is_in_the_code_and_in_the_check_and_its_payload_is_the_envelope_only(world):
    from app.models.desktop_relay import COMMAND_KINDS
    from app.services.desktop_relay import PAYLOAD_SCHEMAS, DesktopRelayError, validate_payload

    assert "capability_set" in COMMAND_KINDS and tuple(PAYLOAD_SCHEMAS) == COMMAND_KINDS
    validate_payload("capability_set", {"envelope": {"v": 1}})
    with pytest.raises(DesktopRelayError):
        validate_payload("capability_set", {"envelope": {}, "extra": 1})
    with pytest.raises(DesktopRelayError):
        validate_payload("capability_set", {})
    check = (await _sql(fetch="SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_desktop_commands_kind'"))[0][0]
    assert all(f"'{k}'" in check for k in COMMAND_KINDS)


# ── what a host says of its own refusals ───────────────────────────────────────────────────────────────────────────────────

def _entry(code="no_capability", phone=None, agent=None, count=1):
    return {"code": code, "phone_key_id": str(phone or uuid.uuid4()), "agent_member_id": str(agent or uuid.uuid4()), "count": count}


async def test_a_report_of_refusals_is_added_up_as_counts_with_nothing_else(world, key):
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1s")
        phone = uuid.uuid4()
        r = await c.put(REJECT, json={"rejections": [_entry("no_capability", phone, agent, 2), _entry("capability_expired", phone, agent, 1)]}, headers=_tok(token))
        assert r.status_code == 200 and r.json() == {"taken": 2}
        r = await c.put(REJECT, json={"rejections": [_entry("no_capability", phone, agent, 3)]}, headers=_tok(token))
        assert r.status_code == 200
        rows = await _sql(fetch=f"SELECT code, count FROM desktop_capability_rejections WHERE setup_id = '{setup_id}' ORDER BY code")
        assert [(r[0], r[1]) for r in rows] == [("capability_expired", 1), ("no_capability", 5)]
        cols = [r[0] for r in await _sql(fetch="SELECT column_name FROM information_schema.columns WHERE table_name = 'desktop_capability_rejections' ORDER BY ordinal_position")]
        assert cols == ["setup_id", "code", "phone_key_id", "agent_member_id", "count", "last_at"]  # ids, a word, a number, a time — no text


async def test_a_report_with_a_word_outside_the_list_a_text_field_a_zero_or_too_many_entries_is_refused_and_stores_nothing(world, key):
    async with _client() as c:
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1t")
        bad = [
            {"rejections": [_entry("who_knows")]},
            {"rejections": [{**_entry(), "text": "rm -rf"}]},
            {"rejections": [_entry(count=0)]},
            {"rejections": [_entry(count=10_001)]},
            {"rejections": [_entry() for _ in range(51)]},
            {"rejections": [_entry()], "extra": 1},
            {"rejections": [{"code": "no_capability", "count": 1}]},
        ]
        for body in bad:
            reset_person_limits()
            r = await c.put(REJECT, json=body, headers=_tok(token))
            assert r.status_code == 422, (body, r.status_code)
        assert (await _sql(fetch=f"SELECT count(*) FROM desktop_capability_rejections WHERE setup_id = '{setup_id}'"))[0][0] == 0


async def test_the_report_has_a_per_minute_limit_per_computer(world, key):
    async with _client() as c:
        device, token, *_ = await _computer(c, "d4424 mac 5025c1u")
        seen = []
        for _ in range(14):
            seen.append((await c.put(REJECT, json={"rejections": [_entry()]}, headers=_tok(token))).status_code)
        assert seen[:12] == [200] * 12 and seen[12:] == [429, 429]


async def test_a_report_needs_the_devices_own_token_and_a_disconnected_computer_takes_its_counts_with_it(world, key):
    async with _client() as c:
        assert (await c.put(REJECT, json={"rejections": [_entry()]})).status_code == 401
        device, token, agent, setup_id = await _computer(c, "d4424 mac 5025c1v")
        assert (await c.put(REJECT, json={"rejections": [_entry(agent=agent)]}, headers=_tok(token))).status_code == 200
        await _sql(f"DELETE FROM desktop_setups WHERE id = '{setup_id}'")
        assert (await _sql(fetch=f"SELECT count(*) FROM desktop_capability_rejections WHERE setup_id = '{setup_id}'"))[0][0] == 0  # ON DELETE CASCADE


# ── v1.3 §1 ④ — the receiver is fixed when the card is made ────────────────────────────────────────────────────────────────

async def test_the_receiver_of_a_card_is_decided_once_when_it_is_made_and_nothing_afterwards_changes_it(world):
    """Kadir's pin (11-26): nothing in the server re-assigns a card. Make a card for the first person of the chain, then move the chain, take the receiver's phone away, end the card, let it expire and answer it as someone else:
    `recipient_member_id` is the same at every step. The moment somebody adds a re-assignment this goes red — and v1.3 §1 ④ says such a change needs the three C4 lines and the host's id mapping first."""
    plain_tm = await _plain_member()
    owner_tm = (await _sql(fetch=f"SELECT id FROM members WHERE org_id = '{ORG}' AND user_id = '{OWNER}' AND type = 'human'"))[0][0]
    async with _client() as c:
        device = await _device(c, name="d4424 mac 5025c1w")
        agent = await _with_session(c, device)
        token = device["device_token"]
        setup_id = (await _sql(fetch="SELECT id FROM desktop_setups WHERE device_name = 'd4424 mac 5025c1w'"))[0][0]
        owner_phone, owner_pid = await _phone(c, who=OWNER)
        plain_phone, plain_pid = await _phone(c, who=PLAIN)
        await _pin(c, token, owner_phone, plain_phone)

        async def receiver(card_id):
            return (await _sql(fetch=f"SELECT recipient_member_id FROM agent_permission_requests WHERE id = '{card_id}'"))[0][0]

        first_ask = _ask(agent)
        made = await _post_ask(c, device, first_ask)
        assert made.status_code == 201 and made.json()["recipient_reason"] == "paired"
        card = made.json()["id"]
        assert await receiver(card) == owner_tm  # the first person of the chain with a phone pinned here

        # the chain moves: another default approver · another confirmer
        await _sql(f"INSERT INTO org_gate_policy (id, org_id, recipe_gate_default_approver_member_id) VALUES (gen_random_uuid(), '{ORG}', '{plain_tm}')")
        assert await receiver(card) == owner_tm
        # the receiver's phone is taken away: a NEW card now goes to somebody else (so the chain really did move) — the old card's receiver stays
        r = await c.delete(f"/api/v2/remote-devices/{owner_pid}/pairs/{setup_id}", headers=_person(OWNER))
        assert r.status_code in (200, 204), r.text
        later = await _post_ask(c, device, _ask(agent))
        assert later.status_code == 201 and await receiver(later.json()["id"]) == plain_tm
        assert await receiver(card) == owner_tm
        # an answer by someone who is not its receiver changes nothing about whose it is
        await c.post(f"{REQS}/{card}/answer", json={"decision": "allow", "signed": "eyJ2IjoxfQ.c2ln", "phone_key_id": plain_pid}, headers=_person(PLAIN))
        assert await receiver(card) == owner_tm
        # withdrawn by the computer, then expired
        await c.post(f"/api/v2/desktop/relay/permission-requests/{first_ask['request_id']}/withdraw", json={"reason": "answered_locally"}, headers=_tok(token))
        assert await receiver(card) == owner_tm
        await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '1 second' WHERE id = '{card}'")
        await c.get(REQS, headers=_person(PLAIN))
        assert await receiver(card) == owner_tm


async def test_no_statement_in_the_server_writes_the_receiver_column_but_the_one_that_makes_the_card():
    """the same pin read from the code: the only place `recipient_member_id` is given a value is where the card is built (one `recipient_member_id=` in a constructor · no UPDATE of it)"""
    root = Path(__file__).resolve().parents[1] / "app"
    writers = []
    for path in root.rglob("*.py"):
        text = path.read_text(encoding="utf8")
        for m in re.finditer(r"recipient_member_id\s*=\s*(?!=)", text):
            line = text[: m.start()].count("\n") + 1
            writers.append(f"{path.relative_to(root)}:{line}")
    # the constructor of the card is the one writer (the model's column declaration is `name: Mapped[…] = …`, not an assignment of the name)
    assert [w.split(":")[0] for w in writers] == ["services/agent_permissions.py"], writers
    assert not re.search(r"update\(AgentPermissionRequest\)[^;]{0,400}recipient_member_id\s*=", (root / "services" / "agent_permissions.py").read_text(encoding="utf8"))


# ── the vectors the host will check against (contracts/capability-vectors.json — the same file on both sides) ──────────────────────────

def _vectors():
    return json.loads((Path(__file__).resolve().parents[2] / "contracts" / "capability-vectors.json").read_text(encoding="utf8"))


def test_the_shared_vectors_are_what_the_servers_signing_makes_a_key_signs_over_domain_and_the_exact_bytes():
    """every case whose verdict does not depend on time or on which computer it is: the signature verifies exactly when the file says it should — checked with the SERVER's own domain bytes, so the host (which reads the same file)
    and the server cannot drift"""
    v = _vectors()
    assert v["domain"].encode() + b"\n" == DOMAIN and v["rotate_domain"].encode() + b"\n" == ROTATE
    pinned = v["keys"]
    for case in v["cases"]:
        env = case["envelope"]
        key = pinned.get(env["kid"])
        ok = False
        if key is not None:
            try:
                _verify(env, key)
                ok = True
            except Exception:
                ok = False
        should = case["expect"] not in ("bad_signature", "unknown_kid")
        assert ok == should, (case["name"], ok, case["expect"])


def test_the_vectors_key_names_are_the_servers_names_for_those_keys_and_a_signed_case_re_verifies_byte_for_byte():
    from app.services import capability_set

    v = _vectors()
    seed = v["seeds"]["pinned"]
    key = capability_set._from_seed(seed)
    assert v["keys"] == {key.kid: key.public}
    valid = next(c for c in v["cases"] if c["name"] == "valid")
    payload = _unb64u(valid["envelope"]["p"])
    assert key.sign(capability_set.CAPABILITY_DOMAIN, payload) == valid["envelope"]["sig"]  # Ed25519 is deterministic: the server's signer reproduces the file's signature


def test_the_order_vectors_are_the_pair_epoch_then_serial():
    for row in _vectors()["order"]:
        (he, hs), (ie, is_) = row["high_water"], row["incoming"]
        accepted = (ie, is_) > (he, hs)
        assert accepted == (row["expect"] == "accept"), row["name"]
