"""story 4978 (C2 · record-key handoff relay) — a SEALED `record_handoff` envelope carried between two paired devices (a computer → a new phone, a phone → a new computer): the one table (0494), who puts and who reads, the shape and the one fixed
size the server judges, the cap of eight unread, «received» deletes, and every way a row ends (a removed pairing · a revoked phone key · remote control off · expiry). The server holds an envelope it cannot open — never a key, never a word. Each
test goes red without the line it names."""
from __future__ import annotations

import base64
import logging
import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    ORG2,
    OUTSIDER,
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
from tests.test_4533_agent_permissions_realdb import PHONES, _pair, _phone_key, _plain_member, _register
from tests.test_4534_desktop_commands_realdb import _remote_control_on, _world  # noqa: F401
from tests.test_4535_org_remote_control_realdb import _switch as _remote_control_switch  # noqa: F401
from tests.test_4976_sealed_prompt_realdb import b64, now_ms

pytestmark = pytest.mark.anyio

MARK = "ZQ9-HANDOFF-LEAK-MARKER"  # what must never reach a log line or an error
CT = 14608  # the fixed width of a handoff body: the 14,592-byte frame + the 16-byte tag
H2P = "/api/v2/desktop/relay/record-handoffs"


def _nonce() -> str:
    return base64.urlsafe_b64encode(uuid.uuid4().bytes).rstrip(b"=").decode()  # 16 bytes → 22 characters


def _env(sid, *, ct=CT, **over):
    ts = now_ms()
    key = over.pop("command_id", None) or _nonce()
    env = {
        "v": 1, "kind": "record_handoff", "setup_id": str(sid), "session_key": "", "command_id": key, "expires_at": ts + 300_000,
        "from": "host-1", "to": ["phone-1"], "epoch": 1, "ctr": 0, "ts": ts, "nonce": b64(16),
        "wraps": [{"to": "phone-1", "enc": b64(32), "ek": b64(48)}], "ct": b64(ct), "sig": b64(71),
    }
    env.update(over)
    return env


async def _register_foreign(c):
    """A phone key of a person of ANOTHER organization (the outsider is the admin of ORG2): its members row and its key row, made directly."""
    tm = (await _sql(fetch=f"SELECT id FROM org_members WHERE org_id = '{ORG2}' AND user_id = '{OUTSIDER}'"))[0][0]
    pid = str(uuid.uuid4())
    await _sql(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{tm}','{ORG2}','{OUTSIDER}','human','Outsider',true) ON CONFLICT (id) DO NOTHING",
        f"INSERT INTO remote_devices (id,member_id,org_id,label,public_key,fingerprint) VALUES ('{pid}','{tm}','{ORG2}','foreign','pk-{pid}','fp-{pid}')",
    )
    return pid


async def _sid(name):
    return (await _sql(fetch=f"SELECT id FROM desktop_setups WHERE device_name = '{name}'"))[0][0]


def _to_phone(c, device, phone, envelope=None, raw=None, headers=None):
    kw = {"content": raw} if raw is not None else {"json": {"envelope": envelope}}
    h = {**_tok(device["device_token"]), **({"content-type": "application/json"} if raw is not None else {})}
    return c.put(f"{H2P}/{phone}", headers=headers or h, **kw)


def _to_host(c, sid, phone, envelope=None, raw=None, who=OWNER, headers=None):
    kw = {"content": raw} if raw is not None else {"json": {"envelope": envelope}}
    h = {**_person(who), **({"content-type": "application/json"} if raw is not None else {})}
    return c.put(f"/api/v2/desktop/setups/{sid}/record-handoffs/{phone}", headers=headers or h, **kw)


def _host_list(c, device):
    return c.get(H2P, headers=_tok(device["device_token"]))


def _phone_list(c, phone, who=OWNER):
    return c.get("/api/v2/desktop/record-handoffs", params={"phone_key_id": phone}, headers=_person(who))


def _phone_got(c, phone, hid, who=OWNER):
    return c.post(f"/api/v2/desktop/record-handoffs/{hid}/received", params={"phone_key_id": phone}, headers=_person(who))


def _host_got(c, device, hid):
    return c.post(f"{H2P}/{hid}/received", headers=_tok(device["device_token"]))


async def _rows(sid=None):
    where = f"WHERE setup_id = '{sid}'" if sid else ""
    return await _sql(fetch=f"SELECT id, setup_id, remote_device_id, direction, command_id, envelope, expires_at - created_at FROM desktop_record_handoffs {where} ORDER BY created_at, id")


async def _computer(c, name):
    """A computer of the owner's with the owner's phone paired → (device, phone id, setup id)."""
    device, _agent, phone, der, _conv = await _world(c, name)
    _DERS[device["setup_id"]] = [der]
    return device, phone, device["setup_id"]


_DERS: dict = {}


async def _pair_also(c, device, sid, *ders):
    """The computer's pairing list is a SNAPSHOT: a second phone is added by listing both."""
    _DERS[sid] = [*_DERS[sid], *ders]
    return await _pair(c, device["device_token"], *_DERS[sid])


async def test_01_a_computer_puts_a_sealed_handoff_for_a_phone_the_phone_reads_it_and_received_deletes_it(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac a")
        env = _env(sid)
        r = await _to_phone(c, device, phone, env)
        assert r.status_code == 201, r.text
        hid = r.json()["id"]
        rows = await _rows(sid)
        assert [(str(a), str(b), str(p), d, k) for a, b, p, d, k, _e, _t in rows] == [(hid, str(sid), phone, "host_to_phone", env["command_id"])]
        assert rows[0][5] == env, "the envelope is kept exactly as it came: the server changed no word of it"
        from datetime import timedelta
        assert timedelta(minutes=15) <= rows[0][6] < timedelta(minutes=15, seconds=2), "put + 15 minutes"
        r = await _phone_list(c, phone)
        assert r.status_code == 200 and [(i["id"], i["setup_id"], i["envelope"]) for i in r.json()["items"]] == [(hid, str(sid), env)]
        assert len(await _rows(sid)) == 1, "reading deletes nothing: the phone has not said it has it"
        r = await _phone_got(c, phone, hid)
        assert r.status_code == 200 and r.json() == {"deleted": True}
        assert await _rows(sid) == [], "the server holds the ciphertext only until the receiver has it"
        assert (await _phone_got(c, phone, hid)).json() == {"deleted": False}
        assert (await _phone_list(c, phone)).json()["items"] == []


async def test_02_the_same_envelope_put_again_is_the_same_row(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac b")
        env = _env(sid)
        first = await _to_phone(c, device, phone, env)
        again = await _to_phone(c, device, phone, env)
        assert (first.status_code, again.status_code) == (201, 200) and first.json() == again.json()
        assert len(await _rows(sid)) == 1


async def test_03_what_is_not_the_shape_of_a_record_handoff_is_refused_and_never_echoed(world, caplog):
    caplog.set_level(logging.DEBUG)
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac c")
        good = _env(sid)
        bad_envelopes = [
            _env(sid, kind="send_prompt"),                                   # another kind
            {**good, "extra": MARK},                                         # not the agreed shape
            _env(sid, ct=CT - 1), _env(sid, ct=CT + 1), _env(sid, ct=4096),  # the body has ONE width: its size tells nothing
            _env(sid, to=["a", "b"], wraps=[{"to": "a", "enc": b64(32), "ek": b64(48)}, {"to": "b", "enc": b64(32), "ek": b64(48)}]),  # one receiver
            {**good, "rec": {"conversation_id": "c", "record_id": "r", "rec_gen": 1}},  # a record handoff is no user record
            _env(sid, session_key="s-1"),                                    # no session
            _env(sid, setup_id=str(uuid.uuid4())),                           # it names another pairing
            {**good, "ct": good["ct"] + "="},                                # not canonical base64url
        ]
        for env in bad_envelopes:
            r = await _to_phone(c, device, phone, env)
            assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_record_handoff", (env.get("kind"), r.status_code, r.text)
            assert MARK not in r.text
        for raw in (b"not json", b"[]", b'{"envelope": 1}', b'{"envelope": {}}', f'{{"envelope": {__import__("json").dumps(good)}, "path": "/etc/{MARK}"}}'.encode()):
            r = await _to_phone(c, device, phone, raw=raw)
            assert r.status_code == 422, (raw[:30], r.text)
            assert MARK not in r.text
        r = await _to_phone(c, device, phone, raw=b'{"envelope": "' + b"x" * 40_000 + b'"}')
        assert r.status_code == 413 and r.json()["error"]["code"] == "record_handoff_too_large"

        async def _stream():  # no content-length: the size is judged on what has come, never on the header (and never held past the cap)
            for _ in range(40):
                yield b"x" * 1024

        r = await c.put(f"{H2P}/{phone}", content=_stream(), headers={**_tok(device["device_token"]), "content-type": "application/json"})
        assert r.status_code == 413 and r.json()["error"]["code"] == "record_handoff_too_large", "a body without a declared size is cut at the same line"
        assert await _rows(sid) == [], "none of them was kept"
        assert MARK not in caplog.text, "no refusal ever reaches a log line with what it held"


async def test_04_at_most_eight_unread_per_pair_and_direction_and_received_frees_a_place(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac d")
        other_phone, _der = await _register(c)
        await _pair_also(c, device, sid, _der)
        ids = []
        for _ in range(8):
            r = await _to_phone(c, device, phone, _env(sid))
            assert r.status_code == 201
            ids.append(r.json()["id"])
        r = await _to_phone(c, device, phone, _env(sid))
        assert r.status_code == 409 and r.json()["error"]["code"] == "handoff_queue_full"
        assert (await _to_phone(c, device, other_phone, _env(sid))).status_code == 201, "the cap is per pair: another phone is not held by it"
        assert (await _phone_got(c, phone, ids[0])).json() == {"deleted": True}
        assert (await _to_phone(c, device, phone, _env(sid))).status_code == 201
        full = [r for r in await _rows(sid) if r[3] == "host_to_phone" and str(r[2]) == phone]
        assert len(full) == 8
        again = await _to_phone(c, device, phone, full[0][5])
        assert again.status_code == 200 and again.json()["id"] == str(full[0][0]), "the retry of an envelope already held is that row — even when the queue is full"
        # the other direction has its own eight
        assert (await _to_host(c, sid, phone, _env(sid))).status_code == 201
        assert len([r for r in await _rows(sid) if r[3] == "host_to_phone" and str(r[2]) == phone]) == 8


async def test_05_only_a_phone_of_this_organization_that_is_not_revoked_takes_a_handoff(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac e")
        foreign = await _register_foreign(c)
        for who in (foreign, str(uuid.uuid4())):
            r = await _to_phone(c, device, who, _env(sid))
            assert r.status_code == 404 and r.json()["error"]["code"] == "phone_not_found", (who, r.text)
        assert (await _c_delete(c, f"/api/v2/remote-devices/{phone}")).status_code in (200, 204)
        r = await _to_phone(c, device, phone, _env(sid))
        assert r.status_code == 404 and r.json()["error"]["code"] == "phone_not_found", "a revoked phone key takes no record key"
        assert await _rows(sid) == []


async def _c_delete(c, url, who=OWNER):
    return await c.delete(url, headers=_person(who))


async def test_06_a_phone_reads_and_acknowledges_only_its_own_and_only_its_owners_session_does(world):
    plain_tm = await _plain_member()  # noqa: F841
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac f")
        plain_phone, plain_der = await _register(c, PLAIN)
        await _pair_also(c, device, sid, plain_der)
        mine = (await _to_phone(c, device, phone, _env(sid))).json()["id"]
        theirs = (await _to_phone(c, device, plain_phone, _env(sid))).json()["id"]
        assert [i["id"] for i in (await _phone_list(c, phone)).json()["items"]] == [mine]
        assert [i["id"] for i in (await _phone_list(c, plain_phone, PLAIN)).json()["items"]] == [theirs]
        r = await _phone_list(c, plain_phone, OWNER)
        assert r.status_code == 404 and r.json()["error"]["code"] == "phone_not_found", "another person's phone is not found, not forbidden"
        assert (await _phone_got(c, plain_phone, theirs, OWNER)).status_code == 404
        assert (await _phone_got(c, phone, theirs, OWNER)).json() == {"deleted": False}, "an id addressed to another phone deletes nothing"
        assert (await _phone_got(c, plain_phone, mine, PLAIN)).json() == {"deleted": False}
        assert len(await _rows(sid)) == 2
        for headers in ({}, _tok(device["device_token"]), {"Authorization": f"Bearer {device['agents'][0]['api_key']}"}):
            r = await c.get("/api/v2/desktop/record-handoffs", params={"phone_key_id": phone}, headers=headers)
            assert r.status_code in (401, 403), ("the person's road takes a person's session only", r.status_code)
        r = await c.get(H2P, headers=_person(OWNER))
        assert r.status_code in (401, 403), "the computer's road takes the device token only"


async def test_07_a_phone_puts_a_handoff_for_a_computer_of_its_organization_and_the_computer_reads_and_acknowledges_it(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac g")
        env = _env(sid, **{"from": "phone-1", "to": ["host-1"], "wraps": [{"to": "host-1", "enc": b64(32), "ek": b64(48)}]})
        r = await _to_host(c, sid, phone, env)
        assert r.status_code == 201, r.text
        hid = r.json()["id"]
        assert (await _to_host(c, sid, phone, env)).status_code == 200
        assert (await _phone_list(c, phone)).json()["items"] == [], "what a phone put for a computer is not served back to phones"
        r = await _host_list(c, device)
        assert r.status_code == 200 and [(i["id"], i["phone_key_id"], i["envelope"]) for i in r.json()["items"]] == [(hid, phone, env)]
        assert len(await _rows(sid)) == 1, "reading deletes nothing"
        assert (await _host_got(c, device, hid)).json() == {"deleted": True}
        assert await _rows(sid) == []
        assert (await _host_got(c, device, hid)).json() == {"deleted": False}


async def test_08_a_computer_reads_only_what_is_for_it_and_a_phone_puts_only_with_its_own_key_into_its_own_organization(world):
    plain_tm = await _plain_member()  # noqa: F841
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac h")
        other = await _device(c, name="d4978 mac i")
        other_sid = await _sid("d4978 mac i")
        env = _env(sid, **{"from": "phone-1", "to": ["host-1"], "wraps": [{"to": "host-1", "enc": b64(32), "ek": b64(48)}]})
        hid = (await _to_host(c, sid, phone, env)).json()["id"]
        assert (await _host_list(c, other)).json()["items"] == [], "another computer sees nothing of it"
        assert (await _host_got(c, other, hid)).json() == {"deleted": False}
        assert len(await _rows(sid)) == 1
        plain_phone, _der = await _register(c, PLAIN)
        r = await _to_host(c, sid, plain_phone, env, who=OWNER)
        assert r.status_code == 404 and r.json()["error"]["code"] == "phone_not_found", "a phone that is not the caller's"
        foreign = await _register_foreign(c)
        await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG2}'")  # the outsider's own organization has it on: what stops them is that the computer is not theirs
        r = await c.put(f"/api/v2/desktop/setups/{sid}/record-handoffs/{foreign}", json={"envelope": _env(sid)}, headers=_person(OUTSIDER, ORG2))
        assert r.status_code == 404 and r.json()["error"]["code"] == "setup_not_found", "another organization's computer is not found"
        # a computer of another organization, a computer that is gone, a computer that does not exist
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{other_sid}'")
        for target in (other_sid, uuid.uuid4()):
            r = await _to_host(c, target, phone, _env(target))
            assert r.status_code == 404 and r.json()["error"]["code"] == "setup_not_found", (target, r.text)
        assert len(await _rows()) == 1


async def test_09_a_pairing_removed_takes_nothing_and_what_was_on_it_goes_by_every_road_that_removes_one(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac j")
        host_env = lambda: _env(sid)  # noqa: E731
        phone_env = lambda: _env(sid, **{"from": "phone-1", "to": ["host-1"], "wraps": [{"to": "host-1", "enc": b64(32), "ek": b64(48)}]})  # noqa: E731
        # one pair removed
        assert (await _to_phone(c, device, phone, host_env())).status_code == 201 and (await _to_host(c, sid, phone, phone_env())).status_code == 201
        r = await _c_delete(c, f"/api/v2/remote-devices/{phone}/pairs/{sid}")
        assert r.status_code in (200, 204), r.text
        assert await _rows(sid) == [], "a removed pair takes what travels on it — both directions"
        r = await _to_phone(c, device, phone, host_env())
        assert r.status_code == 409 and r.json()["error"]["code"] == "phone_not_paired"
        r = await _to_host(c, sid, phone, phone_env())
        assert r.status_code == 409 and r.json()["error"]["code"] == "phone_not_paired"


async def test_10_a_pairing_removed_behind_the_servers_back_is_not_served_and_the_row_goes_at_the_read(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac k")
        hid = (await _to_phone(c, device, phone, _env(sid))).json()["id"]
        await _sql(f"UPDATE remote_device_pairings SET removed_at = now() WHERE remote_device_id = '{phone}' AND setup_id = '{sid}'")  # a removal that did not pass through the hook
        assert (await _phone_list(c, phone)).json()["items"] == [], "the read is the door: a removed pair is served nothing"
        assert await _rows(sid) == []
        assert hid


async def test_11_a_revoked_phone_key_and_remote_control_turned_off_take_what_was_on_the_road(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac l")
        await _to_phone(c, device, phone, _env(sid))
        await _to_host(c, sid, phone, _env(sid))
        assert len(await _rows(sid)) == 2
        assert (await _c_delete(c, f"/api/v2/remote-devices/{phone}")).status_code in (200, 204)
        assert await _rows(sid) == [], "a revoked key takes what was addressed to it and what it sent"
        device2, phone2, sid2 = await _computer(c, "d4978 mac m")
        await _to_phone(c, device2, phone2, _env(sid2))
        assert (await _remote_control_switch(c, False)).status_code == 200
        assert await _rows(sid2) == [], "the line is off: nothing stays on the server for a computer that cannot be reached"


async def test_12_a_row_nobody_took_goes_at_its_end_by_the_sweep_and_at_every_read_and_put(world):
    from app.core.database import async_session_factory
    from app.services import desktop_record_handoff as handoff

    async def _expire(sid):
        await _sql(f"UPDATE desktop_record_handoffs SET expires_at = now() - interval '1 second' WHERE setup_id = '{sid}'")

    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac n")
        phone_env = lambda: _env(sid, **{"from": "phone-1", "to": ["host-1"], "wraps": [{"to": "host-1", "enc": b64(32), "ek": b64(48)}]})  # noqa: E731
        # the phone's read lets go of what is past its end
        await _to_phone(c, device, phone, _env(sid))
        await _expire(sid)
        assert (await _phone_list(c, phone)).json()["items"] == [] and await _rows(sid) == []
        # the computer's read does too
        await _to_host(c, sid, phone, phone_env())
        await _expire(sid)
        assert (await _host_list(c, device)).json()["items"] == [] and await _rows(sid) == [], "the computer's read lets go of what is past its end"
        # a put lets go of what is past its end first (nothing read in between)
        await _to_phone(c, device, phone, _env(sid))
        await _expire(sid)
        r = await _to_phone(c, device, phone, _env(sid))
        assert r.status_code == 201 and len(await _rows(sid)) == 1, "a put lets go of what is past its end first"
        await _expire(sid)
        async with async_session_factory() as s:
            assert await handoff.purge_expired(s) == 1
            await s.commit()
        assert await _rows(sid) == []


async def test_13_a_computer_that_goes_takes_what_was_addressed_to_it(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac o")
        await _to_phone(c, device, phone, _env(sid))
        await _sql(f"DELETE FROM desktop_setups WHERE id = '{sid}'")
        assert await _rows(sid) == [], "the foreign key hangs the row from the computer"
        device2, phone2, sid2 = await _computer(c, "d4978 mac p")
        await _to_host(c, sid2, phone2, _env(sid2))
        await _sql(f"DELETE FROM remote_devices WHERE id = '{phone2}'")
        assert await _rows(sid2) == [], "…and from the phone"


async def test_14_a_replaced_line_and_a_reclaimed_account_take_their_handoffs_too(world):
    from datetime import datetime, timezone

    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.models.user import User
    from app.routers.auth import _reclaim_unproved_account
    from app.services.desktop_setup import _retire_same_machine

    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac q")
        await _to_phone(c, device, phone, _env(sid))
        await _sql(f"UPDATE desktop_setups SET machine_key = 'mk-4978' WHERE id = '{sid}'")
        async with async_session_factory() as s:
            setup = await s.get(DesktopSetup, uuid.UUID(str(sid)))
            agents = frozenset(uuid.UUID(str(m["member_id"])) for m in (setup.members or []) if m.get("kind") == "agent")
            assert await _retire_same_machine(s, machine_key="mk-4978", others=[setup], now=datetime.now(timezone.utc), new_agents=agents, before={setup.id: agents}) == 1
            await s.commit()
        assert await _rows(sid) == [], "a replaced line keeps no handoff"
        device2, phone2, sid2 = await _computer(c, "d4978 mac r")
        await _to_phone(c, device2, phone2, _env(sid2))
        await _sql(f"UPDATE users SET email_verified = false WHERE id = '{PLAIN}'", f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{sid2}'")
        assert len(await _rows(sid2)) == 1
        async with async_session_factory() as s:
            user = await s.get(User, PLAIN)
            assert await _reclaim_unproved_account(s, user, why="test 4978") is not None
            await s.commit()
        assert await _rows(sid2) == [], "a reclaimed account's computers keep none"


async def test_15_the_minute_job_sweeps_the_handoffs_too(world, monkeypatch):
    from httpx import ASGITransport, AsyncClient

    from app.main import app
    from app.routers import cron as cron_module

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac s")
        await _to_phone(c, device, phone, _env(sid))
        await _sql(f"UPDATE desktop_record_handoffs SET expires_at = now() - interval '1 second' WHERE setup_id = '{sid}'")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        r = await client.post("/api/v2/internal/cron/changes-purge", headers={"Authorization": "Bearer test-cron-secret"})
    assert r.status_code == 200 and r.json()["data"]["handoffs_purged"] == 1, r.text
    assert await _rows(sid) == []


async def test_16_a_phone_taken_off_a_whole_computer_takes_what_was_on_every_pair_of_it(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac t")
        r = await c.get("/api/v2/desktop/computers", headers=_person(OWNER))
        assert r.status_code == 200, r.text
        assert len(r.json()["computers"]) == 1, r.text
        computer = r.json()["computers"][0]["computer_id"]
        await _to_phone(c, device, phone, _env(sid))
        await _to_host(c, sid, phone, _env(sid))
        assert len(await _rows(sid)) == 2
        r = await _c_delete(c, f"/api/v2/remote-devices/{phone}/computers/{computer}")
        assert r.status_code in (200, 204), r.text
        assert await _rows(sid) == [], "the pair with every setup of the computer is gone — and what travelled on it"


async def test_17_no_envelope_or_key_reaches_a_log_line_on_a_good_road_either(world, caplog):
    caplog.set_level(logging.DEBUG)
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac u")
        env = _env(sid, **{"from": MARK})
        hid = (await _to_phone(c, device, phone, env)).json()["id"]
        await _phone_list(c, phone)
        await _phone_got(c, phone, hid)
    assert MARK not in caplog.text and env["ct"] not in caplog.text and env["sig"] not in caplog.text


async def test_18_the_computers_read_is_a_door_a_revoked_phone_or_a_removed_pair_is_not_served_and_the_row_goes(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac v")
        phone_env = lambda: _env(sid, **{"from": "phone-1", "to": ["host-1"], "wraps": [{"to": "host-1", "enc": b64(32), "ek": b64(48)}]})  # noqa: E731
        await _to_host(c, sid, phone, phone_env())
        await _sql(f"UPDATE remote_devices SET revoked_at = now() WHERE id = '{phone}'")  # a revocation that did not pass through the hook
        assert (await _host_list(c, device)).json()["items"] == [] and await _rows(sid) == [], "a revoked key's handoff is not served"
        await _sql(f"UPDATE remote_devices SET revoked_at = NULL WHERE id = '{phone}'")
        await _to_host(c, sid, phone, phone_env())
        await _sql(f"UPDATE remote_device_pairings SET removed_at = now() WHERE remote_device_id = '{phone}' AND setup_id = '{sid}'")
        assert (await _host_list(c, device)).json()["items"] == [] and await _rows(sid) == [], "a removed pair's handoff is not served"


async def test_19_a_computer_a_person_disconnects_keeps_no_handoff(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac w")
        await _to_phone(c, device, phone, _env(sid))
        assert len(await _rows(sid)) == 1
        r = await c.delete(f"/api/v2/desktop/setups/{sid}", headers=_person(OWNER))
        assert r.status_code in (200, 204), r.text
        assert await _rows(sid) == [], "a disconnected computer is cut off: no handoff waits for it"


async def test_20_a_pair_the_device_drops_from_its_snapshot_takes_its_handoffs_and_a_re_added_pair_serves_none_of_them(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac x")
        await _to_phone(c, device, phone, _env(sid))
        await _to_host(c, sid, phone, _env(sid, **{"from": "phone-1", "to": ["host-1"], "wraps": [{"to": "host-1", "enc": b64(32), "ek": b64(48)}]}))
        assert len(await _rows(sid)) == 2
        r = await c.put("/api/v2/desktop/relay/pairings", json={"pairings": []}, headers=_tok(device["device_token"]))  # the computer's snapshot no longer lists the phone
        assert r.status_code == 200, r.text
        assert await _rows(sid) == [], "a pair the device dropped on its own takes what travelled on it"
        await _pair(c, device["device_token"], *_DERS[sid])  # the same phone paired again by a new QR
        assert (await _phone_list(c, phone)).json()["items"] == [] and (await _host_list(c, device)).json()["items"] == [], "nothing of the old pairing comes back"


async def test_21_a_row_a_removed_pair_left_is_not_received_it_goes_and_is_reported_gone(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac y")
        hid = (await _to_phone(c, device, phone, _env(sid))).json()["id"]
        hid2 = (await _to_host(c, sid, phone, _env(sid, **{"from": "phone-1", "to": ["host-1"], "wraps": [{"to": "host-1", "enc": b64(32), "ek": b64(48)}]}))).json()["id"]
        await _sql(f"UPDATE remote_device_pairings SET removed_at = now() WHERE remote_device_id = '{phone}' AND setup_id = '{sid}'")  # a removal that did not pass through the hook
        assert (await _phone_got(c, phone, hid)).json() == {"deleted": False}, "a removed pair cannot acknowledge a row"
        assert (await _host_got(c, device, hid2)).json() == {"deleted": False}
        assert await _rows(sid) == [], "…and the rows are gone"


async def test_22_the_envelopes_one_time_id_is_the_base64url_of_sixteen_bytes_and_rec_is_absent_not_null(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac z")
        good = _env(sid)
        for bad in (_env(sid, command_id="a" * 65), _env(sid, command_id="a" * 300), _env(sid, command_id=b64(17)), {**good, "command_id": ""}, {**good, "rec": None}):
            r = await _to_phone(c, device, phone, bad)
            assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_record_handoff", (str(bad.get("command_id"))[:12], r.status_code, r.text)
        assert await _rows(sid) == []


async def test_23_the_computers_list_is_fair_to_every_phone_one_phone_filling_its_queue_cannot_push_another_out(world, monkeypatch):
    from app.services import desktop_record_handoff as handoff

    monkeypatch.setattr(handoff, "LIST_MAX", 3)
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac aa")
        other, other_der = await _register(c)
        await _pair_also(c, device, sid, other_der)
        mine = lambda: _env(sid, **{"from": "phone-1", "to": ["host-1"], "wraps": [{"to": "host-1", "enc": b64(32), "ek": b64(48)}]})  # noqa: E731
        for _ in range(8):
            assert (await _to_host(c, sid, phone, mine())).status_code == 201
        theirs = (await _to_host(c, sid, other, mine())).json()["id"]
        items = (await _host_list(c, device)).json()["items"]
        assert len(items) == 3 and theirs in [i["id"] for i in items], "the other phone's row is in the first page though it is the newest of nine"
        assert [i["phone_key_id"] for i in items].count(phone) == 2


async def test_24_a_revoked_phones_row_is_not_received_by_the_computer_it_goes_and_is_reported_gone(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac ab")
        hid = (await _to_host(c, sid, phone, _env(sid, **{"from": "phone-1", "to": ["host-1"], "wraps": [{"to": "host-1", "enc": b64(32), "ek": b64(48)}]}))).json()["id"]
        await _sql(f"UPDATE remote_devices SET revoked_at = now() WHERE id = '{phone}'")  # a revocation that did not pass through the hook
        assert (await _host_got(c, device, hid)).json() == {"deleted": False}, "a revoked key's row is not «received»"
        assert await _rows(sid) == []


def _from_phone(sid, **over):
    return _env(sid, **{"from": "phone-1", "to": ["host-1"], "wraps": [{"to": "host-1", "enc": b64(32), "ek": b64(48)}], **over})


async def test_25_a_phone_nobody_paired_travels_only_when_one_person_owns_both_ends(world):
    await _plain_member()
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac ac")
        stranger, _sder = await _register(c, PLAIN)  # same organization, another person, never paired with this computer
        r = await _to_phone(c, device, stranger, _env(sid))
        assert r.status_code == 409 and r.json()["error"]["code"] == "phone_not_paired", "a computer puts nothing for a phone nobody paired with it"
        r = await _to_host(c, sid, stranger, _from_phone(sid), who=PLAIN)
        assert r.status_code == 409 and r.json()["error"]["code"] == "phone_not_paired", "a stranger's phone puts nothing on a computer it is not paired with"
        # the same person's NEW phone — not listed by the computer yet — is a pair in the making: both roads are open
        new, _der = await _register(c)
        h1 = await _to_phone(c, device, new, _env(sid))
        h2 = await _to_host(c, sid, new, _from_phone(sid))
        assert (h1.status_code, h2.status_code) == (201, 201), (h1.text, h2.text)
        assert [i["id"] for i in (await _phone_list(c, new)).json()["items"]] == [h1.json()["id"]]
        assert [i["id"] for i in (await _host_list(c, device)).json()["items"]] == [h2.json()["id"]]
        # a row the stranger's phone got in by another way is neither served nor received
        row = str(uuid.uuid4())
        await _sql(f"INSERT INTO desktop_record_handoffs (id, setup_id, remote_device_id, direction, command_id, envelope, expires_at) "
                   f"VALUES ('{row}', '{sid}', '{stranger}', 'phone_to_host', '{_nonce()}', '{{}}'::jsonb, now() + interval '5 minutes')")
        assert row not in [i["id"] for i in (await _host_list(c, device)).json()["items"]], "the computer's list serves no row of a phone that may not travel"
        assert (await _host_got(c, device, row)).json() == {"deleted": False}


async def test_26_with_remote_control_off_nothing_is_put_or_read_on_either_road(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac ad")
        assert (await _remote_control_switch(c, False)).status_code == 200
        for r in (await _to_host(c, sid, phone, _from_phone(sid)), await _phone_list(c, phone), await _to_phone(c, device, phone, _env(sid))):
            assert r.status_code == 409 and "remote_control_off" in r.text, r.text
        assert await _rows(sid) == [], "nothing was put while it was off"
        assert (await _remote_control_switch(c, True)).status_code == 200
        assert (await _to_phone(c, device, phone, _env(sid))).status_code == 201


async def test_27_delivery_is_at_least_once_a_retry_after_receipt_is_a_new_row_that_the_receivers_replay_guard_refuses(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac ae")
        env = _env(sid)
        first = (await _to_phone(c, device, phone, env)).json()["id"]
        assert (await _phone_got(c, phone, first)).json() == {"deleted": True}
        again = await _to_phone(c, device, phone, env)
        assert again.status_code == 201 and again.json()["id"] != first, "the server keeps no tombstone: a lost-response retry after receipt is a new row"


async def test_28_a_put_is_judged_under_the_locks_the_removals_and_the_switch_take(world):
    """While another transaction holds the organization row (the remote-control switch's), the phone's key row, or the pairing row (the removals') FOR UPDATE, a put does not pass; when it is let go the put goes through — so a put
    is never judged on a pair, a key or a switch that is changing under it."""
    import asyncio

    from sqlalchemy import text

    from app.core.database import async_session_factory

    async def blocked_while_held(lock_sql, call):
        async with async_session_factory() as holder:
            await holder.execute(text(lock_sql))
            task = asyncio.create_task(call())
            await asyncio.sleep(1.5)
            assert not task.done(), f"a put went through while «{lock_sql}» was held"
            await holder.commit()
        r = await asyncio.wait_for(task, 20)
        assert r.status_code == 201, r.text

    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac af")
        org = f"SELECT id FROM organizations WHERE id = '{ORG}' FOR UPDATE"
        key = f"SELECT id FROM remote_devices WHERE id = '{phone}' FOR UPDATE"
        pair = f"SELECT id FROM remote_device_pairings WHERE remote_device_id = '{phone}' AND setup_id = '{sid}' FOR UPDATE"
        for sql in (org, key, pair):
            await blocked_while_held(sql, lambda: _to_phone(c, device, phone, _env(sid)))
            await blocked_while_held(sql, lambda: _to_host(c, sid, phone, _from_phone(sid)))


async def test_29_two_different_puts_at_the_cap_never_both_pass(world):
    """The cap of eight is counted under the phone's key row: of two puts that arrive together on a queue holding seven, one is taken and one is told the queue is full — every round."""
    import asyncio

    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac ag")
        for rnd in range(6):
            await _sql(f"DELETE FROM desktop_record_handoffs WHERE setup_id = '{sid}'")
            for _ in range(7):
                assert (await _to_phone(c, device, phone, _env(sid))).status_code == 201
            a, b = await asyncio.gather(_to_phone(c, device, phone, _env(sid)), _to_phone(c, device, phone, _env(sid)))
            assert sorted([a.status_code, b.status_code]) == [201, 409], (rnd, a.status_code, b.status_code)
            assert len(await _rows(sid)) == 8, "never more than eight unread"


async def test_30_a_disconnected_computer_takes_and_serves_nothing_and_its_pairs_do_not_bring_a_row_back(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac ah")
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{sid}'")  # a disconnect that did not pass through the hook
        row = str(uuid.uuid4())
        await _sql(f"INSERT INTO desktop_record_handoffs (id, setup_id, remote_device_id, direction, command_id, envelope, expires_at) "
                   f"VALUES ('{row}', '{sid}', '{phone}', 'host_to_phone', '{_nonce()}', '{{}}'::jsonb, now() + interval '5 minutes')")
        assert (await _phone_list(c, phone)).json()["items"] == [], "a row of a disconnected computer is not served"
        assert await _rows(sid) == []
        row = str(uuid.uuid4())
        await _sql(f"INSERT INTO desktop_record_handoffs (id, setup_id, remote_device_id, direction, command_id, envelope, expires_at) "
                   f"VALUES ('{row}', '{sid}', '{phone}', 'host_to_phone', '{_nonce()}', '{{}}'::jsonb, now() + interval '5 minutes')")
        assert (await _phone_got(c, phone, row)).json() == {"deleted": False}


async def test_31_a_pair_in_the_making_needs_an_active_human_owner_of_both_ends_in_the_same_organization(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac ai")
        new, _der = await _register(c)  # the same person's new phone, not listed by the computer yet
        assert (await _to_phone(c, device, new, _env(sid))).status_code == 201
        await _sql(f"UPDATE members SET is_active = false WHERE user_id = '{OWNER}' AND org_id = '{ORG}'")
        r = await _to_phone(c, device, new, _env(sid))
        assert r.status_code in (404, 409), "a member who is gone owns nothing"
        assert (await _phone_list(c, new)).status_code in (403, 404, 409) or (await _phone_list(c, new)).json()["items"] == []
        await _sql(f"UPDATE members SET is_active = true WHERE user_id = '{OWNER}' AND org_id = '{ORG}'")
        await _sql(f"UPDATE remote_devices SET org_id = '{ORG2}' WHERE id = '{new}'")  # an inconsistent key row of another organization
        r = await _to_phone(c, device, new, _env(sid))
        assert r.status_code == 404 and r.json()["error"]["code"] == "phone_not_found"


async def test_32_a_put_judges_the_computer_under_its_row_lock_a_disconnect_that_commits_meanwhile_is_seen(world):
    """While a disconnect holds the computer's row FOR UPDATE, a put waits for it and — when the disconnect commits — sees the computer gone (not the row it read before the lock): nothing is put on a computer that was just disconnected."""
    import asyncio

    from sqlalchemy import text

    from app.core.database import async_session_factory

    async with _client() as c:
        for name, call in (
            ("d4978 mac aj", lambda c, device, phone, sid: _to_phone(c, device, phone, _env(sid))),
            ("d4978 mac ak", lambda c, device, phone, sid: _to_host(c, sid, phone, _from_phone(sid))),
        ):
            device, phone, sid = await _computer(c, name)
            async with async_session_factory() as holder:
                await holder.execute(text(f"SELECT id FROM desktop_setups WHERE id = '{sid}' FOR UPDATE"))
                task = asyncio.create_task(call(c, device, phone, sid))
                await asyncio.sleep(1.5)
                assert not task.done(), "a put went through while the computer's row was held"
                await holder.execute(text(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{sid}'"))
                await holder.commit()
            r = await asyncio.wait_for(task, 20)
            assert r.status_code in (404, 409), (name, r.status_code, r.text)
            assert await _rows(sid) == [], "nothing was put on the computer that was disconnected meanwhile"


async def test_33_a_reclaimed_account_takes_the_handoffs_of_its_phones_on_other_peoples_computers(world):
    from app.core.database import async_session_factory
    from app.models.user import User
    from app.routers.auth import _reclaim_unproved_account

    await _plain_member()
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac al")
        plain_phone, plain_der = await _register(c, PLAIN)
        await _pair_also(c, device, sid, plain_der)
        await _to_phone(c, device, plain_phone, _env(sid))
        await _to_host(c, sid, plain_phone, _from_phone(sid), who=PLAIN)
        mine = (await _to_phone(c, device, phone, _env(sid))).json()["id"]
        assert len(await _rows(sid)) == 3
        await _sql(f"UPDATE users SET email_verified = false WHERE id = '{PLAIN}'")
        async with async_session_factory() as s:
            user = await s.get(User, PLAIN)
            assert await _reclaim_unproved_account(s, user, why="test 4978") is not None
            await s.commit()
        assert [str(r[0]) for r in await _rows(sid)] == [mine], "the reclaimed person's phone key took its rows with it — the computer's other rows stay"


async def test_34_a_switch_that_goes_off_between_the_device_gate_and_the_computers_read_is_a_409_not_a_500(world, monkeypatch):
    from app.services import remote_control

    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac am")
        real = remote_control.is_enabled
        calls = []

        async def off_after_the_gate(db, org_id):
            calls.append(1)
            return await real(db, org_id) if len(calls) == 1 else False  # the device gate (the first look) passes; the read's own look finds it off

        monkeypatch.setattr(remote_control, "is_enabled", off_after_the_gate)
        r = await _host_list(c, device)
        assert r.status_code == 409 and "remote_control_off" in r.text, r.text



def _host_waiting(c, device):
    return c.get(f"{H2P}/waiting", headers=_tok(device["device_token"]))


def _phone_waiting(c, phone, who=OWNER):
    return c.get("/api/v2/desktop/record-handoffs/waiting", params={"phone_key_id": phone}, headers=_person(who))


async def test_35_the_computer_sees_which_of_its_rows_nobody_has_received_ids_and_ends_with_the_servers_clock_never_an_envelope(world):
    from datetime import datetime, timedelta, timezone

    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac an")
        other, _ophone, osid = await _computer(c, "d4978 mac ao")
        a = await _to_phone(c, device, phone, _env(sid)); b = await _to_phone(c, device, phone, _env(sid))
        assert a.status_code == b.status_code == 201
        for put in (a, b):  # the put's own answer names the row's end: the server's clock, 15 minutes on
            ends = datetime.fromisoformat(put.json()["expires_at"])
            assert timedelta(minutes=14, seconds=55) < ends - datetime.now(timezone.utc) <= timedelta(minutes=15, seconds=2)
        await _to_host(c, sid, phone, _from_phone(sid))  # the other direction is not «put by this computer»
        r = await _host_waiting(c, device)
        assert r.status_code == 200, r.text
        body = r.json()
        assert set(body) == {"now", "complete", "items"} and body["complete"] is True and abs((datetime.fromisoformat(body["now"]) - datetime.now(timezone.utc)).total_seconds()) < 30
        assert [(i["id"], i["phone_key_id"]) for i in body["items"]] == [(a.json()["id"], phone), (b.json()["id"], phone)]
        assert all(set(i) == {"id", "phone_key_id", "expires_at"} for i in body["items"]), "ids and ends only — no envelope"
        assert (await _host_waiting(c, other)).json()["items"] == [], "another computer sees none of it"
        assert (await _phone_got(c, phone, a.json()["id"])).json() == {"deleted": True}
        assert [i["id"] for i in (await _host_waiting(c, device)).json()["items"]] == [b.json()["id"]], "a row the phone received is gone from the list"
        await _sql(f"UPDATE desktop_record_handoffs SET expires_at = now() - interval '1 second' WHERE setup_id = '{sid}'")
        assert (await _host_waiting(c, device)).json()["items"] == [] and await _rows(sid) == [], "a row past its end is not listed, and the read lets go of it"
        assert osid


async def test_36_the_phone_sees_which_of_its_rows_nobody_has_received_and_only_its_own_persons_session_asks(world):
    await _plain_member()
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac ap")
        h = (await _to_host(c, sid, phone, _from_phone(sid))).json()["id"]
        await _to_phone(c, device, phone, _env(sid))  # the other direction is not «put by this phone»
        r = await _phone_waiting(c, phone)
        assert r.status_code == 200, r.text
        assert set(r.json()) == {"now", "complete", "items"} and [(i["id"], i["setup_id"]) for i in r.json()["items"]] == [(h, str(sid))]
        assert set(r.json()["items"][0]) == {"id", "setup_id", "expires_at"}
        plain_phone, plain_der = await _register(c, PLAIN)
        await _pair_also(c, device, sid, plain_der)
        theirs = (await _to_host(c, sid, plain_phone, _from_phone(sid), who=PLAIN)).json()["id"]
        assert [i["id"] for i in (await _phone_waiting(c, phone)).json()["items"]] == [h], "another phone's row is not on this phone's list"
        assert [i["id"] for i in (await _phone_waiting(c, plain_phone, PLAIN)).json()["items"]] == [theirs]
        r = await _phone_waiting(c, plain_phone, OWNER)
        assert r.status_code == 404 and r.json()["error"]["code"] == "phone_not_found", "another person's phone is not found"
        assert (await _phone_waiting(c, phone, PLAIN)).status_code == 404
        for headers in ({}, _tok(device["device_token"]), {"Authorization": f"Bearer {device['agents'][0]['api_key']}"}):
            r = await c.get("/api/v2/desktop/record-handoffs/waiting", params={"phone_key_id": phone}, headers=headers)
            assert r.status_code in (401, 403), r.status_code
        assert (await _host_got(c, device, h)).json() == {"deleted": True}
        assert (await _phone_waiting(c, phone)).json()["items"] == [], "received: gone from the list"
        assert (await _remote_control_switch(c, False)).status_code == 200
        r = await _phone_waiting(c, phone)
        assert r.status_code == 409 and "remote_control_off" in r.text


async def test_37_the_retry_of_a_put_is_told_the_same_end(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac aq")
        env = _env(sid)
        first = await _to_phone(c, device, phone, env); again = await _to_phone(c, device, phone, env)
        assert (first.status_code, again.status_code) == (201, 200) and first.json() == again.json(), "the same row, the same end"


async def test_38_a_waiting_answer_says_when_it_is_not_complete_so_a_row_that_is_not_named_is_never_read_as_received(world, monkeypatch):
    from app.services import desktop_record_handoff as handoff

    monkeypatch.setattr(handoff, "WAITING_MAX", 3)
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac ar")
        ids = [(await _to_phone(c, device, phone, _env(sid))).json()["id"] for _ in range(3)]
        r = (await _host_waiting(c, device)).json()
        assert r["complete"] is True and [i["id"] for i in r["items"]] == ids
        ids.append((await _to_phone(c, device, phone, _env(sid))).json()["id"])
        r = (await _host_waiting(c, device)).json()
        assert r["complete"] is False and [i["id"] for i in r["items"]] == ids[:3], "the answer names the first three and says it is not the whole"
        h = [(await _to_host(c, sid, phone, _from_phone(sid))).json()["id"] for _ in range(4)]
        p = (await _phone_waiting(c, phone)).json()
        assert p["complete"] is False and [i["id"] for i in p["items"]] == h[:3]


async def test_39_an_expired_row_that_the_sweep_has_not_taken_yet_is_cleaned_by_a_receipt_but_is_not_reported_as_received(world):
    async with _client() as c:
        device, phone, sid = await _computer(c, "d4978 mac as")
        a = (await _to_phone(c, device, phone, _env(sid))).json()["id"]
        b = (await _to_host(c, sid, phone, _from_phone(sid))).json()["id"]
        await _sql(f"UPDATE desktop_record_handoffs SET expires_at = now() - interval '1 second' WHERE setup_id = '{sid}'")
        assert (await _phone_got(c, phone, a)).json() == {"deleted": False}, "its time was over: not «received»"
        assert (await _host_got(c, device, b)).json() == {"deleted": False}
        assert await _rows(sid) == [], "…and it is gone all the same"
