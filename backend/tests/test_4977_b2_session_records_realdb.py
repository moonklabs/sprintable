"""story 4977 B2 (alembic 0493) — the person's history kept as SEALED records the server cannot open: written by the computer (device token) or by a phone of the person's that is paired with it,
read back only by such a phone THIS moment (a phone taken off is refused at once), replaced only by the same writer with a later counter, deleted by the person — and nothing else reads, indexes,
announces or ages them."""
from __future__ import annotations

import base64
import json
import logging
import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    OWNER_TM,
    PLAIN,
    PROJ,
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
    PHONES,
    _pair,
    _register,
    _remote_control_on,
)

pytestmark = pytest.mark.anyio

MARKER = "MK4977sealedrecord"
CONV = uuid.UUID("b2977000-0000-0000-0000-000000000001")
CONV_OTHER = uuid.UUID("b2977000-0000-0000-0000-000000000002")  # a room the owner is NOT in


def b64(n: int, fill: int = 7) -> str:
    return base64.urlsafe_b64encode(bytes([fill]) * n).rstrip(b"=").decode()


def record(setup_id, record_id="rec-1", *, conv=CONV, kind="chat_line", writer="phone-key-1", epoch=1, ctr=1, gen=1, fill=7, **over):
    env = {
        "v": 1, "kind": kind, "setup_id": str(setup_id), "session_key": "", "command_id": "", "expires_at": 0, "from": writer, "to": [], "epoch": epoch, "ctr": ctr, "ts": 1_790_000_000_000 + ctr,
        "nonce": b64(16, fill), "wraps": [], "ct": b64(68, fill), "sig": b64(71, fill), "rec": {"conversation_id": str(conv), "record_id": record_id, "rec_gen": gen},
    }
    env.update(over)
    return env


@pytest.fixture(autouse=True)
async def _rooms(world):
    await _sql(
        f"INSERT INTO conversations (id,org_id,project_id,type) VALUES ('{CONV}','{ORG}','{PROJ}','group'),('{CONV_OTHER}','{ORG}','{PROJ}','group')",
        f"INSERT INTO conversation_participants (conversation_id,member_id) VALUES ('{CONV}','{OWNER_TM}')",
        # the room the owner is NOT in has another PERSON in it (a room with no person in it is readable by an org admin — the chat's own rule — so it would not be «not yours»)
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) SELECT id, org_id, user_id, 'human', 'Plain', true FROM org_members WHERE user_id = '{PLAIN}'",
        f"INSERT INTO conversation_participants (conversation_id,member_id) SELECT '{CONV_OTHER}', id FROM org_members WHERE user_id = '{PLAIN}'",
    )
    yield
    await _sql("DELETE FROM session_records WHERE org_id = '%s'" % ORG)


async def _setup_id(name):
    return (await _sql(fetch=f"SELECT id FROM desktop_setups WHERE device_name = '{name}'"))[0][0]


def comp(setup_id):
    return f"/api/v2/desktop/computers/{setup_id}/records"


async def _phone_put(c, sid, phone_id, env, who=OWNER):
    return await c.put(comp(sid), json={"phone_key_id": phone_id, "envelope": env}, headers=_person(who))


async def _phone_get(c, sid, phone_id, conv=CONV, who=OWNER, **q):
    params = {"phone_key_id": phone_id, "conversation_id": str(conv), **q}
    return await c.get(comp(sid), params=params, headers=_person(who))


async def _host_put(c, token, env):
    return await c.put("/api/v2/desktop/relay/records", json={"envelope": env}, headers=_tok(token))


async def _world_with_phone(c, name):
    device = await _device(c, name=name)
    phone_id, der = await _register(c)
    await _pair(c, device["device_token"], der)
    return device, await _setup_id(name), phone_id, der


async def test_the_computer_and_a_paired_phone_write_and_the_phone_reads_them_back_exactly_as_kept(world):
    async with _client() as c:
        device, sid, phone_id, _der = await _world_with_phone(c, "d4424 mac 4977a")
        token = device["device_token"]
        h = await _host_put(c, token, record(sid, "rec-host", kind="approval_record", writer="host-key-1", fill=9))
        assert h.status_code == 201 and h.json()["replaced"] is False and h.json()["seq"] > 0, h.text
        p = await _phone_put(c, sid, phone_id, record(sid, "rec-phone", fill=5))
        assert p.status_code == 201 and p.json()["seq"] > h.json()["seq"], p.text
        got = await _phone_get(c, sid, phone_id)
        assert got.status_code == 200, got.text
        body = got.json()
        assert [r["record_id"] for r in body["records"]] == ["rec-host", "rec-phone"]  # oldest first
        assert body["records"][0]["envelope"] == record(sid, "rec-host", kind="approval_record", writer="host-key-1", fill=9)  # as it came, byte for byte
        assert body["records"][1]["envelope"] == record(sid, "rec-phone", fill=5)
        assert [(r["kind"], r["rec_gen"]) for r in body["records"]] == [("approval_record", 1), ("chat_line", 1)]
        assert body["next_after"] == body["records"][-1]["seq"]
        assert got.headers["cache-control"] == "no-store"
        # paging: after the first → only the second; after the last → none and the same cursor
        second = await _phone_get(c, sid, phone_id, after=body["records"][0]["seq"])
        assert [r["record_id"] for r in second.json()["records"]] == ["rec-phone"]
        end = await _phone_get(c, sid, phone_id, after=body["next_after"])
        assert end.json() == {"records": [], "next_after": body["next_after"]}
        from app.core.database import async_session_factory
        from app.models.desktop_setup import DesktopSetup
        from app.services import session_records

        async with async_session_factory() as db:  # the service itself clamps a page (the route's own bound is the first fence)
            setup = await db.get(DesktopSetup, sid)
            assert len((await session_records.list_records(db, setup, conversation_id=CONV, after=0, limit=0))["records"]) == 1
            assert len((await session_records.list_records(db, setup, conversation_id=CONV, after=0, limit=10**6))["records"]) == 2
        too_big = await c.get(comp(sid), params={"phone_key_id": phone_id, "conversation_id": str(CONV), "limit": 101}, headers=_person(OWNER))
        assert too_big.status_code == 422
        one = await _phone_get(c, sid, phone_id, limit=1)
        assert len(one.json()["records"]) == 1 and one.json()["next_after"] == body["records"][0]["seq"]


async def test_the_row_holds_the_headers_words_and_the_sealed_envelope_and_no_word_of_the_content(world):
    async with _client() as c:
        device, sid, phone_id, _der = await _world_with_phone(c, "d4424 mac 4977b")
        assert (await _phone_put(c, sid, phone_id, record(sid, "rec-1"))).status_code == 201
    cols = [r[0] for r in await _sql(fetch="SELECT column_name FROM information_schema.columns WHERE table_name = 'session_records' ORDER BY ordinal_position")]
    assert cols == ["id", "seq", "org_id", "setup_id", "owner_id", "conversation_id", "record_id", "kind", "rec_gen", "writer", "epoch", "ctr", "byte_size", "envelope", "created_at", "replaced_at", "deleted_at"]
    row = (await _sql(fetch="SELECT record_id, kind, rec_gen, writer, epoch, ctr, byte_size, envelope FROM session_records"))[0]
    assert row[:6] == ("rec-1", "chat_line", 1, "phone-key-1", 1, 1) and row[6] == len(b64(68))
    assert row[7] == record(sid, "rec-1")
    # no other table of the server holds it: not the chat's messages · events · notifications · activity
    for table, col in (("conversation_messages", "content"), ("events", "payload"), ("notifications", "body")):
        n = (await _sql(fetch=f"SELECT count(*) FROM {table} WHERE {col}::text LIKE '%rec-1%'"))[0][0]
        assert n == 0, table


async def test_the_same_record_id_again_the_same_writer_later_replaces_and_moves_to_the_end_anything_else_is_refused(world):
    async with _client() as c:
        device, sid, phone_id, _der = await _world_with_phone(c, "d4424 mac 4977c")
        a = await _phone_put(c, sid, phone_id, record(sid, "r1", ctr=1))
        b = await _phone_put(c, sid, phone_id, record(sid, "r2", ctr=2))
        assert a.status_code == b.status_code == 201
        again = await _phone_put(c, sid, phone_id, record(sid, "r1", ctr=1))  # the very same envelope: a repeat, nothing changes
        assert again.status_code == 201 and again.json() == {"id": a.json()["id"], "seq": a.json()["seq"], "replaced": False}
        stale = await _phone_put(c, sid, phone_id, record(sid, "r1", ctr=1, fill=3))  # another envelope, not later
        assert stale.status_code == 409 and stale.json()["error"]["code"] == "record_stale"
        other = await _phone_put(c, sid, phone_id, record(sid, "r1", ctr=9, writer="someone-else", fill=3))  # another writer
        assert other.status_code == 409 and other.json()["error"]["code"] == "record_exists"
        kind = await _phone_put(c, sid, phone_id, record(sid, "r1", ctr=9, kind="approval_record", fill=3))  # another kind
        assert kind.status_code == 409 and kind.json()["error"]["code"] == "record_exists"
        later = await _phone_put(c, sid, phone_id, record(sid, "r1", ctr=5, fill=3))
        assert later.status_code == 200 and later.json()["replaced"] is True and later.json()["id"] == a.json()["id"] and later.json()["seq"] > b.json()["seq"]
        got = (await _phone_get(c, sid, phone_id)).json()["records"]
        assert [r["record_id"] for r in got] == ["r2", "r1"]  # the replaced one went to the end, so a reader past r2 sees it again
        assert got[1]["envelope"] == record(sid, "r1", ctr=5, fill=3)
        # a new epoch with a lower counter is later (the order is (epoch, ctr))
        assert (await _phone_put(c, sid, phone_id, record(sid, "r1", epoch=2, ctr=0, fill=4))).json()["replaced"] is True
        assert (await _phone_put(c, sid, phone_id, record(sid, "r1", epoch=1, ctr=99, fill=6))).status_code == 409


async def test_a_phone_that_is_not_paired_or_was_taken_off_is_refused_at_once_and_a_remaining_phone_reads_on(world):
    async with _client() as c:
        device, sid, phone_id, der = await _world_with_phone(c, "d4424 mac 4977d")
        token = device["device_token"]
        second, der2 = await _register(c, label="two")
        await _pair(c, token, der, der2)
        assert (await _phone_put(c, sid, phone_id, record(sid, "r1"))).status_code == 201
        stranger, _ = await _register(c, label="never paired")  # the person's own phone that was never paired with this computer
        for r in (await _phone_get(c, sid, stranger), await _phone_put(c, sid, stranger, record(sid, "r9"))):
            assert r.status_code == 409 and r.json()["error"]["code"] == "phone_not_paired"
        assert len((await _phone_get(c, sid, phone_id)).json()["records"]) == 1
        gone = await c.delete(f"{PHONES}/{phone_id}/pairs/{sid}", headers=_person(OWNER))
        assert gone.json() == {"removed": True}
        refused = await _phone_get(c, sid, phone_id)  # at once — before the computer has heard of it
        assert refused.status_code == 409 and refused.json()["error"]["code"] == "phone_not_paired" and "records" not in refused.text
        refused_w = await _phone_put(c, sid, phone_id, record(sid, "r2"))
        assert refused_w.status_code == 409 and refused_w.json()["error"]["code"] == "phone_not_paired"
        still = await _phone_get(c, sid, second)  # the phone that remains reads the same history
        assert still.status_code == 200 and [r["record_id"] for r in still.json()["records"]] == ["r1"]
        # a phone whose key was revoked is refused the same way
        await _sql(f"UPDATE remote_devices SET revoked_at = now() WHERE id = '{second}'")
        gone2 = await _phone_get(c, sid, second)
        assert gone2.status_code == 409 and gone2.json()["error"]["code"] == "phone_not_paired"
    # the records themselves are untouched by any of it (no removal deletes history)
    assert (await _sql(fetch="SELECT count(*) FROM session_records"))[0][0] == 1


async def test_only_the_person_who_paired_the_computer_in_a_room_they_can_read_uses_it(world):
    async with _client() as c:
        device, sid, phone_id, _der = await _world_with_phone(c, "d4424 mac 4977e")
        assert (await _phone_put(c, sid, phone_id, record(sid, "r1"))).status_code == 201
        # another person of the org (a plain member) with the owner's phone id: not their computer
        r = await _phone_get(c, sid, phone_id, who=PLAIN)
        assert r.status_code == 403 and r.json()["error"]["code"] == "not_allowed_to_use_records"
        assert (await _phone_put(c, sid, phone_id, record(sid, "r2"), who=PLAIN)).status_code == 403
        # a room the person is not in: no write, no read — and the same answer as for a room that does not exist
        no_room = uuid.uuid4()
        for conv in (CONV_OTHER, no_room):
            r = await _phone_get(c, sid, phone_id, conv=conv)
            assert r.status_code == 404 and r.json()["error"]["code"] == "record_conversation_not_found"
            w = await _phone_put(c, sid, phone_id, record(sid, "r3", conv=conv))
            assert w.status_code == 404 and w.json()["error"]["code"] == "record_conversation_not_found"
        # the computer writes into a room that does not exist at all: refused too (the key is a foreign key to the room)
        assert (await _host_put(c, device["device_token"], record(sid, "r4", conv=no_room))).status_code == 404
        # a room the computer's PERSON is not in (the computer has no session of the person to judge the room): the same answer as for a room that does not exist — the person's phone path judges it itself
        outside = await _host_put(c, device["device_token"], record(sid, "r4a", conv=CONV_OTHER, writer="host-1"))
        assert outside.status_code == 404 and outside.json()["error"]["code"] == "record_conversation_not_found"
        # a room of ANOTHER org (the computer's own org is the only one it may write into)
        from tests.test_4424_desktop_setup_realdb import ORG2

        foreign = uuid.UUID("b2977000-0000-0000-0000-000000000003")
        await _sql(f"INSERT INTO conversations (id,org_id,type) VALUES ('{foreign}','{ORG2}','group')")
        assert (await _host_put(c, device["device_token"], record(sid, "r4b", conv=foreign))).status_code == 404
        # a header that names ANOTHER computer
        mismatch = await _phone_put(c, sid, phone_id, record(uuid.uuid4(), "r5"))
        assert mismatch.status_code == 422 and mismatch.json()["error"]["code"] == "envelope_header_mismatch"
        # a disconnected computer is nobody's
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{sid}'")
        assert (await _phone_get(c, sid, phone_id)).status_code == 403
    assert (await _sql(fetch="SELECT count(*) FROM session_records"))[0][0] == 1


async def test_another_computer_does_not_see_these_records_the_same_machine_after_a_reinstall_does_and_another_person_never_does(world):
    from tests.test_4424_desktop_setup_realdb import PROJ as _PROJ  # noqa: F401

    async with _client() as c:
        d1, s1, p1, der1 = await _world_with_phone(c, "d4424 mac 4977f")
        d2 = await _device(c, name="d4424 mac 4977g")
        s2 = await _setup_id("d4424 mac 4977g")
        await _pair(c, d2["device_token"], der1)
        assert (await _host_put(c, d1["device_token"], record(s1, "r1", writer="host-1"))).status_code == 201
        assert (await _phone_get(c, s2, p1)).json()["records"] == []  # a different computer
        # the same machine (a reinstall makes a new setup row of it): the person's own earlier records are found through the setups of that machine
        await _sql(f"UPDATE desktop_setups SET machine_key = 'mk-same' WHERE id IN ('{s1}','{s2}')")
        assert [r["record_id"] for r in (await _phone_get(c, s2, p1)).json()["records"]] == ["r1"]
        assert (await _host_put(c, d1["device_token"], record(s1, "r2", writer="host-1"))).status_code == 201
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{s1}'")  # the old line ended
        assert [r["record_id"] for r in (await _phone_get(c, s2, p1)).json()["records"]] == ["r1", "r2"]
        # the new line of the same machine may replace the person's own record (an edit) — and it stays on the computer it was written on (that computer's limit, not the new one's)
        rep = await _host_put(c, d2["device_token"], record(s2, "r1", writer="host-1", ctr=9, fill=3))
        assert rep.status_code == 200 and rep.json()["replaced"] is True, rep.text
        assert (await _sql(fetch="SELECT setup_id FROM session_records WHERE record_id = 'r1'"))[0][0] == s1
        # a record of one computer is not another computer's to replace — not the same writer id, not a later counter
        d3 = await _device(c, name="d4424 mac 4977m")
        s3 = await _setup_id("d4424 mac 4977m")
        moved = await _host_put(c, d3["device_token"], record(s3, "r1", writer="host-1", ctr=20, fill=5))
        assert moved.status_code == 409 and moved.json()["error"]["code"] == "record_exists"
        assert (await _sql(fetch=f"SELECT setup_id FROM session_records WHERE record_id = 'r1'"))[0][0] == s1  # still where it was written
        # ANOTHER PERSON's computer of the same machine key: nothing of the owner's is in their scope
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}', machine_key = 'mk-same' WHERE id = '{s3}'")
        await _sql(f"INSERT INTO conversation_participants (conversation_id,member_id) SELECT '{CONV}', id FROM org_members WHERE user_id = '{PLAIN}'")
        await _sql(f"INSERT INTO project_access (id,project_id,member_id,permission) SELECT gen_random_uuid(), '{PROJ}', id, 'granted' FROM org_members WHERE user_id = '{PLAIN}'")
        their_phone, their_der = await _register(c, who=PLAIN, label="theirs")
        await _pair(c, d3["device_token"], their_der)
        theirs = await _phone_get(c, s3, their_phone, who=PLAIN)
        assert theirs.status_code == 200 and theirs.json()["records"] == []
        assert (await _phone_get(c, s2, p1)).json()["records"] != []  # the owner still reads theirs


async def test_a_computer_keeps_a_bounded_number_of_records_and_the_person_deleting_makes_room(world, monkeypatch):
    from app.services import session_records

    monkeypatch.setattr(session_records, "MAX_RECORDS_PER_SETUP", 2)
    async with _client() as c:
        device, sid, phone_id, _der = await _world_with_phone(c, "d4424 mac 4977n")
        assert (await _phone_put(c, sid, phone_id, record(sid, "r1", ctr=1))).status_code == 201
        assert (await _host_put(c, device["device_token"], record(sid, "r2", writer="host-1"))).status_code == 201
        full = await _phone_put(c, sid, phone_id, record(sid, "r3", ctr=3))
        assert full.status_code == 409 and full.json()["error"]["code"] == "records_full"
        assert (await _host_put(c, device["device_token"], record(sid, "r3", writer="host-1"))).status_code == 409
        assert (await _phone_put(c, sid, phone_id, record(sid, "r1", ctr=5, fill=3))).status_code == 200  # a replace needs no room
        assert (await c.delete("/api/v2/desktop/records", params={"conversation_id": str(CONV), "record_id": "r2"}, headers=_person(OWNER))).json() == {"deleted": 1}
        assert (await _phone_put(c, sid, phone_id, record(sid, "r3", ctr=3))).status_code == 201


async def test_one_person_has_a_limit_over_all_their_computers(world, monkeypatch):
    from app.services import session_records

    monkeypatch.setattr(session_records, "MAX_RECORDS_PER_OWNER", 3)
    async with _client() as c:
        d1, s1, p1, der1 = await _world_with_phone(c, "d4424 mac 4977t")
        d2 = await _device(c, name="d4424 mac 4977u")
        s2 = await _setup_id("d4424 mac 4977u")
        await _pair(c, d2["device_token"], der1)
        for i in (1, 2):
            assert (await _phone_put(c, s1, p1, record(s1, f"a{i}", ctr=i))).status_code == 201
        assert (await _host_put(c, d2["device_token"], record(s2, "b1", writer="host-2"))).status_code == 201
        full = await _host_put(c, d2["device_token"], record(s2, "b2", writer="host-2"))  # another computer does not reset the person's count
        assert full.status_code == 409 and full.json()["error"]["code"] == "records_full"


async def test_a_person_who_leaves_leaves_no_sealed_rows_behind(world):
    from app.core.database import async_session_factory
    from app.services.desktop_setup import close_setups_of_deleted_account, close_setups_of_removed_member

    async with _client() as c:
        device, sid, phone_id, _der = await _world_with_phone(c, "d4424 mac 4977v")
        for i in (1, 2):
            assert (await _phone_put(c, sid, phone_id, record(sid, f"r{i}", ctr=i))).status_code == 201
        await c.delete("/api/v2/desktop/records", params={"conversation_id": str(CONV), "record_id": "r2"}, headers=_person(OWNER))  # a tombstone too
    await _sql(f"INSERT INTO session_records (id,org_id,setup_id,owner_id,conversation_id,record_id,kind,rec_gen,writer,epoch,ctr,byte_size,envelope) VALUES (gen_random_uuid(),'{ORG}',gen_random_uuid(),'{PLAIN}','{CONV}','x','chat_line',1,'w',1,1,5,'{{}}')")
    async with async_session_factory() as db:  # removed from the ORG: the person's records of that org go, another person's stay
        await close_setups_of_removed_member(db, user_id=OWNER, org_id=ORG, removed_by=PLAIN)
        await db.commit()
    assert [r[0] for r in await _sql(fetch="SELECT record_id FROM session_records ORDER BY record_id")] == ["x"]
    # the same person's record in ANOTHER org of theirs is not touched by a removal from this one
    from tests.test_4424_desktop_setup_realdb import ORG2

    await _sql(f"INSERT INTO conversations (id,org_id,type) VALUES ('b2977000-0000-0000-0000-000000000009','{ORG2}','group')")
    await _sql(f"INSERT INTO session_records (id,org_id,setup_id,owner_id,conversation_id,record_id,kind,rec_gen,writer,epoch,ctr,byte_size,envelope) VALUES (gen_random_uuid(),'{ORG2}',gen_random_uuid(),'{OWNER}','b2977000-0000-0000-0000-000000000009','elsewhere','chat_line',1,'w',1,1,5,'{{}}')")
    async with async_session_factory() as db:
        await close_setups_of_removed_member(db, user_id=OWNER, org_id=ORG, removed_by=PLAIN)
        await db.commit()
    assert [r[0] for r in await _sql(fetch="SELECT record_id FROM session_records ORDER BY record_id")] == ["elsewhere", "x"]
    async with async_session_factory() as db:  # the account is deleted: every record of the person, in every org that lives on
        await close_setups_of_deleted_account(db, user_id=PLAIN)
        await db.commit()
    assert [r[0] for r in await _sql(fetch="SELECT record_id FROM session_records")] == ["elsewhere"]
    async with async_session_factory() as db:
        await close_setups_of_deleted_account(db, user_id=OWNER)
        await db.commit()
    assert (await _sql(fetch="SELECT count(*) FROM session_records"))[0][0] == 0


async def test_a_disconnect_that_is_in_flight_makes_the_read_wait_and_then_refuses_it(world):
    import asyncio

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    from tests.test_4424_desktop_setup_realdb import _ASYNC

    async with _client() as c:
        device, sid, phone_id, _der = await _world_with_phone(c, "d4424 mac 4977o")
        assert (await _phone_put(c, sid, phone_id, record(sid, "r1"))).status_code == 201
        eng = create_async_engine(_ASYNC, poolclass=NullPool)
        try:
            async with eng.connect() as conn:
                await conn.execute(text(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{sid}'"))  # a disconnect, not yet committed
                task = asyncio.ensure_future(_phone_get(c, sid, phone_id))
                await asyncio.sleep(1.0)
                assert not task.done(), "the read took the computer's row without waiting for the disconnect that holds it"
                await conn.commit()
            r = await asyncio.wait_for(task, timeout=10)
        finally:
            await eng.dispose()
        assert r.status_code == 403 and r.json()["error"]["code"] == "not_allowed_to_use_records"


async def test_the_person_deletes_their_records_one_or_all_with_no_phone_and_nobody_else_can(world):
    async with _client() as c:
        device, sid, phone_id, _der = await _world_with_phone(c, "d4424 mac 4977h")
        for i in (1, 2, 3):
            assert (await _phone_put(c, sid, phone_id, record(sid, f"r{i}", ctr=i))).status_code == 201
        url = "/api/v2/desktop/records"
        none = await c.delete(url, params={"conversation_id": str(CONV), "record_id": "r1"}, headers=_person(PLAIN))
        assert none.status_code == 404 and none.json()["error"]["code"] == "record_conversation_not_found"  # not a reader of the room
        await _sql(f"INSERT INTO conversation_participants (conversation_id,member_id) SELECT '{CONV}', id FROM org_members WHERE user_id = '{PLAIN}'")
        await _sql(f"INSERT INTO project_access (id,project_id,member_id,permission) SELECT gen_random_uuid(), '{PROJ}', id, 'granted' FROM org_members WHERE user_id = '{PLAIN}'")
        theirs = await c.delete(url, params={"conversation_id": str(CONV)}, headers=_person(PLAIN))  # a reader of the room whose computer it is not: nothing of the owner's goes
        assert theirs.status_code == 200 and theirs.json() == {"deleted": 0}
        assert (await _sql(fetch="SELECT count(*) FROM session_records WHERE deleted_at IS NULL"))[0][0] == 3
        one = await c.delete(url, params={"conversation_id": str(CONV), "record_id": "r1"}, headers=_person(OWNER))
        assert one.status_code == 200 and one.json() == {"deleted": 1}
        assert (await c.delete(url, params={"conversation_id": str(CONV), "record_id": "r1"}, headers=_person(OWNER))).json() == {"deleted": 0}
        listed = (await _phone_get(c, sid, phone_id)).json()["records"]
        assert [r["record_id"] for r in listed] == ["r2", "r3"] and all(r["envelope"] for r in listed)  # a deleted record is in no list (a tombstone is not a record)
        # no phone of theirs is left at all — they can still delete their history
        await c.delete(f"{PHONES}/{phone_id}/pairs/{sid}", headers=_person(OWNER))
        after_removal = await _phone_get(c, sid, phone_id)
        assert after_removal.status_code == 409 and after_removal.json()["error"]["code"] == "phone_not_paired"
        allgone = await c.delete(url, params={"conversation_id": str(CONV)}, headers=_person(OWNER))
        assert allgone.json() == {"deleted": 2}
        # a deleted record stays deleted: the same id again (a delayed or replayed envelope) is refused, whoever writes it; what is kept is a tombstone with no sealed content
        replay = await _host_put(c, device["device_token"], record(sid, "r1", ctr=1))
        assert replay.status_code == 409 and replay.json()["error"]["code"] == "record_deleted"
        assert (await _phone_put(c, sid, phone_id, record(sid, "r1", ctr=50, fill=2))).status_code in (409,)
        # a disconnected computer's records too
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{sid}'")
    assert (await _sql(fetch="SELECT count(*) FROM session_records WHERE deleted_at IS NULL"))[0][0] == 0
    tomb = await _sql(fetch="SELECT envelope::text, byte_size, record_id FROM session_records ORDER BY record_id")
    assert [t[0] for t in tomb] == ["{}", "{}", "{}"] and [t[2] for t in tomb] == ["r1", "r2", "r3"]  # three tombstones, no sealed word


async def test_a_record_is_never_aged_out_a_deleted_room_takes_its_records_and_the_chats_own_readers_never_see_it(world):
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    async with _client() as c:
        device, sid, phone_id, _der = await _world_with_phone(c, "d4424 mac 4977i")
        assert (await _phone_put(c, sid, phone_id, record(sid, "old"))).status_code == 201
        await _sql("UPDATE session_records SET created_at = now() - interval '5 years'")
        for _ in range(2):  # the minute sweep (and the daily purge) never ages a record out
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as cron:
                assert (await cron.post("/api/v2/internal/cron/changes-purge", headers={"Authorization": "Bearer test-cron-secret"})).status_code == 200
        assert (await _sql(fetch="SELECT count(*) FROM session_records"))[0][0] == 1
        assert [r["record_id"] for r in (await _phone_get(c, sid, phone_id)).json()["records"]] == ["old"]
        msgs = await c.get(f"/api/v2/conversations/{CONV}/messages", headers=_person(OWNER))  # the room's own message list: not a line of it
        assert msgs.status_code == 200 and "old" not in msgs.text and "rec_gen" not in msgs.text
    await _sql(f"DELETE FROM conversations WHERE id = '{CONV}'")
    assert (await _sql(fetch="SELECT count(*) FROM session_records"))[0][0] == 0  # the room's records go with the room (ON DELETE CASCADE)


async def test_no_refusal_and_no_log_carries_what_a_body_held(world, caplog):
    caplog.set_level(logging.DEBUG)
    async with _client() as c:
        device, sid, phone_id, _der = await _world_with_phone(c, "d4424 mac 4977j")
        token = device["device_token"]
        bad_body = {"phone_key_id": phone_id, "envelope": {**record(sid, "r1"), MARKER: MARKER}}
        r = await c.put(comp(sid), json=bad_body, headers=_person(OWNER))
        assert r.status_code == 422 and MARKER not in r.text
        h = await c.put("/api/v2/desktop/relay/records", json={"envelope": {**record(sid, "r1"), MARKER: MARKER}}, headers=_tok(token))
        assert h.status_code == 422 and MARKER not in h.text
        raw = await c.put("/api/v2/desktop/relay/records", content=(MARKER * 5000).encode(), headers=_tok(token))
        assert raw.status_code in (413, 422) and MARKER not in raw.text
        big = await c.put("/api/v2/desktop/relay/records", content=b"x" * 60_000, headers=_tok(token))
        assert big.status_code == 413
        ok = record(sid, "r2", fill=11)
        assert (await _host_put(c, token, ok)).status_code == 201
        refused = await _host_put(c, token, record(sid, "r2", fill=12))  # a stale replace
        assert refused.status_code == 409
    logged = "\n".join(rec.getMessage() for rec in caplog.records)
    assert MARKER not in logged and ok["ct"] not in logged and ok["sig"] not in logged and ok["nonce"] not in logged
    assert (await _sql(fetch="SELECT count(*) FROM session_records WHERE envelope::text LIKE '%" + MARKER + "%'"))[0][0] == 0


async def test_an_api_key_cannot_use_the_phone_routes_and_the_computers_token_is_not_a_persons_session(world):
    from app.core.database import async_session_factory
    from app.repositories.human_api_key import HumanApiKeyRepository

    async with async_session_factory() as s:
        _hkey, plaintext = await HumanApiKeyRepository(s).create(member_id=OWNER_TM, name="d4977 script", expires_at=None)
        await s.commit()
    person_key = {"Authorization": f"Bearer {plaintext}", "X-Org-Id": str(ORG)}
    try:
        async with _client() as c:
            device, sid, phone_id, _der = await _world_with_phone(c, "d4424 mac 4977k")
            assert (await _phone_put(c, sid, phone_id, record(sid, "r1"))).status_code == 201
            for r in (
                await c.get(comp(sid), params={"phone_key_id": phone_id, "conversation_id": str(CONV)}, headers=person_key),
                await c.put(comp(sid), json={"phone_key_id": phone_id, "envelope": record(sid, "r2")}, headers=person_key),
                await c.delete("/api/v2/desktop/records", params={"conversation_id": str(CONV)}, headers=person_key),
            ):
                assert r.status_code == 403 and r.json()["error"]["code"] == "person_session_required", r.text
            assert (await _sql(fetch="SELECT count(*) FROM session_records WHERE deleted_at IS NULL"))[0][0] == 1
            r = await c.get(comp(sid), params={"phone_key_id": phone_id, "conversation_id": str(CONV)}, headers=_tok(device["device_token"]))
            assert r.status_code in (401, 403)  # the computer's token is not a person's session
            r = await c.put("/api/v2/desktop/relay/records", json={"envelope": record(sid)}, headers=_person(OWNER))
            assert r.status_code in (401, 403)  # a person's session is not the computer's token
    finally:
        await _sql(f"DELETE FROM human_api_keys WHERE member_id = '{OWNER_TM}'")


async def test_two_persons_of_one_room_use_the_same_record_id_without_meeting(world):
    async with _client() as c:
        d1, s1, p1, _der1 = await _world_with_phone(c, "d4424 mac 4977p")
        assert (await _phone_put(c, s1, p1, record(s1, "same", ctr=1))).status_code == 201
        d2 = await _device(c, name="d4424 mac 4977q")
        s2 = await _setup_id("d4424 mac 4977q")
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN}' WHERE id = '{s2}'")
        await _sql(f"INSERT INTO conversation_participants (conversation_id,member_id) SELECT '{CONV}', id FROM org_members WHERE user_id = '{PLAIN}'")
        await _sql(f"INSERT INTO project_access (id,project_id,member_id,permission) SELECT gen_random_uuid(), '{PROJ}', id, 'granted' FROM org_members WHERE user_id = '{PLAIN}'")
        their_phone, their_der = await _register(c, who=PLAIN, label="theirs")
        await _pair(c, d2["device_token"], their_der)
        # the other person writes the very same id: no «exists» answer (no oracle on the first person's ids), and each reads only their own
        w = await _phone_put(c, s2, their_phone, record(s2, "same", ctr=1, writer="plain-phone", fill=4), who=PLAIN)
        assert w.status_code == 201, w.text
        mine = (await _phone_get(c, s1, p1)).json()["records"]
        theirs = (await _phone_get(c, s2, their_phone, who=PLAIN)).json()["records"]
        assert [r["envelope"]["from"] for r in mine] == ["phone-key-1"] and [r["envelope"]["from"] for r in theirs] == ["plain-phone"]
        assert (await c.delete("/api/v2/desktop/records", params={"conversation_id": str(CONV), "record_id": "same"}, headers=_person(PLAIN))).json() == {"deleted": 1}
        assert len((await _phone_get(c, s1, p1)).json()["records"]) == 1  # the first person's is untouched


async def test_a_write_that_races_a_disconnect_of_the_computer_waits_and_is_refused(world):
    import asyncio

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    from tests.test_4424_desktop_setup_realdb import _ASYNC

    async with _client() as c:
        device, sid, _phone_id, _der = await _world_with_phone(c, "d4424 mac 4977r")
        eng = create_async_engine(_ASYNC, poolclass=NullPool)
        try:
            async with eng.connect() as conn:
                await conn.execute(text(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{sid}'"))  # a disconnect, not yet committed
                task = asyncio.ensure_future(_host_put(c, device["device_token"], record(sid, "r1", writer="host-1")))
                await asyncio.sleep(1.0)
                assert not task.done(), "the computer's write did not wait for the disconnect that holds its row"
                await conn.commit()
            r = await asyncio.wait_for(task, timeout=10)
        finally:
            await eng.dispose()
        assert r.status_code == 403 and r.json()["error"]["code"] == "device_revoked"
    assert (await _sql(fetch="SELECT count(*) FROM session_records"))[0][0] == 0


async def test_writes_at_the_same_moment_cannot_both_take_the_last_room(world, monkeypatch):
    import asyncio

    from app.services import session_records

    monkeypatch.setattr(session_records, "MAX_RECORDS_PER_SETUP", 2)
    async with _client() as c:
        device, sid, phone_id, _der = await _world_with_phone(c, "d4424 mac 4977s")
        rs = await asyncio.gather(*[_phone_put(c, sid, phone_id, record(sid, f"c{i}", ctr=i + 1)) for i in range(6)])
        codes = sorted(r.status_code for r in rs)
        assert codes == [201, 201, 409, 409, 409, 409], [r.text[:120] for r in rs]
    assert (await _sql(fetch="SELECT count(*) FROM session_records"))[0][0] == 2


async def test_the_service_itself_refuses_a_room_that_is_missing_or_another_orgs_whoever_calls_it(world):
    from app.core.database import async_session_factory
    from app.models.desktop_setup import DesktopSetup
    from app.services import session_records
    from app.services.desktop_relay import DesktopRelayError
    from tests.test_4424_desktop_setup_realdb import ORG2

    async with _client() as c:
        device, sid, _phone_id, _der = await _world_with_phone(c, "d4424 mac 4977x")
    foreign = uuid.UUID("b2977000-0000-0000-0000-000000000004")
    await _sql(f"INSERT INTO conversations (id,org_id,type) VALUES ('{foreign}','{ORG2}','group')")
    for conv in (uuid.uuid4(), foreign):
        async with async_session_factory() as db:
            setup = await db.get(DesktopSetup, sid)
            with pytest.raises(DesktopRelayError) as e:
                await session_records.write(db, setup, record(sid, "r1", conv=conv))  # no router before it (the room is not judged by a person here)
            assert e.value.status == 404 and e.value.code == "record_conversation_not_found"
            await db.rollback()
    assert (await _sql(fetch="SELECT count(*) FROM session_records"))[0][0] == 0


async def test_the_minute_sweep_lets_go_of_old_tombstones_and_never_of_a_live_record(world):
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    async with _client() as c:
        device, sid, phone_id, _der = await _world_with_phone(c, "d4424 mac 4977w")
        for i in (1, 2, 3):
            assert (await _phone_put(c, sid, phone_id, record(sid, f"r{i}", ctr=i))).status_code == 201
        for rid in ("r1", "r2"):
            assert (await c.delete("/api/v2/desktop/records", params={"conversation_id": str(CONV), "record_id": rid}, headers=_person(OWNER))).json() == {"deleted": 1}
    await _sql("UPDATE session_records SET deleted_at = now() - interval '8 days' WHERE record_id = 'r1'")  # past its keep
    await _sql("UPDATE session_records SET deleted_at = now() - interval '6 days' WHERE record_id = 'r2'")  # not yet
    await _sql("UPDATE session_records SET created_at = now() - interval '5 years' WHERE record_id = 'r3'")  # a live record, however old
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as cron:
        r = await cron.post("/api/v2/internal/cron/changes-purge", headers={"Authorization": "Bearer test-cron-secret"})
    assert r.status_code == 200 and r.json()["data"]["record_tombstones_purged"] == 1, r.text
    assert [x[0] for x in await _sql(fetch="SELECT record_id FROM session_records ORDER BY record_id")] == ["r2", "r3"]
    # the replay window of a tombstone that is still kept is still shut
    async with _client() as c:
        assert (await _host_put(c, device["device_token"], record(sid, "r2", ctr=1, writer="host-1"))).json()["error"]["code"] == "record_deleted"


async def test_the_model_and_the_migration_state_the_same_table_and_the_migration_is_only_additive(world):
    import importlib.util
    import pathlib

    from sqlalchemy import text

    from app.core.database import engine
    from app.models.session_record import SessionRecord

    mod_path = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0493_session_records.py"
    spec = importlib.util.spec_from_file_location("m0493", mod_path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    assert (m.revision, m.down_revision) == ("0493", "0492")
    # the migration's CHECK words and the model's are the same
    norm = lambda t: "".join(str(t).split()).lower()  # noqa: E731
    model_checks = {c.name: norm(c.sqltext) for c in SessionRecord.__table__.constraints if getattr(c, "sqltext", None) is not None}
    async with engine.connect() as conn:
        db_checks = {name: norm(d) for name, d in (await conn.execute(text(
            "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'session_records'::regclass AND contype = 'c'"))).all()}
        assert set(model_checks) == set(db_checks) == {"ck_session_records_kind", "ck_session_records_envelope_object", "ck_session_records_numbers", "ck_session_records_text_len", "ck_session_records_tombstone_empty"}
        idx = {r[0] for r in (await conn.execute(text("SELECT indexname FROM pg_indexes WHERE tablename = 'session_records'"))).all()}
        assert idx == {"session_records_pkey", "uq_session_records_conv_owner_record", "uq_session_records_seq", "ix_session_records_setup_seq", "ix_session_records_owner"}
        fks = {r[0]: r[1] for r in (await conn.execute(text(
            "SELECT confrelid::regclass::text, confdeltype FROM pg_constraint WHERE conrelid = 'session_records'::regclass AND contype = 'f'"))).all()}
        assert {k: (v.decode() if isinstance(v, bytes) else v) for k, v in fks.items()} == {"organizations": "c", "conversations": "c"}  # both cascade; NO foreign key to a computer: the history outlives it
    assert {fk.column.table.name: fk.ondelete for fk in SessionRecord.__table__.foreign_keys} == {"organizations": "CASCADE", "conversations": "CASCADE"}  # the model states the same cascades
    # the rules the database itself holds, by what it refuses
    import sqlalchemy as sa

    row = "INSERT INTO session_records (id,org_id,setup_id,owner_id,conversation_id,record_id,kind,rec_gen,writer,epoch,ctr,byte_size,envelope,deleted_at) VALUES (gen_random_uuid(),'%s',gen_random_uuid(),'%s','%s','%s','%s',%s,'w',1,1,%s,'%s',%s)"
    ok = lambda rid="a", kind="chat_line", gen=1, size=5, env="{}", owner=OWNER, dele="NULL": row % (ORG, owner, CONV, rid, kind, gen, size, env, dele)  # noqa: E731
    await _sql(ok())
    await _sql(ok(owner=PLAIN))  # the same record id of ANOTHER person is its own row (no key to meet in)
    for bad, name in ((ok(), "uq_session_records_conv_owner_record"), (ok("b", kind="send_prompt"), "ck_session_records_kind"), (ok("c", gen=0), "ck_session_records_numbers"),
                      (ok("t", env='{"a": 1}', dele="now()"), "ck_session_records_tombstone_empty"),
                      (ok("d", size=0), "ck_session_records_numbers"), (ok("e", env="[]"), "ck_session_records_envelope_object"), (ok("x" * 257), "ck_session_records_text_len")):
        with pytest.raises(sa.exc.DBAPIError, match=name):
            await _sql(bad)
    await _sql("DELETE FROM session_records")
    # an old revision lives with it: nothing in an existing table was added or changed — the table is referenced by no other table
    async with engine.connect() as conn:
        refs = (await conn.execute(text("SELECT count(*) FROM pg_constraint WHERE confrelid = 'session_records'::regclass"))).scalar_one()
        assert refs == 0
    src = mod_path.read_text()
    assert "op.create_table(" in src and "op.add_column" not in src and "op.alter_column" not in src and "op.drop_column" not in src and "drop_constraint" not in src
