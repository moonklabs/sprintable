"""story 4972 (카디르 5848 알림 · PO 8821) — the plaintext words of a plain card (tool · summary · workdir) go when its question ends.

Every end path takes them with it (an answer · a withdrawal · a window that passed — a plain card without a preview too · the last phone taken off), an OPEN card keeps them, and the network question keeps its
FIXED vocabulary (its second stage reopens the same row). Migration 0484 does it once for the rows that were already over, and relaxes the CHECK so an ended plain row may lack its words — a pending one may not.
"""
from __future__ import annotations

import importlib.util
import inspect
import pathlib
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
from tests.test_4533_agent_permissions_realdb import (  # noqa: F401
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

pytestmark = pytest.mark.anyio

WORDS = ("tool", "summary", "workdir")


async def _row(request_id):
    r = (await _sql(fetch=f"SELECT state, tool, summary, workdir, input_hash IS NOT NULL FROM agent_permission_requests WHERE request_id = '{request_id}'"))[0]
    return tuple(r)


def _net_first_stage(agent):
    """the network question's exact first-stage shape (the fixed vocabulary the server takes as plain text)"""
    return {**_ask(agent), "tool": "SandboxNetwork", "summary": "network", "masked": False, "truncated": False, "workdir": None}


async def test_an_answer_takes_the_plain_words_with_it_and_an_open_card_keeps_its_own(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4972ew1")
        agent = await _with_session(c, device)
        paired_id, der = await _register(c)
        await _pair(c, device["device_token"], der)
        a, b = _ask(agent), _ask(agent)
        assert (await _post_ask(c, device, a)).status_code == 201 and (await _post_ask(c, device, b)).status_code == 201
        listed = {r["request_id"]: r for r in (await c.get(REQS, headers=_person(OWNER))).json()["requests"]}
        assert listed[a["request_id"]]["summary"] and listed[a["request_id"]]["tool"] == "Bash"  # while it waits: its words
        ok = await c.post(f"{REQS}/{listed[a['request_id']]['id']}/answer", json=_answer(paired_id), headers=_person(OWNER))
        assert ok.status_code == 200 and ok.json()["state"] == "answered", ok.text
        assert await _row(a["request_id"]) == ("answered", None, None, None, True), "answered: no word stays (the hash is not part of this change)"
        assert (await _row(b["request_id"]))[:4] == ("pending", "Bash", "npm install --save ••••(가림)", "~/w"), "the open card keeps its words"
        done = {r["request_id"]: r for r in (await c.get(REQS, headers=_person(OWNER))).json()["requests"]}[a["request_id"]]
        assert (done["tool"], done["tool_name"], done["summary"], done["workdir"]) == (None, None, None, None), "the list carries none either"


async def test_a_withdrawal_and_a_window_that_passed_take_the_plain_words(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4972ew2")
        agent = await _with_session(c, device)
        w, e = _ask(agent), _ask(agent)
        for body in (w, e):
            assert (await _post_ask(c, device, body)).status_code == 201
        w_resp = await c.post(f"/api/v2/desktop/relay/permission-requests/{w['request_id']}/withdraw", json={"reason": "answered_locally"}, headers=_tok(device["device_token"]))
        assert w_resp.status_code == 200 and w_resp.json()["state"] == "withdrawn", w_resp.text
        assert await _row(w["request_id"]) == ("withdrawn", None, None, None, True), "withdrawn"
        # a window that passed without an answer — a plain card with NO preview (before: it stayed `pending` with its words for ever): the next report ends it and takes the words
        await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '5 minutes' WHERE request_id = '{e['request_id']}'")
        assert (await _post_ask(c, device, _ask(agent))).status_code == 201
        assert await _row(e["request_id"]) == ("expired", None, None, None, True), "the window passed: ended as expired, words gone"


async def test_the_minute_job_ends_an_expired_plain_card_and_a_held_row_waits_for_the_next_time(world):
    from app.services import agent_permissions
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from tests.test_4424_desktop_setup_realdb import _ASYNC

    async with _client() as c:
        device = await _device(c, name="d4424 mac 4972ew3")
        agent = await _with_session(c, device)
        a = _ask(agent)
        assert (await _post_ask(c, device, a)).status_code == 201
        await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '5 minutes' WHERE request_id = '{a['request_id']}'")
        assert (await _row(a["request_id"]))[0] == "pending", "(before the job: pending in the database, shown as expired)"
        eng = create_async_engine(_ASYNC, poolclass=NullPool)
        try:
            async with async_sessionmaker(eng)() as db:
                assert await agent_permissions.purge_open_cards(db) >= 1
                await db.commit()
        finally:
            await eng.dispose()
        assert await _row(a["request_id"]) == ("expired", None, None, None, True)


async def test_the_network_question_keeps_its_fixed_vocabulary_and_nothing_else(world):
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4972ew4")
        agent = await _with_session(c, device)
        paired_id, der = await _register(c)
        await _pair(c, device["device_token"], der)
        net = _net_first_stage(agent)
        assert (await _post_ask(c, device, net)).status_code == 201
        [view] = [r for r in (await c.get(REQS, headers=_person(OWNER))).json()["requests"] if r["request_id"] == net["request_id"]]
        ok = await c.post(f"{REQS}/{view['id']}/answer", json=_answer(paired_id), headers=_person(OWNER))
        assert ok.status_code == 200, ok.text
        assert await _row(net["request_id"]) == ("answered", "SandboxNetwork", "network", None, True), "the first stage's answer keeps the fixed words — the confirm stage opens this row again and the card draws it from them"


async def test_the_database_wants_the_words_of_a_pending_plain_card_and_lets_an_ended_one_go_without(world):
    from sqlalchemy.exc import DBAPIError

    async with _client() as c:
        device = await _device(c, name="d4424 mac 4972ew5")
        agent = await _with_session(c, device)
        a, b = _ask(agent), _ask(agent)
        assert (await _post_ask(c, device, a)).status_code == 201 and (await _post_ask(c, device, b)).status_code == 201
        with pytest.raises(Exception) as bad:  # a PENDING plain row without its words: refused
            await _sql(f"UPDATE agent_permission_requests SET tool = NULL, summary = NULL WHERE request_id = '{a['request_id']}'")
        assert "ck_agent_permission_requests_terminal_only_fields" in str(bad.value)
        await _sql(f"UPDATE agent_permission_requests SET state = 'expired', tool = NULL, summary = NULL, workdir = NULL WHERE request_id = '{b['request_id']}'")  # an ended one: allowed
        assert (await _row(b["request_id"]))[:4] == ("expired", None, None, None)
        assert DBAPIError  # (the exception type is the driver's; the rule is the constraint's name)


async def test_the_migration_clears_what_was_already_over_once_and_leaves_open_and_network_rows(world):
    """0484's two statements, run on rows made the way the old code left them: an answered row with words · an expired-in-time but `pending` plain row · an open row · a network row."""
    mod_path = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0484_agent_permission_ended_words.py"
    spec = importlib.util.spec_from_file_location("m0484t", mod_path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4972ew6")
        agent = await _with_session(c, device)
        paired_id, der = await _register(c)
        await _pair(c, device["device_token"], der)
        answered, lapsed, open_, net, nfinal = _ask(agent), _ask(agent), _ask(agent), _net_first_stage(agent), _net_first_stage(agent)
        netw = {**_net_first_stage(agent), "workdir": "~/w"}  # (not the exact first-stage shape: it carries a folder — the one network row the migration's UPDATE selects)
        for body in (answered, lapsed, open_, net, nfinal, netw):
            assert (await _post_ask(c, device, body)).status_code == 201
        # the old code kept the words of an ended row: put them back by hand (an ended row may carry them under either rule)
        await _sql(f"UPDATE agent_permission_requests SET state = 'answered', decision = 'allow' WHERE request_id = '{answered['request_id']}'")
        await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '5 minutes' WHERE request_id = '{lapsed['request_id']}'")
        await _sql(f"UPDATE agent_permission_requests SET state = 'withdrawn', result_code = 'session_ended' WHERE request_id IN ('{nfinal['request_id']}', '{netw['request_id']}')")
        assert (await _row(answered["request_id"]))[1:4] == ("Bash", "npm install --save ••••(가림)", "~/w")
        await _sql(m._END_PENDING)
        await _sql(m._CLEAR_ENDED)
        assert await _row(answered["request_id"]) == ("answered", None, None, None, True)
        assert await _row(lapsed["request_id"]) == ("expired", None, None, None, True), "a pending row whose window passed ends as expired"
        assert (await _row(open_["request_id"]))[:4] == ("pending", "Bash", "npm install --save ••••(가림)", "~/w"), "an open card is not touched"
        assert (await _row(net["request_id"]))[:4] == ("pending", "SandboxNetwork", "network", None), "a pending network question is not touched"
        assert (await _row(nfinal["request_id"]))[:4] == ("withdrawn", "SandboxNetwork", "network", None), "an ended network question keeps its fixed words"
        assert (await _row(netw["request_id"]))[:4] == ("withdrawn", "SandboxNetwork", "network", None), "…and when it also carried a folder: the folder goes, the fixed words stay"
        await _sql(m._CLEAR_ENDED)  # once more: nothing left to do, nothing breaks
        assert (await _row(answered["request_id"]))[0] == "answered"


def test_every_path_that_ends_a_question_takes_the_words_with_it():
    """a source pin for each end path (a behaviour test above covers the main ones; a path added later must do the same)"""
    from app.services import agent_permissions as ap

    assert "_end_words_of(row)" in inspect.getsource(ap.answer_request)
    assert "_end_words_of(row)" in inspect.getsource(ap.withdraw_request)
    for fn in (ap.purge_open_cards, ap._end_cards_without_phone, ap.end_orphan_cards):
        assert "_ended_words()" in inspect.getsource(fn), fn.__name__
    assert "_holds_plain_words()" in inspect.getsource(ap.purge_open_cards), "the purge ends a plain card whose window passed, with or without a preview"


def test_the_model_and_the_migration_state_the_same_words_rule():
    from app.models.agent_permission import AgentPermissionRequest

    mod_path = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0484_agent_permission_ended_words.py"
    spec = importlib.util.spec_from_file_location("m0484m", mod_path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    ck = next(c for c in AgentPermissionRequest.__table__.constraints if getattr(c, "name", None) == "ck_agent_permission_requests_terminal_only_fields")
    norm = lambda t: "".join(str(t).split())  # noqa: E731
    assert norm(ck.sqltext) == norm(m._NEW_RULE)
    assert "((tool IS NOT NULL AND summary IS NOT NULL) OR sealed OR state <> 'pending')" in m._NEW_RULE and "((tool IS NOT NULL AND summary IS NOT NULL) OR sealed)" in m._OLD_RULE


# ── the lock order kept by BEHAVIOUR (카디르 5848 short check · probes P9 · P10 · PO 8828) — a source pin alone cannot keep an order ──────────────────────────────────────────────────────────────────


async def _due_plain_card(c, device, agent):
    """a plain card whose window passed but that is still `pending` in the database (what the purge ends)"""
    body = _ask(agent)
    assert (await _post_ask(c, device, body)).status_code == 201
    await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '5 minutes' WHERE request_id = '{body['request_id']}'")
    return body


async def test_a_report_ends_the_rows_of_its_own_computer_only(world):
    """카디르 5848 short check (low · test): two computers each with a row to close; one reports → the other's row stays `pending` (the purge is scoped to the computer's own setup)"""
    async with _client() as c:
        dev_a = await _device(c, name="d4424 mac 4972ew7")
        dev_b = await _device(c, name="d4424 mac 4972ew8")
        agent_a, agent_b = await _with_session(c, dev_a), await _with_session(c, dev_b)
        row_a, row_b = await _due_plain_card(c, dev_a, agent_a), await _due_plain_card(c, dev_b, agent_b)
        assert (await _post_ask(c, dev_a, _ask(agent_a))).status_code == 201  # only A reports
        assert (await _row(row_a["request_id"]))[0] == "expired", "A's own row was ended"
        assert (await _row(row_b["request_id"]))[:2] == ("pending", "Bash"), "B's row — another computer's — was not touched by A's report"


async def _two_connections():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from tests.test_4424_desktop_setup_realdb import _ASYNC

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    return eng, async_sessionmaker(eng)()


async def test_an_answer_shaped_transaction_and_a_report_never_wait_for_each_other(world):
    """P9 (카디르): the answer path takes the REQUEST row first and then updates the SETUP row (`enqueue_command`). A report that took the setup rows first and then WAITED for that request row (the purge)
    would deadlock with it. Here: one transaction holds the due request row; a report runs; then the same transaction updates the setup row — no deadlock, the report is 201, the held row was skipped."""
    import asyncio

    from sqlalchemy import text

    async with _client() as c:
        dev = await _device(c, name="d4424 mac 4972ew9")
        agent = await _with_session(c, dev)
        due = await _due_plain_card(c, dev, agent)
        sid = (await _sql(fetch="SELECT id FROM desktop_setups WHERE device_name = 'd4424 mac 4972ew9'"))[0][0]
        eng, holder = await _two_connections()
        try:
            await holder.execute(text("SELECT id FROM agent_permission_requests WHERE request_id = :r FOR UPDATE"), {"r": due["request_id"]})  # the answer path: the request row first
            report = asyncio.create_task(_post_ask(c, dev, _ask(agent)))
            await asyncio.sleep(0.6)  # the report is past its setup lock now: finished, or (with the purge waiting for the held row) waiting while it holds the setup rows
            await asyncio.wait_for(holder.execute(text("UPDATE desktop_setups SET relay_command_seq = relay_command_seq + 1 WHERE id = :s"), {"s": sid}), 8)  # …then the setup row
            await holder.commit()
            assert (await asyncio.wait_for(report, 8)).status_code == 201
            assert (await _row(due["request_id"]))[0] == "pending", "(the held row was skipped, ended by the next report)"
        finally:
            await holder.rollback()
            await eng.dispose()


async def test_an_organization_delete_shaped_transaction_and_a_report_never_wait_for_each_other(world):
    """P10 (카디르): an organization's delete holds the SETUP row and then deletes its request rows. A report that touched the request rows (the purge) BEFORE taking the setup rows would hold a request row
    while waiting for the setup row the delete holds — and the delete waits for that request row: a deadlock. Here: one transaction holds the setup row; a report starts; then the same transaction updates the request row."""
    import asyncio

    from sqlalchemy import text

    async with _client() as c:
        dev = await _device(c, name="d4424 mac 4972ewa")
        agent = await _with_session(c, dev)
        due = await _due_plain_card(c, dev, agent)
        sid = (await _sql(fetch="SELECT id FROM desktop_setups WHERE device_name = 'd4424 mac 4972ewa'"))[0][0]
        eng, holder = await _two_connections()
        try:
            await holder.execute(text("SELECT id FROM desktop_setups WHERE id = :s FOR UPDATE"), {"s": sid})  # the delete path: the setup row first
            report = asyncio.create_task(_post_ask(c, dev, _ask(agent)))
            await asyncio.sleep(0.6)  # the report is waiting for the setup row (or, in the wrong order, already holds the request row)
            await asyncio.wait_for(holder.execute(text("UPDATE agent_permission_requests SET state = 'expired' WHERE request_id = :r"), {"r": due["request_id"]}), 8)  # …then its request rows
            await holder.commit()
            assert (await asyncio.wait_for(report, 8)).status_code == 201
        finally:
            await holder.rollback()
            await eng.dispose()


async def test_taking_off_the_last_phone_ends_a_plain_card_that_has_no_preview_and_takes_its_words(world):
    """codex (0484 · PO 8829 — a real defect): the pair-removal path ended only the cards with an envelope or a preview; a plain card with neither stayed `pending` with its words until its window passed."""
    from tests.test_4533_agent_permissions_realdb import PHONES

    async with _client() as c:
        device = await _device(c, name="d4424 mac 4972ewb")
        agent = await _with_session(c, device)
        p1, der1 = await _register(c, label="one")
        p2, der2 = await _register(c, label="two")
        await _pair(c, device["device_token"], der1, der2)
        body = _ask(agent)
        assert (await _post_ask(c, device, body)).status_code == 201
        assert (await c.delete(f"{PHONES}/{p1}", headers=_person(OWNER))).status_code in (200, 204)
        assert (await _row(body["request_id"]))[:2] == ("pending", "Bash"), "another phone is still paired: the card stays, with its words"
        assert (await c.delete(f"{PHONES}/{p2}", headers=_person(OWNER))).status_code in (200, 204)
        assert await _row(body["request_id"]) == ("withdrawn", None, None, None, True), "the last phone is off: the card ends and its words go"


async def test_a_terminal_only_card_without_a_tool_name_loses_its_summary_too(world):
    """codex (0484 · high): `tool` is nullable — with a NULL tool the «not the network question» test was SQL NULL and the row was never selected, so its summary stayed for ever"""
    async with _client() as c:
        device = await _device(c, name="d4424 mac 4972ewc")
        agent = await _with_session(c, device)
        body = _ask(agent)
        del body["tool"], body["input_hash"]
        body["terminal_only"] = True
        body["workdir"] = None  # (no folder: the SUMMARY alone is what makes the row «hold words» — with a folder the row was selected by that branch whatever the tool test said)
        made = await _post_ask(c, device, body)
        assert made.status_code == 201, made.text
        assert (await _row(body["request_id"]))[1:4] == (None, "npm install --save ••••(가림)", None), "(a terminal-only row that did not read its tool: a summary and no tool, no folder)"
        await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '5 minutes' WHERE request_id = '{body['request_id']}'")
        assert (await _post_ask(c, device, _ask(agent))).status_code == 201  # the next report ends it
        assert (await _row(body["request_id"]))[:4] == ("expired", None, None, None)
        # the migration's statement says the same: a NULL tool is not the network question
        mod_path = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0484_agent_permission_ended_words.py"
        spec = importlib.util.spec_from_file_location("m0484n", mod_path)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        assert "COALESCE(tool, '') = 'SandboxNetwork'" in m._NET


async def test_a_card_the_purge_ended_stays_in_the_list_for_its_hour_whatever_newer_rows_there_are(world, monkeypatch):
    """codex (0484 · medium): the list took the «just lapsed» rows only from raw `pending` — a plain card the purge ended is raw `expired` now, and with more than RECENT_CAP newer rows it fell out of the list inside its own hour"""
    from app.services import agent_permissions as ap

    async with _client() as c:
        device = await _device(c, name="d4424 mac 4972ewd")
        agent = await _with_session(c, device)
        old = _ask(agent)
        assert (await _post_ask(c, device, old)).status_code == 201
        await _sql(f"UPDATE agent_permission_requests SET expires_at = now() - interval '5 minutes', created_at = now() - interval '30 minutes' WHERE request_id = '{old['request_id']}'")
        for _ in range(4):  # four NEWER rows, ended
            b = _ask(agent)
            assert (await _post_ask(c, device, b)).status_code == 201
            await _sql(f"UPDATE agent_permission_requests SET state = 'withdrawn', tool = NULL, summary = NULL, workdir = NULL WHERE request_id = '{b['request_id']}'")
        assert (await _post_ask(c, device, _ask(agent))).status_code == 201  # the report that ends `old` (raw `expired` now)
        assert (await _row(old["request_id"]))[0] == "expired"
        monkeypatch.setattr(ap, "RECENT_CAP", 2)
        got = {r["request_id"] for r in (await c.get(REQS, headers=_person(OWNER))).json()["requests"]}
        assert old["request_id"] in got, "the ended-by-purge card is still in the list (its own hour)"


async def test_taking_a_pair_off_does_not_end_the_look_only_card_of_a_person_who_never_paired_a_phone(world):
    """codex 2nd review (medium): the plain-card branch of the pair-removal end used only «this recipient has no live phone» — a `no_paired_phone` card (nobody ever paired) was ended whenever a pair came off that computer. Only a person who LOST a phone loses their card."""
    from app.core.database import async_session_factory
    from app.services.agent_permissions import _end_cards_without_phone

    async with _client() as c:
        device = await _device(c, name="d4424 mac 4972ewe")
        agent = await _with_session(c, device)
        body = _ask(agent)  # no phone paired at all: the card goes to the chain's head as a look-only / no_paired_phone card
        made = await _post_ask(c, device, body)
        assert made.status_code == 201 and made.json()["recipient_reason"] == "no_paired_phone", made.text
        sid = (await _sql(fetch="SELECT id FROM desktop_setups WHERE device_name = 'd4424 mac 4972ewe'"))[0][0]
        async with async_session_factory() as s:
            assert await _end_cards_without_phone(s, {sid}) == 0  # (what a pair removal on this computer runs)
            await s.commit()
        assert (await _row(body["request_id"]))[:2] == ("pending", "Bash"), "nobody lost a phone: the card and its words stay"


async def test_a_phone_lost_BEFORE_the_card_was_made_is_no_reason_to_end_it_when_another_pair_comes_off_later(world):
    """codex 3rd review (medium): `lost_a_pair` matched any retained historical removal — a plain card made AFTER a person lost their phone could be ended by an unrelated removal on the same computer. The loss must be one the card lived through."""
    from tests.test_4533_agent_permissions_realdb import PHONES
    from app.core.database import async_session_factory
    from app.services.agent_permissions import _end_cards_without_phone

    async with _client() as c:
        device = await _device(c, name="d4424 mac 4972ewf")
        agent = await _with_session(c, device)
        p1, der1 = await _register(c, label="one")
        await _pair(c, device["device_token"], der1)
        assert (await c.delete(f"{PHONES}/{p1}", headers=_person(OWNER))).status_code in (200, 204)  # the person LOSES their phone (before any card)
        body = _ask(agent)  # …and then a plain card is made (no phone: look-only)
        assert (await _post_ask(c, device, body)).status_code == 201
        sid = (await _sql(fetch="SELECT id FROM desktop_setups WHERE device_name = 'd4424 mac 4972ewf'"))[0][0]
        async with async_session_factory() as s:
            assert await _end_cards_without_phone(s, {sid}) == 0  # an unrelated pair comes off this computer later
            await s.commit()
        assert (await _row(body["request_id"]))[:2] == ("pending", "Bash"), "the loss came before the card: the card stays"
