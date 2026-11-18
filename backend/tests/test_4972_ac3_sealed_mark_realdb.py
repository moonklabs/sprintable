"""story 4972 (AC3 ① · lens table 16e21429 + push-landing lens + PO 8787) — the computer's «sealed cards» mark and what it closes.

A computer that has sent ONE sealed card (receivers all pinned phones of that computer) takes no PLAINTEXT card any more (422 `sealed_required`, a fixed sentence — no word of the body, no `detail`); the network question's fixed first stage
(`network`) is the one plain card left. The mark is the server's own now(), first one kept, one way (a trigger), read by `org_id + machine_key` (a replaced setup · a sibling lane of the same Mac keep it) — and a computer never has more than
OPEN_LIMIT open questions (422 `open_limit`), a list answer never more than LIST_CAP rows (the waiting ones first).
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    ORG2,
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
from tests.test_4533_agent_permissions_realdb import (  # noqa: F401 — the autouse remote-control fixture applies here too
    PHONES,
    REQS,
    _answer,
    _ask,
    _pair,
    _plain_member,
    _post_ask,
    _register,
    _remote_control_on,
    _with_session,
)
from tests.test_4972_permission_envelope_realdb import _setup_id, b64, sealed

pytestmark = pytest.mark.anyio

WORDS = "MK4972ac3words"


async def _mark(name):
    return (await _sql(fetch=f"SELECT sealed_cards_at FROM desktop_setups WHERE device_name = '{name}'"))[0][0]


def _sealed_to(agent, setup_id, phone_id, **over):
    plain = _ask(agent)
    for k in ("tool", "summary", "workdir"):
        del plain[k]
    plain["masked"] = False
    ms = int(datetime.fromisoformat(plain["expires_at"]).timestamp() * 1000)
    plain["envelope"] = sealed(setup_id, plain["request_id"], ms, to=[phone_id], wraps=[{"to": phone_id, "enc": b64(32), "ek": b64(48)}], **over)
    return plain


async def _sealed_computer(c, name, phone=None):
    """a computer with a session and one pinned phone: (device, agent, phone id) — `phone` = (id, der) of a phone already registered (a person holds three at most)"""
    device = await _device(c, name=name)
    agent = await _with_session(c, device)
    phone_id, der = phone or await _register(c)
    await _pair(c, device["device_token"], der)
    return device, agent, phone_id


async def _stand(c, device, agent, name, phone_id):
    made = await _post_ask(c, device, _sealed_to(agent, await _setup_id(name), phone_id))
    assert made.status_code == 201, made.text
    return made


async def _count(name):
    return (await _sql(fetch=f"SELECT count(*) FROM agent_permission_requests WHERE setup_id = (SELECT id FROM desktop_setups WHERE device_name = '{name}')"))[0][0]


def _plain(agent, **over):
    return {**_ask(agent), "tool": "Bash", "summary": f"{WORDS} --run", "workdir": f"~/{WORDS}", **over}


async def test_the_mark_stands_with_a_sealed_card_to_pinned_phones_only_once_and_never_moves(world):
    name = "d4424 mac 4972m1"
    async with _client() as c:
        device, agent, phone_id = await _sealed_computer(c, name)
        assert await _mark(name) is None
        # a form-only envelope naming a receiver that is no pin of this computer: the card is taken, the mark does not stand (the plaintext road stays open)
        stranger = _sealed_to(agent, await _setup_id(name), "phone-unknown")
        assert (await _post_ask(c, device, stranger)).status_code == 201 and await _mark(name) is None
        assert (await _post_ask(c, device, _plain(agent))).status_code == 201  # (and plaintext is still taken)
        first = _sealed_to(agent, await _setup_id(name), phone_id)
        assert (await _post_ask(c, device, first)).status_code == 201
        at = await _mark(name)
        assert at is not None
        # the same card again: the same row (200), the mark is not touched; a second sealed card does not move it either
        assert (await _post_ask(c, device, first)).status_code == 200 and await _mark(name) == at
        assert (await _post_ask(c, device, _sealed_to(agent, await _setup_id(name), phone_id))).status_code == 201 and await _mark(name) == at


async def test_a_card_that_is_rolled_back_or_never_made_stands_no_mark(world):
    name = "d4424 mac 4972m2"
    async with _client() as c:
        device, agent, phone_id = await _sealed_computer(c, name)
        bad = _sealed_to(agent, await _setup_id(name), phone_id, session_key="s-other")  # the header is not this request's → 422, nothing made
        assert (await _post_ask(c, device, bad)).status_code == 422 and await _mark(name) is None and await _count(name) == 0


async def test_the_mark_is_one_way_the_database_refuses_clearing_or_moving_it(world):
    name = "d4424 mac 4972m3"
    async with _client() as c:
        device, agent, phone_id = await _sealed_computer(c, name)
        await _stand(c, device, agent, name, phone_id)
        for sql in (f"UPDATE desktop_setups SET sealed_cards_at = NULL WHERE device_name = '{name}'",
                    f"UPDATE desktop_setups SET sealed_cards_at = sealed_cards_at - interval '1 day' WHERE device_name = '{name}'",
                    f"UPDATE desktop_setups SET sealed_cards_at = now() WHERE device_name = '{name}'"):
            with pytest.raises(Exception, match="one-way"):
                await _sql(sql)
        assert await _mark(name) is not None
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE device_name = '{name}'")  # other updates of the row are not in its way


async def test_after_the_mark_a_plaintext_card_is_422_with_a_fixed_sentence_in_every_shape_and_makes_nothing(world):
    name = "d4424 mac 4972m4"
    async with _client() as c:
        device, agent, phone_id = await _sealed_computer(c, name)
        rid_before = str(uuid.uuid4())
        assert (await _post_ask(c, device, _plain(agent, request_id=rid_before))).status_code == 201
        await _stand(c, device, agent, name, phone_id)
        n = await _count(name)
        shapes = [
            _plain(agent),
            _plain(agent, terminal_only=True, input_hash=None, tool=None, workdir=None),                       # a summary only
            _plain(agent, terminal_only=True, input_hash=None, summary=None, workdir=None),                    # a tool only
            _plain(agent, terminal_only=True, input_hash=None, tool=None, summary=None),                       # a folder only
        ]
        for body in shapes:
            r = await _post_ask(c, device, body)
            assert r.status_code == 422, (body, r.text)
            j = r.json()
            assert j["error"]["code"] == "sealed_required" and "detail" not in j["error"], j
            assert WORDS not in r.text and "Bash" not in r.text, r.text  # not a word of the body (no field name · no echo)
        assert await _count(name) == n  # nothing made · no row, no notice
        # a re-send of the plaintext card that stood BEFORE the mark is 422 too (no branch that tells a first from a second)
        again = await _post_ask(c, device, _plain(agent, request_id=rid_before))
        assert again.status_code == 422, again.text
        # a terminal-only card with no words at all hides nothing: taken
        bare = _plain(agent, terminal_only=True, input_hash=None, tool=None, summary=None, workdir=None)
        assert (await _post_ask(c, device, bare)).status_code == 201


async def test_the_network_question_first_stage_is_the_one_plain_card_left_and_only_in_its_exact_shape(world):
    name = "d4424 mac 4972m5"
    async with _client() as c:
        device, agent, phone_id = await _sealed_computer(c, name)
        await _stand(c, device, agent, name, phone_id)
        net = lambda **o: {**_ask(agent, request_id=str(uuid.uuid4())), "tool": "SandboxNetwork", "summary": "network", "masked": False, "truncated": False, "workdir": None, **o}  # noqa: E731
        ok = await _post_ask(c, device, net())
        assert ok.status_code == 201, ok.text
        for name_, body in {
            "trailing space": net(summary="network "), "capital": net(summary="Network"), "a host as summary": net(summary="api.example.com"), "codex": net(runtime="codex"),
            "a folder": net(workdir="~/w"), "masked": net(masked=True), "truncated": net(truncated=True), "another tool name": net(tool="sandboxnetwork"), "bash saying network": net(tool="Bash"),
        }.items():
            r = await _post_ask(c, device, body)
            assert r.status_code == 422 and r.json()["error"]["code"] == "sealed_required", (name_, r.text)


async def test_a_replaced_setup_and_a_sibling_lane_of_the_same_mac_keep_the_mark_other_orgs_and_no_machine_key_do_not(world):
    mk = "mk-4972-" + uuid.uuid4().hex[:8]
    async with _client() as c:
        a_name, b_name, c_name, d_name, e_name = (f"d4424 mac 4972m6{x}" for x in "abcde")
        dev_a, agent_a, phone_a = await _sealed_computer(c, a_name)
        await _stand(c, dev_a, agent_a, a_name, phone_a)
        dev_b = await _device(c, name=b_name); agent_b = await _with_session(c, dev_b)  # (the same Mac: a replacement · a sibling lane)
        dev_c = await _device(c, name=c_name)  # (the same machine key, ANOTHER organization — it holds a mark of its own; it posts nothing)
        dev_d = await _device(c, name=d_name); agent_d = await _with_session(c, dev_d)  # (no machine key at all)
        dev_e = await _device(c, name=e_name); agent_e = await _with_session(c, dev_e)  # (a machine key of its own: the ONLY mark with it sits in another organization)
        mk2 = mk + "-2"
        await _sql(f"UPDATE desktop_setups SET machine_key = '{mk}' WHERE device_name IN ('{a_name}','{b_name}')")
        await _sql(f"UPDATE desktop_setups SET machine_key = '{mk2}' WHERE device_name = '{e_name}'")
        await _sql(f"UPDATE desktop_setups SET machine_key = '{mk2}', org_id = '{ORG2}', sealed_cards_at = now() WHERE device_name = '{c_name}'")
        await _sql(f"UPDATE desktop_setups SET revoked_at = now(), revoked_reason = 'replaced_by_new_setup' WHERE device_name = '{a_name}'")  # (A is the replaced one: its mark is kept)
        r = await _post_ask(c, dev_b, _plain(agent_b))
        assert r.status_code == 422 and r.json()["error"]["code"] == "sealed_required", r.text  # the new setup's first plaintext card: refused at once
        assert (await _post_ask(c, dev_e, _plain(agent_e))).status_code == 201     # the same machine key's mark in ANOTHER organization is not this one's
        assert (await _post_ask(c, dev_d, _plain(agent_d))).status_code == 201     # no machine key: its own mark only (a known limit — written down)


async def test_a_sealed_card_and_a_plaintext_one_at_the_same_moment_end_consistently_in_either_order(world):
    async with _client() as c:
        phone = await _register(c)
        for i in range(4):
            name = f"d4424 mac 4972m7{i}"
            device, agent, phone_id = await _sealed_computer(c, name, phone)
            sealed_body = _sealed_to(agent, await _setup_id(name), phone_id)
            plain_body = _plain(agent)
            r_sealed, r_plain = await asyncio.gather(_post_ask(c, device, sealed_body), _post_ask(c, device, plain_body))
            assert r_sealed.status_code == 201, r_sealed.text
            assert await _mark(name) is not None
            assert r_plain.status_code in (201, 422), r_plain.text  # (201: the lock gave the plaintext card the turn before the mark · 422: after) — never an error, and the road is shut from then on
            assert (await _post_ask(c, device, _plain(agent, request_id=str(uuid.uuid4())))).status_code == 422


async def test_the_open_limit_refuses_the_card_past_it_with_a_fixed_word_and_gives_the_place_back_when_one_ends(world):
    from app.services import agent_permissions

    name = "d4424 mac 4972m8"
    async with _client() as c:
        device = await _device(c, name=name)
        agent = await _with_session(c, device)
        assert agent_permissions.OPEN_LIMIT == 50  # PO 8787: measured on dev (at most 11 open at once per computer, 30 days) → 50
        ids = []
        for _ in range(50):  # (the LITERAL number: a changed constant must not make the test follow it)
            body = _ask(agent, request_id=str(uuid.uuid4()))
            ids.append(body["request_id"])
            assert (await _post_ask(c, device, body)).status_code == 201
        over = await _post_ask(c, device, _ask(agent, request_id=str(uuid.uuid4())))
        assert over.status_code == 422 and over.json()["error"]["code"] == "open_limit" and "detail" not in over.json()["error"], over.text
        assert "50" not in over.text and "Bash" not in over.text  # no count · no word of the card
        assert await _count(name) == 50
        # the same request again at the limit is its own row (200), not a new one
        assert (await _post_ask(c, device, _ask(agent, request_id=ids[0]))).status_code == 200
        # one passes its window → its place is free; one withdrawn → free
        await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '1 second' WHERE request_id = '{ids[1]}'")
        assert (await _post_ask(c, device, _ask(agent, request_id=str(uuid.uuid4())))).status_code == 201
        assert (await _post_ask(c, device, _ask(agent, request_id=str(uuid.uuid4())))).status_code == 422  # full again
        # a sealed card counts too
        phone_id, der = await _register(c)
        await _pair(c, device["device_token"], der)
        await _sql(f"UPDATE agent_permission_requests SET state = 'withdrawn', result_code = 'session_ended' WHERE request_id = '{ids[2]}'")
        assert (await _post_ask(c, device, _sealed_to(agent, await _setup_id(name), phone_id))).status_code == 201
        assert (await _post_ask(c, device, _sealed_to(agent, await _setup_id(name), phone_id))).status_code == 422


async def test_the_whole_list_keeps_the_waiting_ones_inside_the_one_hour_window_and_is_bounded(world, monkeypatch):
    from app.services import agent_permissions

    monkeypatch.setattr(agent_permissions, "RECENT_CAP", 2)
    monkeypatch.setattr(agent_permissions, "LIST_CAP", 4)
    name = "d4424 mac 4972m9"
    async with _client() as c:
        device = await _device(c, name=name)
        agent = await _with_session(c, device)
        ids = {}
        for k in ("p59", "p61", "n1", "n2", "n3", "n4", "n5"):
            body = _ask(agent, request_id=str(uuid.uuid4()))
            ids[k] = body["request_id"]
            assert (await _post_ask(c, device, body)).status_code == 201
        # created order (oldest first): p59 · p61 · n1..n5 — the first two are «pending past their window» by minutes, the rest are the newest and ended
        base = datetime.now(timezone.utc) - timedelta(hours=3)
        for i, k in enumerate(("p59", "p61", "n1", "n2", "n3", "n4", "n5")):
            await _sql(f"UPDATE agent_permission_requests SET created_at = '{(base + timedelta(minutes=i)).isoformat()}' WHERE request_id = '{ids[k]}'")
        await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '59 minutes' WHERE request_id = '{ids['p59']}'")
        await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '61 minutes' WHERE request_id = '{ids['p61']}'")
        for k in ("n1", "n2", "n3", "n4", "n5"):
            await _sql(f"UPDATE agent_permission_requests SET state = 'withdrawn', result_code = 'session_ended' WHERE request_id = '{ids[k]}'")
        got = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        seen = {r["request_id"] for r in got}
        assert ids["p59"] in seen, "a waiting request whose window passed 59 minutes ago is still in the whole list (inside the hour)"
        assert ids["p61"] not in seen, "61 minutes past its window it is no longer «live»: only the newest-rows window can carry it, and it is older than all"
        assert len(got) <= 4
        assert [r["created_at"] for r in got] == sorted((r["created_at"] for r in got), reverse=True)
        # the bound: with LIST_CAP smaller than the live ones, the waiting ones come first and the answer stays at the bound
        monkeypatch.setattr(agent_permissions, "LIST_CAP", 1)
        got = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert [r["request_id"] for r in got] == [ids["p59"]]


async def test_the_merged_waiting_rows_and_the_mark_never_cross_a_member_or_an_org(world):
    name = "d4424 mac 4972ma"
    async with _client() as c:
        device, agent, phone_id = await _sealed_computer(c, name)
        await _stand(c, device, agent, name, phone_id)
        await _plain_member()
        assert (await c.get(REQS, headers=_person(PLAIN))).json()["requests"] == []


async def test_the_migration_is_additive_nothing_gets_a_mark_at_deploy_and_the_trigger_is_there(world):
    cols = await _sql(fetch="SELECT is_nullable FROM information_schema.columns WHERE table_name = 'desktop_setups' AND column_name = 'sealed_cards_at'")
    assert cols == [("YES",)]
    assert (await _sql(fetch="SELECT count(*) FROM desktop_setups WHERE sealed_cards_at IS NOT NULL"))[0][0] == 0
    assert (await _sql(fetch="SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_desktop_setups_sealed_cards_one_way'"))[0][0] == 1


async def test_a_removed_or_revoked_pin_is_no_receiver_that_stands_the_mark(world):
    name = "d4424 mac 4972mb"
    async with _client() as c:
        device, agent, phone_id = await _sealed_computer(c, name)
        # the pairing is removed (the computer's own report of its pins dropped it): a card sealed to that phone is taken, the mark does not stand
        await _sql(f"UPDATE remote_device_pairings SET removed_at = now() WHERE remote_device_id = '{phone_id}'")
        assert (await _post_ask(c, device, _sealed_to(agent, await _setup_id(name), phone_id))).status_code == 201 and await _mark(name) is None
        # the phone's key is revoked: same
        await _sql(f"UPDATE remote_device_pairings SET removed_at = NULL WHERE remote_device_id = '{phone_id}'")
        await _sql(f"UPDATE remote_devices SET revoked_at = now() WHERE id = '{phone_id}'")
        assert (await _post_ask(c, device, _sealed_to(agent, await _setup_id(name), phone_id))).status_code == 201 and await _mark(name) is None
        # alive again: the mark stands
        await _sql(f"UPDATE remote_devices SET revoked_at = NULL WHERE id = '{phone_id}'")
        assert (await _post_ask(c, device, _sealed_to(agent, await _setup_id(name), phone_id))).status_code == 201 and await _mark(name) is not None


def test_the_setup_lock_is_taken_before_the_mark_is_read_a_source_pin_for_the_race_that_cannot_be_asserted_in_order():
    """The sealed card and the plaintext one at the same moment (the test above) can only be asserted as «either order, no error, shut afterwards» — which order happened cannot be seen.
    What makes them one-at-a-time is the setup row's lock (`lock_setup`) taken BEFORE the mark is read; a mutant that drops the lock leaves that race test green. So the order is pinned in the source (honest: a source pin, not a race)."""
    import inspect

    from app.services import agent_permissions

    src = inspect.getsource(agent_permissions.report_request)
    assert "_sealed_mark(" in src
    assert "purge_open_cards(" in src and src.index("purge_open_cards(") < src.index("_lock_machine("), "the request rows (the purge) come BEFORE the setup rows: the order answer_request takes (request → setup) — the reverse could deadlock with an answer near the window's end"
    assert src.index("_lock_machine(") < src.index("revoked_at") < src.index("_sealed_mark("), "the setup is read again under the lock, before the mark is read: a request that authenticated before its setup was revoked takes no card"
    lock_src = inspect.getsource(agent_permissions._lock_machine)
    assert ".order_by(DesktopSetup.id)" in lock_src and ".with_for_update()" in lock_src, "the lock takes the rows in ONE order (by id) — the order is what keeps two siblings from waiting for each other"
    assert "revoked_at.is_(None)" in lock_src, "the lock covers the LIVE siblings (a revoked setup cannot report)"
    assert "_lock_machine(" in src and src.index("_lock_machine(") < src.index("_sealed_mark("), "the lock (every setup row of the machine) must come before the mark is read"
    assert src.index("_sealed_mark(") < src.index("existing = "), "the plaintext refusal comes before the re-send shortcut (a plaintext re-send is always 422)"
    assert "_stand_sealed_mark(" in src and src.index("_stand_sealed_mark(") > src.index("db.begin_nested()"), "the mark stands only after the row is made, in the same transaction"


async def test_the_plaintext_decision_waits_for_a_sibling_setup_of_the_same_mac_the_lock_covers_the_machine_not_one_row(world):
    """codex AC3 ① (high): the mark is shared by org + machine_key, so the lock must be too — with a lock on the setup's own row only, setup A could read «no mark» while sibling B stands it. Deterministic: another connection holds a
    FOR UPDATE on the SIBLING's row; A's plaintext post must WAIT for it (and then be taken — no mark stood); reverting to the own-row lock makes it come back at once."""
    import asyncio

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from tests.test_4424_desktop_setup_realdb import _ASYNC

    a_name, b_name = "d4424 mac 4972mc1", "d4424 mac 4972mc2"
    mk = "mk-4972-lock-" + uuid.uuid4().hex[:8]
    async with _client() as c:
        dev_a = await _device(c, name=a_name); agent_a = await _with_session(c, dev_a)
        await _device(c, name=b_name)
        await _sql(f"UPDATE desktop_setups SET machine_key = '{mk}' WHERE device_name IN ('{a_name}','{b_name}')")
        eng = create_async_engine(_ASYNC, poolclass=NullPool)
        try:
            async with async_sessionmaker(eng)() as holder:
                await holder.execute(text("SELECT id FROM desktop_setups WHERE device_name = :n FOR UPDATE"), {"n": b_name})  # the sibling's row is held
                task = asyncio.create_task(_post_ask(c, dev_a, _plain(agent_a)))
                await asyncio.sleep(1.5)
                assert not task.done(), "A's plaintext decision did not wait for the sibling setup of the same Mac (the lock covers one row only)"
                await holder.commit()
            r = await asyncio.wait_for(task, 15)
            assert r.status_code == 201, r.text  # (no mark stood: taken)
        finally:
            await eng.dispose()


async def test_still_open_requests_come_before_just_lapsed_ones_in_the_whole_list_even_when_many_newer_lapsed_ones_exist(world, monkeypatch):
    """codex AC3 ① (medium): the lapsed (pending in the database, window passed within the hour) used to share one LIMIT with the open ones — more than LIST_CAP newer lapsed rows pushed an older still-open request out."""
    from app.services import agent_permissions

    monkeypatch.setattr(agent_permissions, "RECENT_CAP", 1)
    monkeypatch.setattr(agent_permissions, "LIST_CAP", 3)
    name = "d4424 mac 4972md"
    async with _client() as c:
        device = await _device(c, name=name); agent = await _with_session(c, device)
        ids = {}
        for k in ("open_old", "l1", "l2", "l3", "l4", "l5"):
            body = _ask(agent, request_id=str(uuid.uuid4())); ids[k] = body["request_id"]
            assert (await _post_ask(c, device, body)).status_code == 201
        base = datetime.now(timezone.utc) - timedelta(hours=2)
        for i, k in enumerate(("open_old", "l1", "l2", "l3", "l4", "l5")):
            await _sql(f"UPDATE agent_permission_requests SET created_at = '{(base + timedelta(minutes=i)).isoformat()}' WHERE request_id = '{ids[k]}'")
        for k in ("l1", "l2", "l3", "l4", "l5"):  # newer, pending in the database, their window passed 10 minutes ago
            await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '10 minutes' WHERE request_id = '{ids[k]}'")
        got = (await c.get(REQS, headers=_person(OWNER))).json()["requests"]
        assert ids["open_old"] in {r["request_id"] for r in got}, "the still-open request must not be pushed out by newer lapsed ones"
        assert len(got) <= 3


async def test_the_mark_needs_EVERY_receiver_to_be_a_pin_of_THIS_setup_not_one_and_not_a_pin_of_another_computer(world):
    """lens 5848 (low · test holes ⓐ ⓑ): a card sealed to a pinned phone AND an unpinned one does not stand the mark; a card sealed to a phone pinned only on ANOTHER computer does not either."""
    async with _client() as c:
        x_name, y_name = "d4424 mac 4972me", "d4424 mac 4972mf"
        dev_x, agent_x, p1 = await _sealed_computer(c, x_name)            # X has P1 pinned
        p2_id, _der2 = await _register(c)                                    # P2: registered, pinned NOWHERE
        mixed = _sealed_to(agent_x, await _setup_id(x_name), p1)
        env = mixed["envelope"]; env["to"] = [p1, p2_id]; env["wraps"] = [{"to": p1, "enc": b64(32), "ek": b64(48)}, {"to": p2_id, "enc": b64(32), "ek": b64(48)}]
        assert (await _post_ask(c, dev_x, mixed)).status_code == 201 and await _mark(x_name) is None, "one pinned + one unpinned receiver: the card is taken, the mark does not stand"
        dev_y = await _device(c, name=y_name); agent_y = await _with_session(c, dev_y)  # Y: no pin at all
        assert (await _post_ask(c, dev_y, _sealed_to(agent_y, await _setup_id(y_name), p1))).status_code == 201 and await _mark(y_name) is None, "a phone pinned only on ANOTHER computer is no receiver of this one"
        assert (await _post_ask(c, dev_y, _plain(agent_y))).status_code == 201  # (Y's plaintext road is still open)


async def test_the_open_limit_is_per_setup_not_per_organization(world):
    """lens 5848 (low · test hole ⓒ): a computer at its limit does not shut another computer of the same organization."""
    from app.services import agent_permissions

    a_name, b_name = "d4424 mac 4972mg", "d4424 mac 4972mh"
    async with _client() as c:
        dev_a = await _device(c, name=a_name); agent_a = await _with_session(c, dev_a)
        dev_b = await _device(c, name=b_name); agent_b = await _with_session(c, dev_b)
        for _ in range(50):
            assert (await _post_ask(c, dev_a, _ask(agent_a, request_id=str(uuid.uuid4())))).status_code == 201
        assert (await _post_ask(c, dev_a, _ask(agent_a, request_id=str(uuid.uuid4())))).status_code == 422  # A is full
        assert (await _post_ask(c, dev_b, _ask(agent_b, request_id=str(uuid.uuid4())))).status_code == 201  # B is not
        assert agent_permissions.OPEN_LIMIT == 50


def test_the_list_bounds_are_the_real_values_not_the_ones_a_test_overrides():
    """lens 5848 (low · test hole ⓓ): the tests above shrink RECENT_CAP / LIST_CAP with monkeypatch — this one reads the shipped values (PO 8787 · 8793: 100 newest + the waiting ones, at most 200)."""
    from app.services import agent_permissions

    assert agent_permissions.RECENT_CAP == 100 and agent_permissions.LIST_CAP == 200


async def test_the_plaintext_decision_does_not_wait_for_a_REVOKED_sibling_setup(world):
    """lens 5848 (low): the lock covers the live siblings; a revoked setup of the same Mac (it cannot report a card) is not waited for — a Mac that is installed again and again does not make every card lock a growing pile of dead rows."""
    import asyncio

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from tests.test_4424_desktop_setup_realdb import _ASYNC

    a_name, b_name = "d4424 mac 4972mi", "d4424 mac 4972mj"
    mk = "mk-4972-rev-" + uuid.uuid4().hex[:8]
    async with _client() as c:
        dev_a = await _device(c, name=a_name); agent_a = await _with_session(c, dev_a)
        await _device(c, name=b_name)
        await _sql(f"UPDATE desktop_setups SET machine_key = '{mk}' WHERE device_name IN ('{a_name}','{b_name}')")
        await _sql(f"UPDATE desktop_setups SET revoked_at = now(), revoked_reason = 'replaced_by_new_setup' WHERE device_name = '{b_name}'")
        eng = create_async_engine(_ASYNC, poolclass=NullPool)
        try:
            async with async_sessionmaker(eng)() as holder:
                await holder.execute(text("SELECT id FROM desktop_setups WHERE device_name = :n FOR UPDATE"), {"n": b_name})  # the REVOKED sibling's row is held
                r = await asyncio.wait_for(_post_ask(c, dev_a, _plain(agent_a)), 8)
                assert r.status_code == 201, r.text
                await holder.rollback()
        finally:
            await eng.dispose()


async def test_a_request_that_authenticated_before_its_setup_was_revoked_takes_no_card_and_stands_no_mark(world):
    """codex delta on lens 5848 (medium): the token check is a read without a lock; the setup of an in-flight request can be revoked after it. Under the lock the setup is read again — a revoked setup refuses (401) and its sealed card does not stand a mark."""
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.models.desktop_setup import DesktopSetup
    from app.services import agent_permissions
    from app.services.desktop_relay import DesktopRelayError
    from tests.test_4424_desktop_setup_realdb import _ASYNC

    name = "d4424 mac 4972mk"
    async with _client() as c:
        dev, agent, p1 = await _sealed_computer(c, name)
        sid = await _setup_id(name)
        body = agent_permissions.PermissionRequestReport(**_sealed_to(agent, sid, p1))
        eng = create_async_engine(_ASYNC, poolclass=NullPool)
        try:
            async with async_sessionmaker(eng)() as db:
                setup = (await db.execute(select(DesktopSetup).where(DesktopSetup.id == sid))).scalar_one()  # «authenticated»: the row is in hand and live
                await _sql(f"UPDATE desktop_setups SET revoked_at = now(), revoked_reason = 'replaced_by_new_setup' WHERE id = '{sid}'")  # the revocation commits AFTER the authentication
                with pytest.raises(DesktopRelayError) as e:
                    await agent_permissions.report_request(db, setup, body)
                assert e.value.status == 401
                await db.rollback()
        finally:
            await eng.dispose()
        assert await _mark(name) is None, "a revoked setup's card stands no mark"
