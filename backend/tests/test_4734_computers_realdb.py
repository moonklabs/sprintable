"""story 4734 (design 4734-pairing-unit · PO OK 10-20 · 까디르 렌즈) — the COMPUTER is the unit a person sees: one line, one phone-removal, one disconnect.

Real database. The server stores no computer row: a computer's id is derived from each setup's `machine_key` and `confirmed_by` (the pure grouping is
pinned in test_4734_computers.py). These tests pin what the people see:

- `GET /desktop/computers`: one item per computer (a Mac with a hundred setups is one line); the limit counts computers, not setups; the
  keyless lines of older apps join the one machine that has their name and person.
- `GET /desktop/startable` keeps its shape (one entry per setup — the phone shell reads an entry by `setup_id`) and only gains `computer_id`.
- `DELETE /remote-devices/{phone}/computers/{computer}`: the phone's pair with every setup of the computer, once.
- `DELETE /desktop/computers/{computer}`: every connected setup of it, all or none; the paired phones lose it (a disconnected setup holds no pair).
- `GET /desktop/relay/setup` names the phones a PERSON removed from a setup of the computer (the device's one-time merge leaves them out).
"""
from __future__ import annotations

import base64
import hashlib
import uuid
from datetime import datetime, timezone

import pytest

from app.core.config import settings
from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    EXISTING,
    ORG,
    ORG2,
    OUTSIDER,
    OWNER,
    OWNER_TM,
    PLAIN,
    _client,
    _confirm,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4533_agent_permissions_realdb import _plain_member  # noqa: F401 — helper only (importing it does not collect that module's tests)
from tests.test_4565_attach_existing_agent_realdb import attachable  # noqa: F401 — fixture (movable builds on it)
from tests.test_4576_move_setup_realdb import EXISTING_B, _move, _move_code, movable  # noqa: F401

pytestmark = pytest.mark.anyio

SECRET = "test-desktop-machine-key-secret-value-4734"
MAC_1 = "a" * 64
MAC_2 = "b" * 64
OTHER_PERSON = uuid.UUID("d4734000-0000-0000-0000-0000000000f1")
PHONES = "/api/v2/remote-devices"
EXCHANGE = "/api/v2/desktop/setup-codes/exchange"


@pytest.fixture(autouse=True)
def _addresses(monkeypatch):
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.d4734.test/mcp")
    monkeypatch.setenv("FASTAPI_URL", "https://api.d4734.test")


@pytest.fixture(autouse=True)
async def _remote_control_on(world):
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'")
    yield


@pytest.fixture(autouse=True)
async def _agents(movable):
    yield


@pytest.fixture
def secret(monkeypatch):
    monkeypatch.setattr(settings, "channel_oauth_state_secret", SECRET)
    return SECRET


def _tok(token: str) -> dict:
    return {"x-desktop-device-token": token}


async def _row(name: str, machine_key: str | None, *, by: uuid.UUID = OWNER, minutes_ago: int = 0, org: uuid.UUID = ORG) -> str:
    """A connected setup row written directly (a handed-over setup; no agents) — for the shape of the lists, where a hundred real exchanges would only be noise."""
    sid = uuid.uuid4()
    mk = f"'{machine_key}'" if machine_key else "NULL"
    await _sql(
        "INSERT INTO desktop_setups (id, code_hash, code_challenge, device_name, expires_at, org_id, confirmed_by, confirmed_at, exchanged_at, machine_key, members) "
        f"VALUES ('{sid}', '{uuid.uuid4().hex}', 'x', '{name}', now() + interval '1 hour', '{org}', '{by}', now() - interval '{minutes_ago} minutes', "
        f"now() - interval '{minutes_ago} minutes', {mk}, '[]'::jsonb)"
    )
    return str(sid)


async def _computers(c, who=OWNER, org=ORG) -> dict:
    r = await c.get("/api/v2/desktop/computers", headers=_person(who, org))
    assert r.status_code == 200, r.text
    return r.json()


async def test_a_mac_with_many_setups_is_one_line_other_macs_and_other_people_are_their_own(world):
    async with _client() as c:
        for i in range(12):
            await _row("SYJ-MacBook-Pro", MAC_1, minutes_ago=10 + i)
        await _row("SYJ-MacBook-Pro", MAC_2, minutes_ago=5)
        await _row("SYJ-MacBook-Pro", MAC_1, by=OTHER_PERSON, minutes_ago=6)  # the same Mac, another person's setup: another computer
        body = await _computers(c)
        assert len(body["computers"]) == 3 and body["truncated"] is False
        big = max(body["computers"], key=lambda x: len(x["setups"]))
        assert len(big["setups"]) == 12 and big["live_setups"] == 12 and big["state"] == "handed_over"
        assert sorted(len(x["setups"]) for x in body["computers"]) == [1, 1, 12]
        # newest line first: the computer's place is its newest setup's
        assert [x["setups"][0]["setup_id"] for x in body["computers"]][0] == body["computers"][0]["setups"][0]["setup_id"]
        assert body["computers"][0]["device_name"] == "SYJ-MacBook-Pro"
        # every setup is in exactly one computer
        ids = [s["setup_id"] for x in body["computers"] for s in x["setups"]]
        assert len(ids) == len(set(ids)) == 14


async def test_a_line_from_an_older_app_with_no_machine_key_joins_the_one_machine_with_its_name_and_person(world):
    async with _client() as c:
        await _row("Studio Mac", MAC_1, minutes_ago=30)
        await _row("studio mac ", None, minutes_ago=20)  # older app: same name (trimmed, case-folded), same person → that Mac
        await _row("Other Mac", None, minutes_ago=10)  # no machine carries this name → its own computer
        await _row("Other Mac", None, minutes_ago=9)  # …and two keyless lines of it are one
        body = await _computers(c)
        assert sorted(len(x["setups"]) for x in body["computers"]) == [2, 2]
        assert {x["device_name"] for x in body["computers"]} == {"studio mac ", "Other Mac"}  # each computer is named by its newest setup


async def test_the_limit_counts_computers_so_one_busy_mac_cannot_push_the_others_out(world, monkeypatch):
    from app.services import desktop_computers

    monkeypatch.setattr(desktop_computers, "LIST_COMPUTERS_MAX", 2)
    async with _client() as c:
        for i in range(30):
            await _row("Busy Mac", MAC_1, minutes_ago=1 + i)
        await _row("Quiet Mac", MAC_2, minutes_ago=100)
        await _row("Oldest Mac", "c" * 64, minutes_ago=200)
        body = await _computers(c)
        assert body["truncated"] is True and len(body["computers"]) == 2
        assert [len(x["setups"]) for x in body["computers"]] == [30, 1]  # the busy Mac whole, the next Mac still there; the oldest is cut by the COMPUTER limit


async def test_another_orgs_admin_sees_none_of_it_and_cannot_disconnect_it(world):
    async with _client() as c:
        await _row("Org Mac", MAC_1)
        mine = (await _computers(c))["computers"][0]["computer_id"]
        assert (await _computers(c, OUTSIDER, ORG2))["computers"] == []
        gone = await c.delete(f"/api/v2/desktop/computers/{mine}", headers=_person(OUTSIDER, ORG2))
        assert gone.status_code == 404, gone.text
        still = await c.get("/api/v2/desktop/computers", headers=_person(OWNER))
        assert still.json()["computers"][0]["state"] == "handed_over"  # nothing of it moved


# ── with real setups and phones ───────────────────────────────────────────────────────────────────────────────────


def _phone_key() -> tuple[str, bytes]:
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    der = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    return base64.urlsafe_b64encode(der).rstrip(b"=").decode(), der


def _fp(der: bytes) -> str:
    return "sha256:" + hashlib.sha256(der).hexdigest()


async def _device(c, name: str, device_id: str, *agents: uuid.UUID) -> dict:
    code, verifier, _setup_id = await _move_code(c, name)
    assert (await _confirm(c, code, body=_move(*(agents or (EXISTING,))))).status_code == 200
    r = await c.post(EXCHANGE, json={"code": code, "verifier": verifier, "device_id": device_id})
    assert r.status_code == 200, r.text
    return r.json()


async def _register(c) -> tuple[str, bytes]:
    key, der = _phone_key()
    r = await c.post(PHONES, json={"label": "iPhone", "public_key": key}, headers=_person(OWNER))
    assert r.status_code == 201, r.text
    return r.json()["id"], der


async def _report(c, token: str, *ders: bytes) -> None:
    at = datetime.now(timezone.utc).isoformat()
    r = await c.put("/api/v2/desktop/relay/pairings", json={"pairings": [{"phone_key_fingerprint": _fp(d), "paired_at": at} for d in ders]},
                    headers=_tok(token))
    assert r.status_code == 200, r.text


async def _two_setups_one_mac(c) -> tuple[dict, dict, str]:
    """Two live setups of one Mac (two agents → two lanes, the 4660 rule keeps both) and the computer id they share."""
    a = await _device(c, "d4734 mac", MAC_1, EXISTING)
    b = await _device(c, "d4734 mac", MAC_1, EXISTING_B)
    body = await _computers(c)
    assert len(body["computers"]) == 1, body
    return a, b, body["computers"][0]["computer_id"]


async def test_startable_keeps_one_entry_per_setup_in_the_old_shape_and_only_gains_computer_id(world, secret):
    async with _client() as c:
        a, b, computer = await _two_setups_one_mac(c)
        phone, der = await _register(c)
        await _report(c, a["device_token"], der)
        await _report(c, b["device_token"], der)
        # story 4714 (policy): the phone lists only an agent whose conversation the person can open — this test is about the shape, so the agents talk to everyone
        await _sql("UPDATE members SET message_policy_mode = 'org_wide' WHERE type = 'agent' AND org_id IN (SELECT org_id FROM desktop_setups WHERE id IN (:a, :b))",
                   params={"a": a["setup_id"], "b": b["setup_id"]})
        r = await c.get(f"/api/v2/desktop/startable?phone_key_id={phone}", headers=_person(OWNER))
        assert r.status_code == 200, r.text
        entries = r.json()["computers"]
        # the phone shell finds an entry by `setup_id` and reads reachable → agents → can_command → projects inside THAT entry: entries are not merged
        assert sorted(e["setup_id"] for e in entries) == sorted([a["setup_id"], b["setup_id"]])
        for e in entries:
            assert {"setup_id", "device_name", "reachable", "agents"} <= set(e)  # the old shape is all still there
            assert e["computer_id"] == computer
            for ag in e["agents"]:
                assert {"agent_member_id", "name", "can_command", "projects", "running"} <= set(ag)  # the agent entry is as it was too
        assert any(e["agents"] for e in entries), r.text  # (a setup whose agent the person cannot see lists none — as before)
        assert set(r.json()) == {"remote_control", "computers"}  # nothing else was added at the top


async def test_a_phone_removed_from_the_computer_is_removed_from_every_setup_of_it_once(world, secret):
    async with _client() as c:
        a, b, computer = await _two_setups_one_mac(c)
        phone, der = await _register(c)
        await _report(c, a["device_token"], der)
        await _report(c, b["device_token"], der)
        listed = await c.get(PHONES, headers=_person(OWNER))
        mine = next(d for d in listed.json()["devices"] if d["id"] == phone)
        assert {p["computer_id"] for p in mine["pairs"]} == {computer} and len(mine["pairs"]) == 2  # the web groups a phone's pairs by it

        gone = await c.delete(f"{PHONES}/{phone}/computers/{computer}", headers=_person(OWNER))
        assert gone.status_code == 200 and gone.json() == {"removed": True, "pairs": 2}, gone.text
        again = await c.delete(f"{PHONES}/{phone}/computers/{computer}", headers=_person(OWNER))
        assert again.status_code == 200 and again.json() == {"removed": False, "pairs": 0}, again.text  # already removed: not an error, nothing twice
        mine = next(d for d in (await c.get(PHONES, headers=_person(OWNER))).json()["devices"] if d["id"] == phone)
        assert mine["pairs"] == []
        # the phone's first screen no longer lists the computer, and each device is told to drop the key
        assert (await c.get(f"/api/v2/desktop/startable?phone_key_id={phone}", headers=_person(OWNER))).json()["computers"] == []
        rows = await _sql(fetch=f"SELECT count(*) FROM remote_device_pairings WHERE remote_device_id = '{phone}' AND removed_at IS NOT NULL AND removed_by IS NOT NULL")
        assert rows[0][0] == 2


async def test_a_phone_cannot_be_removed_from_a_computer_it_is_not_paired_with_or_of_another_org(world, secret):
    async with _client() as c:
        a, b, computer = await _two_setups_one_mac(c)
        phone, der = await _register(c)  # registered, paired with nothing
        none = await c.delete(f"{PHONES}/{phone}/computers/{computer}", headers=_person(OWNER))
        assert none.status_code == 404 and none.json()["error"]["code"] == "pairing_not_found", none.text
        other = await c.delete(f"{PHONES}/{phone}/computers/{computer}", headers=_person(OUTSIDER, ORG2))
        assert other.status_code in (403, 404), other.text


async def test_the_relay_names_the_phones_a_person_removed_from_a_setup_of_the_computer_not_the_ones_a_device_dropped(world, secret):
    async with _client() as c:
        a, b, _computer = await _two_setups_one_mac(c)
        elsewhere = await _device(c, "d4734 other mac", MAC_2, EXISTING)  # another Mac: it must not be told about this one's removals
        p, p_der = await _register(c)
        q, q_der = await _register(c)
        for dev in (a, b, elsewhere):
            await _report(c, dev["device_token"], p_der, q_der)
        # a PERSON takes P off setup A only
        assert (await c.delete(f"{PHONES}/{p}/pairs/{a['setup_id']}", headers=_person(OWNER))).json() == {"removed": True}
        # setup B's device drops Q on its own (a snapshot without it): removed_at set, removed_by null
        await _report(c, b["device_token"], p_der)
        for dev in (a, b):
            facts = await c.get("/api/v2/desktop/relay/setup", headers=_tok(dev["device_token"]))
            assert facts.status_code == 200, facts.text
            assert facts.json()["removed_phones"] == [_fp(p_der)]  # P only: a person removed it; Q was dropped by a device
            assert facts.json()["computer_id"]
        away = await c.get("/api/v2/desktop/relay/setup", headers=_tok(elsewhere["device_token"]))
        assert away.json()["removed_phones"] == []
        assert away.json()["computer_id"] != (await c.get("/api/v2/desktop/relay/setup", headers=_tok(a["device_token"]))).json()["computer_id"]


async def test_disconnecting_the_computer_ends_every_setup_of_it_at_once_and_its_paired_phones_lose_it(world, secret):
    from app.core.database import async_session_factory
    from app.services.agent_permissions import paired_phone

    async with _client() as c:
        a, b, computer = await _two_setups_one_mac(c)
        phone, der = await _register(c)
        await _report(c, a["device_token"], der)
        await _report(c, b["device_token"], der)
        member = (await _sql(fetch=f"SELECT member_id FROM remote_devices WHERE id = '{phone}'"))[0][0]
        async with async_session_factory() as s:
            assert await paired_phone(s, member_id=member, phone_id=uuid.UUID(phone), setup_id=uuid.UUID(a["setup_id"])) is not None

        done = await c.delete(f"/api/v2/desktop/computers/{computer}", headers=_person(OWNER))
        assert done.status_code == 200, done.text
        assert done.json()["setups_disconnected"] == 2 and done.json()["already_disconnected"] is False and done.json()["revoked_keys"] >= 2
        for dev in (a, b):
            rows = await _sql(fetch=f"SELECT revoked_at IS NOT NULL FROM desktop_setups WHERE id = '{dev['setup_id']}'")
            assert rows[0][0] is True
            # the device's token is refused and the paired phone holds nothing of it (the gate itself — not only the others around it)
            assert (await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 1, "sessions": []}, headers=_tok(dev["device_token"]))).status_code == 401
            async with async_session_factory() as s:
                assert await paired_phone(s, member_id=member, phone_id=uuid.UUID(phone), setup_id=uuid.UUID(dev["setup_id"])) is None
        assert (await c.get(f"/api/v2/desktop/startable?phone_key_id={phone}", headers=_person(OWNER))).json()["computers"] == []

        again = await c.delete(f"/api/v2/desktop/computers/{computer}", headers=_person(OWNER))
        assert again.status_code == 200 and again.json()["already_disconnected"] is True and again.json()["setups_disconnected"] == 0, again.text
        line = (await _computers(c))["computers"][0]
        assert line["state"] == "disconnected" and line["live_setups"] == 0  # the line stays (a person's disconnect is shown, as before)


async def test_the_computer_list_says_how_many_phones_each_setup_holds_so_a_late_setup_shows_as_fewer(world, secret):
    async with _client() as c:
        a, b, _computer = await _two_setups_one_mac(c)
        phone, der = await _register(c)
        await _report(c, a["device_token"], der)  # only A holds the pair (a daemon not yet on the computer-wide list leaves B with none)
        line = (await _computers(c))["computers"][0]
        counts = {s["setup_id"]: s["paired_phones"] for s in line["setups"]}
        assert counts == {a["setup_id"]: 1, b["setup_id"]: 0}


# ── an org past the grouping cap: nothing runs on a partial computer (codex 01a15680) ─────────────────────────────────────


async def test_past_the_grouping_cap_the_list_says_truncated_and_a_computer_wide_disconnect_refuses_and_changes_nothing(world, monkeypatch):
    from app.services import desktop_computers

    async with _client() as c:
        for i in range(5):
            await _row("Big Mac", MAC_1, minutes_ago=1 + i)
        full = await _computers(c)
        assert full["truncated"] is False
        computer = full["computers"][0]["computer_id"]
        monkeypatch.setattr(desktop_computers, "GROUP_ROWS_MAX", 3)
        cut = await _computers(c)
        assert cut["truncated"] is True  # the list knows it is partial
        gone = await c.delete(f"/api/v2/desktop/computers/{computer}", headers=_person(OWNER))
        assert gone.status_code == 409 and gone.json()["error"]["code"] == "computer_too_large", gone.text
        rows = await _sql(fetch=f"SELECT count(*) FROM desktop_setups WHERE org_id = '{ORG}' AND revoked_at IS NULL")
        assert rows[0][0] == 5  # not one of them was disconnected: all or nothing, and «nothing» when it cannot be all


async def test_past_the_grouping_cap_a_phone_is_not_removed_from_part_of_a_computer_and_the_relay_says_not_now(world, secret, monkeypatch):
    from app.services import desktop_computers

    async with _client() as c:
        a, b, computer = await _two_setups_one_mac(c)
        phone, der = await _register(c)
        await _report(c, a["device_token"], der)
        await _report(c, b["device_token"], der)
        monkeypatch.setattr(desktop_computers, "GROUP_ROWS_MAX", 1)  # the org has two setups: the grouping reads one
        refused = await c.delete(f"{PHONES}/{phone}/computers/{computer}", headers=_person(OWNER))
        assert refused.status_code == 409 and refused.json()["error"]["code"] == "computer_too_large", refused.text
        live = await _sql(fetch=f"SELECT count(*) FROM remote_device_pairings WHERE remote_device_id = '{phone}' AND removed_at IS NULL")
        assert live[0][0] == 2  # neither pair was removed
        facts = await c.get("/api/v2/desktop/relay/setup", headers=_tok(a["device_token"]))
        assert facts.status_code == 200 and facts.json()["removed_phones"] is None, facts.text  # «do not merge now» — never a short list


async def test_a_removed_phone_key_counts_as_a_phone_a_person_removed(world, secret):
    async with _client() as c:
        a, b, _computer = await _two_setups_one_mac(c)
        phone, der = await _register(c)
        await _report(c, a["device_token"], der)
        await _report(c, b["device_token"], der)
        assert (await c.delete(f"{PHONES}/{phone}", headers=_person(OWNER))).status_code == 200  # the KEY itself (revoked) — its pairs go with it, by a person
        facts = await c.get("/api/v2/desktop/relay/setup", headers=_tok(a["device_token"]))
        assert facts.json()["removed_phones"] == [_fp(der)], facts.text  # a new setup's merge leaves it out even though the key is revoked


# ── a setup exchanged while the disconnect is taking its locks (codex 01a1568d) ────────────────────────────────────────────


async def test_a_setup_exchanged_between_the_first_read_and_the_locks_makes_the_disconnect_ask_to_be_repeated_and_changes_nothing(world, monkeypatch):
    from app.services import desktop_setup

    async with _client() as c:
        for i in range(3):
            await _row("Racy Mac", MAC_1, minutes_ago=10 + i)
        computer = (await _computers(c))["computers"][0]["computer_id"]
        original = desktop_setup._lock_in_order
        racing = {"on": True}

        async def racy(db, **kw):
            if racing["on"]:
                racing["on"] = False
                await _row("Racy Mac", MAC_1, minutes_ago=0)  # the new setup commits after the computer was read and before our locks
            return await original(db, **kw)

        monkeypatch.setattr(desktop_setup, "_lock_in_order", racy)
        first = await c.delete(f"/api/v2/desktop/computers/{computer}", headers=_person(OWNER))
        assert first.status_code == 409 and first.json()["error"]["code"] == "computer_changing", first.text
        rows = await _sql(fetch=f"SELECT count(*) FROM desktop_setups WHERE org_id = '{ORG}' AND revoked_at IS NULL")
        assert rows[0][0] == 4  # nothing was disconnected (and no further lock was asked for after ours: the order member rows → setups is kept)
        again = await c.delete(f"/api/v2/desktop/computers/{computer}", headers=_person(OWNER))
        assert again.status_code == 200 and again.json()["setups_disconnected"] == 4, again.text  # the repeat takes all four
        rows = await _sql(fetch=f"SELECT count(*) FROM desktop_setups WHERE org_id = '{ORG}' AND revoked_at IS NULL")
        assert rows[0][0] == 0


async def test_a_computer_another_admin_finished_disconnecting_during_the_locks_is_reported_as_already_done(world, monkeypatch):
    from app.services import desktop_setup

    async with _client() as c:
        for i in range(2):
            await _row("Done Mac", MAC_1, minutes_ago=10 + i)
        computer = (await _computers(c))["computers"][0]["computer_id"]
        original = desktop_setup._lock_in_order
        first = {"done": False}

        async def finished_first(db, **kw):
            if not first["done"]:  # only before our own locks exist (a write from another connection would wait for them)
                first["done"] = True
                await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE org_id = '{ORG}'")  # the other admin's disconnect committed meanwhile
            return await original(db, **kw)

        monkeypatch.setattr(desktop_setup, "_lock_in_order", finished_first)
        done = await c.delete(f"/api/v2/desktop/computers/{computer}", headers=_person(OWNER))
        assert done.status_code == 200 and done.json()["already_disconnected"] is True and done.json()["setups_disconnected"] == 0, done.text


async def test_a_pair_row_pointing_at_another_orgs_setup_lists_nothing_of_it(world, secret):
    async with _client() as c:
        a, _b, _computer = await _two_setups_one_mac(c)
        phone, der = await _register(c)
        await _report(c, a["device_token"], der)
        foreign = await _row("Foreign Mac", MAC_2, org=ORG2, by=OUTSIDER)
        # an inconsistent row (nothing writes it; a restore or a hand edit might): this org's phone «paired» with a setup of another org
        await _sql(f"INSERT INTO remote_device_pairings (id, remote_device_id, setup_id, paired_at) VALUES (gen_random_uuid(), '{phone}', '{foreign}', now())")
        mine = next(d for d in (await c.get(PHONES, headers=_person(OWNER))).json()["devices"] if d["id"] == phone)
        assert [p["setup_id"] for p in mine["pairs"]] == [a["setup_id"]]  # the other org's setup name and id are not shown


async def test_a_computer_another_admin_finished_disconnecting_during_the_locks_is_reported_as_already_done(world, monkeypatch):
    from app.services import desktop_setup

    async with _client() as c:
        for i in range(2):
            await _row("Done Mac", MAC_1, minutes_ago=10 + i)
        computer = (await _computers(c))["computers"][0]["computer_id"]
        original = desktop_setup._lock_in_order

        first = {"done": False}

        async def finished_first(db, **kw):
            if not first["done"]:  # only before our own locks exist (a write from another connection would wait for them)
                first["done"] = True
                await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE org_id = '{ORG}'")  # the other admin's disconnect committed meanwhile
            return await original(db, **kw)

        monkeypatch.setattr(desktop_setup, "_lock_in_order", finished_first)
        done = await c.delete(f"/api/v2/desktop/computers/{computer}", headers=_person(OWNER))
        assert done.status_code == 200 and done.json()["already_disconnected"] is True and done.json()["setups_disconnected"] == 0, done.text


# ── who may do what (codex 01a156dd: the guards were not pinned) ─────────────────────────────────────────────────────────────


async def test_an_org_member_who_is_not_an_admin_can_neither_list_nor_disconnect_computers(world):
    await _plain_member()
    async with _client() as c:
        await _row("Admin Mac", MAC_1)
        computer = (await _computers(c))["computers"][0]["computer_id"]
        listed = await c.get("/api/v2/desktop/computers", headers=_person(PLAIN))
        assert listed.status_code == 403 and listed.json()["error"]["code"] == "not_org_admin", listed.text
        gone = await c.delete(f"/api/v2/desktop/computers/{computer}", headers=_person(PLAIN))
        assert gone.status_code == 403 and gone.json()["error"]["code"] == "not_org_admin", gone.text
        rows = await _sql(fetch=f"SELECT count(*) FROM desktop_setups WHERE org_id = '{ORG}' AND revoked_at IS NULL")
        assert rows[0][0] == 1


async def test_only_the_phones_owner_or_an_admin_removes_it_from_a_computer(world, secret):
    await _plain_member()
    async with _client() as c:
        a, b, computer = await _two_setups_one_mac(c)
        owners, owners_der = await _register(c)  # the OWNER's phone
        plains_key, plains_der = _phone_key()
        reg = await c.post(PHONES, json={"label": "Plain phone", "public_key": plains_key}, headers=_person(PLAIN))
        assert reg.status_code == 201, reg.text
        plains = reg.json()["id"]
        for dev in (a, b):
            await _report(c, dev["device_token"], owners_der, plains_der)
        # a non-admin member cannot take the OWNER's phone off the computer — the same answer as for a phone that is not there
        no = await c.delete(f"{PHONES}/{owners}/computers/{computer}", headers=_person(PLAIN))
        assert no.status_code == 404 and no.json()["error"]["code"] == "pairing_not_found", no.text
        live = await _sql(fetch=f"SELECT count(*) FROM remote_device_pairings WHERE remote_device_id = '{owners}' AND removed_at IS NULL")
        assert live[0][0] == 2  # untouched
        # …but their own phone, yes
        mine = await c.delete(f"{PHONES}/{plains}/computers/{computer}", headers=_person(PLAIN))
        assert mine.status_code == 200 and mine.json() == {"removed": True, "pairs": 2}, mine.text
        # and an admin may take the member's phone off (it is not theirs, the org's admin may)
        # (the phone is already off: the admin gets the idempotent answer, not a refusal)
        admin = await c.delete(f"{PHONES}/{plains}/computers/{computer}", headers=_person(OWNER))
        assert admin.status_code == 200 and admin.json() == {"removed": False, "pairs": 0}, admin.text


async def test_the_second_grouping_read_under_the_locks_can_find_the_org_past_the_cap_and_that_is_a_409_not_a_500(world, monkeypatch):
    from app.services import desktop_computers, desktop_setup

    async with _client() as c:
        for i in range(3):
            await _row("Cap Mac", MAC_1, minutes_ago=10 + i)
        computer = (await _computers(c))["computers"][0]["computer_id"]
        original = desktop_setup._lock_in_order
        armed = {"on": True}

        async def past_the_cap(db, **kw):
            if armed["on"]:
                armed["on"] = False
                monkeypatch.setattr(desktop_computers, "GROUP_ROWS_MAX", 1)  # setups landed meanwhile: the next read finds more rows than it may group
            return await original(db, **kw)

        monkeypatch.setattr(desktop_setup, "_lock_in_order", past_the_cap)
        gone = await c.delete(f"/api/v2/desktop/computers/{computer}", headers=_person(OWNER))
        assert gone.status_code == 409 and gone.json()["error"]["code"] == "computer_too_large", gone.text
        monkeypatch.setattr(desktop_computers, "GROUP_ROWS_MAX", 20000)
        rows = await _sql(fetch=f"SELECT count(*) FROM desktop_setups WHERE org_id = '{ORG}' AND revoked_at IS NULL")
        assert rows[0][0] == 3


async def test_the_removed_phones_of_a_setup_come_from_one_grouping_read_so_a_regrouping_between_reads_cannot_hide_a_removal(world, secret, monkeypatch):
    from app.services import desktop_computers

    async with _client() as c:
        a, b, _computer = await _two_setups_one_mac(c)
        p, p_der = await _register(c)
        for dev in (a, b):
            await _report(c, dev["device_token"], p_der)
        assert (await c.delete(f"{PHONES}/{p}/pairs/{a['setup_id']}", headers=_person(OWNER))).json() == {"removed": True}
        original = desktop_computers.org_setup_facts
        calls = {"n": 0}

        async def regrouped(db, org_id):
            facts, capped = await original(db, org_id)
            calls["n"] += 1
            if calls["n"] <= 2:  # the route's own read for `computer_id`, then the removal list's single grouping read
                return facts, capped
            # a THIRD read would see the lines regrouped (a keyless line remapped): other computer ids, other names
            return [desktop_computers.SetupFacts(f.id, None, f.confirmed_by, f"renamed {i}", f.confirmed_at) for i, f in enumerate(facts)], capped

        monkeypatch.setattr(desktop_computers, "org_setup_facts", regrouped)
        facts = await c.get("/api/v2/desktop/relay/setup", headers=_tok(b["device_token"]))
        assert facts.status_code == 200, facts.text
        assert facts.json()["removed_phones"] == [_fp(p_der)], facts.text  # one grouping read for both «my computer» and «its siblings»: the veto stands


async def test_a_computer_regrouped_between_the_read_and_the_locks_is_not_reported_as_already_disconnected(world, monkeypatch):
    from app.services import desktop_setup

    async with _client() as c:
        for i in range(2):
            await _row("Remap Mac", None, minutes_ago=10 + i)  # two keyless lines: one computer by (name, person)
        computer = (await _computers(c))["computers"][0]["computer_id"]
        original = desktop_setup._lock_in_order
        armed = {"on": True}

        async def remap(db, **kw):
            if armed["on"]:
                armed["on"] = False
                await _row("Remap Mac", MAC_1, minutes_ago=0)  # a keyed setup with the same name and person: the keyless lines now belong to ITS computer
            return await original(db, **kw)

        monkeypatch.setattr(desktop_setup, "_lock_in_order", remap)
        gone = await c.delete(f"/api/v2/desktop/computers/{computer}", headers=_person(OWNER))
        assert gone.status_code == 409 and gone.json()["error"]["code"] == "computer_changing", gone.text  # not «already disconnected» while three lines are still connected
        rows = await _sql(fetch=f"SELECT count(*) FROM desktop_setups WHERE org_id = '{ORG}' AND revoked_at IS NULL")
        assert rows[0][0] == 3


# ── the pins the lens review (Kadir, 10-20) named: lines that no test held ───────────────────────────────────────────────────


async def _foreign_phone() -> tuple[str, bytes]:
    """a phone key of ANOTHER organization (ORG2), written directly — a row nothing writes in the product, the shape a restore or a hand edit could leave"""
    key, der = _phone_key()
    pid = uuid.uuid4()
    await _sql(
        "INSERT INTO remote_devices (id, member_id, org_id, label, public_key, fingerprint) "
        f"VALUES ('{pid}', '{OWNER_TM}', '{ORG2}', 'foreign', '{key}', '{_fp(der)}')"
    )
    return str(pid), der


async def test_removed_phones_never_names_a_phone_key_of_another_organization(world, secret):
    async with _client() as c:
        a, b, _computer = await _two_setups_one_mac(c)
        foreign, der = await _foreign_phone()
        await _sql(
            "INSERT INTO remote_device_pairings (id, remote_device_id, setup_id, paired_at, removed_at, removed_by) "
            f"VALUES (gen_random_uuid(), '{foreign}', '{a['setup_id']}', now(), now(), '{OWNER_TM}')"
        )
        facts = await c.get("/api/v2/desktop/relay/setup", headers=_tok(b["device_token"]))
        assert facts.status_code == 200 and facts.json()["removed_phones"] == [], facts.text  # reverted (no organization filter on the phone) → names the foreign key


async def test_removed_phones_ignores_what_was_removed_on_a_disconnected_sibling(world, secret):
    async with _client() as c:
        a, b, _computer = await _two_setups_one_mac(c)
        phone, der = await _register(c)
        dead = await _row("d4734 mac", None)  # a keyless line of the same name and person: the same computer
        await _sql(
            "INSERT INTO remote_device_pairings (id, remote_device_id, setup_id, paired_at, removed_at, removed_by) "
            f"VALUES (gen_random_uuid(), '{phone}', '{dead}', now(), now(), '{OWNER_TM}')"
        )
        live = await c.get("/api/v2/desktop/relay/setup", headers=_tok(a["device_token"]))
        assert live.json()["removed_phones"] == [_fp(der)], live.text  # while that sibling is connected, its person-removal counts
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{dead}'")
        gone = await c.get("/api/v2/desktop/relay/setup", headers=_tok(a["device_token"]))
        assert gone.json()["removed_phones"] == [], gone.text  # …and once it is disconnected it is not a sibling any more (reverted: live_only off → still named)


async def test_a_phone_of_another_organization_cannot_be_removed_from_a_computer_by_that_organizations_admin(world, secret):
    async with _client() as c:
        a, b, _computer = await _two_setups_one_mac(c)
        phone, der = await _register(c)  # the OWNER's phone, in ORG
        # the other organization's admin needs a member row for the phone routes to take them as a person at all (else every answer is 404 and this test pins nothing)
        out_tm = (await _sql(fetch=f"SELECT id FROM org_members WHERE org_id = '{ORG2}' AND user_id = '{OUTSIDER}'"))[0][0]  # (the member row shares the org-member row's id, as the owner's does)
        await _sql(f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{out_tm}','{ORG2}','{OUTSIDER}','human','Outsider',true)")
        theirs = await _row("Org2 Mac", MAC_2, org=ORG2, by=OUTSIDER)
        computer2 = (await _computers(c, OUTSIDER, ORG2))["computers"][0]["computer_id"]
        # an inconsistent row nothing writes: ORG's phone «paired» with ORG2's setup — ORG2's admin knows the computer, not the phone
        await _sql(f"INSERT INTO remote_device_pairings (id, remote_device_id, setup_id, paired_at) VALUES (gen_random_uuid(), '{phone}', '{theirs}', now())")
        r = await c.delete(f"{PHONES}/{phone}/computers/{computer2}", headers=_person(OUTSIDER, ORG2))
        # control: the same admin removing a phone of THEIR organization from that computer succeeds (so the 404 below is the phone's organization, not the caller)
        mine_key, mine_der = _phone_key()
        mine_phone = uuid.uuid4()
        await _sql(f"INSERT INTO remote_devices (id, member_id, org_id, label, public_key, fingerprint) VALUES ('{mine_phone}', '{out_tm}', '{ORG2}', 'theirs', '{mine_key}', '{_fp(mine_der)}')")
        await _sql(f"INSERT INTO remote_device_pairings (id, remote_device_id, setup_id, paired_at) VALUES (gen_random_uuid(), '{mine_phone}', '{theirs}', now())")
        ok = await c.delete(f"{PHONES}/{mine_phone}/computers/{computer2}", headers=_person(OUTSIDER, ORG2))
        assert ok.status_code == 200 and ok.json()["pairs"] == 1, ok.text
        assert r.status_code == 404, (r.status_code, r.text)  # the phone is not in ORG2: reverted (phone looked up without its organization) → 200 and the pair is removed
        live = await _sql(fetch=f"SELECT count(*) FROM remote_device_pairings WHERE remote_device_id = '{phone}' AND setup_id = '{theirs}' AND removed_at IS NULL")
        assert live[0][0] == 1


async def test_a_line_a_new_setup_replaced_is_not_a_computers_line(world):
    async with _client() as c:
        live = await _row("Replaced Mac", MAC_1, minutes_ago=5)
        old = await _row("Replaced Mac", MAC_1, minutes_ago=50)
        await _sql(f"UPDATE desktop_setups SET revoked_at = now(), revoked_reason = 'replaced_by_new_setup' WHERE id = '{old}'")  # what story 4660 does to the older line
        body = await _computers(c)
        assert [[s["setup_id"] for s in x["setups"]] for x in body["computers"]] == [[live]]  # reverted (the 4660 filter) → the replaced line is listed too


async def test_the_services_check_the_admin_role_themselves_not_only_the_routes(world):
    from app.core.database import async_session_factory
    from app.services.desktop_computers import list_computers, revoke_computer
    from app.services.desktop_setup import DesktopSetupError

    await _plain_member()
    async with _client() as c:
        await _row("Admin Mac", MAC_1)
        computer = (await _computers(c))["computers"][0]["computer_id"]
    async with async_session_factory() as s:
        with pytest.raises(DesktopSetupError) as listed:
            await list_computers(s, user_id=PLAIN, org_id=ORG)
        assert listed.value.code == "not_org_admin"
        with pytest.raises(DesktopSetupError) as gone:
            await revoke_computer(s, computer_id=uuid.UUID(computer), user_id=PLAIN, org_id=ORG)
        assert gone.value.code == "not_org_admin"  # the second gate (the route has its own): reverted → a caller that skips the route could disconnect
    # the setup's own disconnect checks the role too, so the service-level gate is only seen where nothing is left to disconnect: an emptied computer must not answer a plain member «already disconnected»
    await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE org_id = '{ORG}'")
    async with async_session_factory() as s:
        with pytest.raises(DesktopSetupError) as emptied:
            await revoke_computer(s, computer_id=uuid.UUID(computer), user_id=PLAIN, org_id=ORG)
        assert emptied.value.code == "not_org_admin"  # reverted (no gate of its own) → {already_disconnected: True} for anyone
    rows = await _sql(fetch=f"SELECT count(*) FROM desktop_setups WHERE org_id = '{ORG}' AND revoked_at IS NULL")
    assert rows[0][0] == 0  # (only the row this test ended itself)


# ── 4734 follow-up (lens note · PO 10-20): the RANGE of the lock a press takes · what the relay says is still vetoed NOW ──────────────────


async def test_a_press_lock_holds_exactly_the_phone_key_and_its_pairing_shared_and_nothing_else(world, secret):
    """`paired_phone(lock=True)` — the check a signed press relies on (4733) — holds the phone key row and the pairing row with a SHARE lock until the transaction ends:
    a removal or a revocation that comes meanwhile waits. It must NOT hold the setup row, another setup's row, or the person's member row (a disconnect, a re-grouping or
    a member update must not wait for a press), and it must stay SHARED (two presses must not wait for each other). The second transaction probes with FOR UPDATE / FOR SHARE NOWAIT."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    from app.core.database import async_session_factory
    from app.services.agent_permissions import paired_phone
    from tests.test_4424_desktop_setup_realdb import _ASYNC

    async with _client() as c:
        a, b, _computer = await _two_setups_one_mac(c)
        phone, der = await _register(c)
        await _report(c, a["device_token"], der)
    sid, other = uuid.UUID(a["setup_id"]), uuid.UUID(b["setup_id"])

    async def probe(sql: str):
        eng = create_async_engine(_ASYNC, poolclass=NullPool)
        try:
            async with eng.begin() as conn:
                return (await conn.execute(text(sql))).all()
        finally:
            await eng.dispose()

    key_row = f"SELECT id FROM remote_devices WHERE id = '{phone}'"
    pair_row = f"SELECT id FROM remote_device_pairings WHERE remote_device_id = '{phone}' AND setup_id = '{sid}'"
    setup_row = f"SELECT id FROM desktop_setups WHERE id = '{sid}'"
    other_setup_row = f"SELECT id FROM desktop_setups WHERE id = '{other}'"
    member_row = f"SELECT id FROM members WHERE id = '{OWNER_TM}'"
    # positive controls: with nothing held, every row exists and can be taken exclusively (a «free» below is a row that was really read)
    for sql in (key_row, pair_row, setup_row, other_setup_row, member_row):
        assert len(await probe(sql + " FOR UPDATE NOWAIT")) == 1, sql

    async with async_session_factory() as s:
        held = await paired_phone(s, member_id=OWNER_TM, phone_id=uuid.UUID(phone), setup_id=sid, lock=True)
        assert held is not None  # the check passed and the lock is taken (the transaction stays open)
        for sql in (key_row, pair_row):  # held: an exclusive lock cannot be had, and does not wait
            with pytest.raises(Exception, match="could not obtain lock"):
                await probe(sql + " FOR UPDATE NOWAIT")
            assert len(await probe(sql + " FOR SHARE NOWAIT")) == 1, sql  # …but it is SHARED: another press shares it
        for sql in (setup_row, other_setup_row, member_row):  # free: a disconnect, a re-grouping or a member update never waits for a press
            assert len(await probe(sql + " FOR UPDATE NOWAIT")) == 1, sql
        await s.rollback()
    for sql in (key_row, pair_row):  # released with the transaction
        assert len(await probe(sql + " FOR UPDATE NOWAIT")) == 1, sql


async def test_the_relay_names_the_phones_that_are_removed_and_not_paired_again_so_a_phone_paired_again_is_not_vetoed_for_ever(world, secret):
    """`removed_phones` keeps naming a phone a person removed from ANY connected setup of the computer — also after it was paired again, when a setup that never reports again (an
    old one this Mac does not run) keeps its removal for good. `removed_phones_now` is the same list minus the phones some connected setup of the computer holds an ACTIVE pairing of."""
    async with _client() as c:
        a, b, computer = await _two_setups_one_mac(c)
        p, p_der = await _register(c)
        q, q_der = await _register(c)
        for dev in (a, b):
            await _report(c, dev["device_token"], p_der, q_der)

        async def facts(dev):
            r = await c.get("/api/v2/desktop/relay/setup", headers=_tok(dev["device_token"]))
            assert r.status_code == 200, r.text
            return r.json()

        before = await facts(a)
        assert before["removed_phones"] == [] and before["removed_phones_now"] == []
        # a person removes P from the whole computer (both setups' pairs), and Q from setup A only (B still holds it)
        assert (await c.delete(f"{PHONES}/{p}/computers/{computer}", headers=_person(OWNER))).json() == {"removed": True, "pairs": 2}
        assert (await c.delete(f"{PHONES}/{q}/pairs/{a['setup_id']}", headers=_person(OWNER))).json() == {"removed": True}
        for dev in (a, b):
            f = await facts(dev)
            assert f["removed_phones"] == sorted([_fp(p_der), _fp(q_der)]), f  # both were removed by a person from some setup of it
            assert f["removed_phones_now"] == [_fp(p_der)], f  # P is gone from the computer · Q is still paired with it through B (reverted: both → Q is taken away)
        # setup A's daemon drops P (it heard the removal: the removal is acked), then P is paired again through a QR on this Mac and A reports it; B's daemon never does
        # (an old setup this Mac does not run)
        await _report(c, a["device_token"], q_der)
        await _report(c, a["device_token"], p_der, q_der)
        for dev in (a, b):
            f = await facts(dev)
            assert f["removed_phones"] == sorted([_fp(p_der), _fp(q_der)]), f  # B's removal of P stays on the books for good
            assert f["removed_phones_now"] == [], f  # …but P is paired with the computer again: not vetoed (reverted: P would be taken away on every connect)


async def test_removed_phones_now_a_revoked_key_has_no_active_pairing_so_it_stays_vetoed_and_another_mac_is_not_told(world, secret):
    async with _client() as c:
        a, b, _computer = await _two_setups_one_mac(c)
        p, p_der = await _register(c)
        await _report(c, a["device_token"], p_der)
        await _report(c, b["device_token"], p_der)
        assert (await c.delete(f"{PHONES}/{p}", headers=_person(OWNER))).status_code == 200  # the KEY is revoked: its pairs are removed by a person
        marked = await _sql(fetch=f"SELECT count(*) FROM remote_device_pairings WHERE remote_device_id = '{p}' AND removed_at IS NOT NULL AND removed_by IS NOT NULL")
        assert marked[0][0] == 2  # (the premise, read from the rows: both pairs are marked removed by a person)
        f = (await c.get("/api/v2/desktop/relay/setup", headers=_tok(a["device_token"]))).json()
        assert f["removed_phones"] == [_fp(p_der)] and f["removed_phones_now"] == [_fp(p_der)], f  # a revoked key has no active pairing: vetoed
        elsewhere = await _device(c, "d4734 other mac now", MAC_2, EXISTING)
        away = (await c.get("/api/v2/desktop/relay/setup", headers=_tok(elsewhere["device_token"]))).json()
        assert away["removed_phones"] == [] and away["removed_phones_now"] == [], away  # another Mac is not told


async def test_removed_phones_now_an_active_pairing_on_ANOTHER_computer_does_not_bring_the_phone_back_to_this_one(world, secret):
    async with _client() as c:
        a, b, computer = await _two_setups_one_mac(c)
        elsewhere = await _device(c, "d4734 other mac now2", MAC_2, EXISTING)  # another Mac of the same person and organization
        p, p_der = await _register(c)
        for dev in (a, b, elsewhere):
            await _report(c, dev["device_token"], p_der)
        # a person takes P off THIS computer; the other Mac still holds it (a phone can be paired with several computers)
        assert (await c.delete(f"{PHONES}/{p}/computers/{computer}", headers=_person(OWNER))).json() == {"removed": True, "pairs": 2}
        still = await _sql(fetch=f"SELECT count(*) FROM remote_device_pairings WHERE remote_device_id = '{p}' AND removed_at IS NULL")
        assert still[0][0] == 1  # the premise: exactly the other Mac's pairing is active
        for dev in (a, b):
            f = (await c.get("/api/v2/desktop/relay/setup", headers=_tok(dev["device_token"]))).json()
            assert f["removed_phones"] == [_fp(p_der)] and f["removed_phones_now"] == [_fp(p_der)], f  # reverted (the active set not limited to this computer): [] — P would come back


async def test_removed_phones_now_counts_the_active_pairing_of_a_connected_sibling_only_not_a_disconnected_one(world, secret):
    async with _client() as c:
        a, b, computer = await _two_setups_one_mac(c)
        p, p_der = await _register(c)
        await _report(c, a["device_token"], p_der)
        await _report(c, b["device_token"], p_der)
        dead = await _row("d4734 mac", None)  # a keyless line of the same name and person: a third setup of the same computer
        assert (await c.delete(f"{PHONES}/{p}/computers/{computer}", headers=_person(OWNER))).status_code == 200
        await _sql(
            "INSERT INTO remote_device_pairings (id, remote_device_id, setup_id, paired_at) "
            f"VALUES (gen_random_uuid(), '{p}', '{dead}', now())"  # …which holds P ACTIVE (a pairing nobody removed)
        )
        live = (await c.get("/api/v2/desktop/relay/setup", headers=_tok(a["device_token"]))).json()
        assert live["removed_phones"] == [_fp(p_der)] and live["removed_phones_now"] == [], live  # positive control: a connected sibling holding it active is paired evidence
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{dead}'")
        gone = (await c.get("/api/v2/desktop/relay/setup", headers=_tok(a["device_token"]))).json()
        assert gone["removed_phones"] == [_fp(p_der)] and gone["removed_phones_now"] == [_fp(p_der)], gone  # disconnected: it holds no pair any more (reverted: live_only off → [])


async def test_past_the_grouping_cap_removed_phones_now_is_null_like_removed_phones(world, secret, monkeypatch):
    from app.services import desktop_computers

    async with _client() as c:
        a, b, _computer = await _two_setups_one_mac(c)
        monkeypatch.setattr(desktop_computers, "GROUP_ROWS_MAX", 1)
        f = (await c.get("/api/v2/desktop/relay/setup", headers=_tok(a["device_token"]))).json()
        assert f["removed_phones"] is None and f["removed_phones_now"] is None, f  # «not now» for both — never a short list the device acts on
