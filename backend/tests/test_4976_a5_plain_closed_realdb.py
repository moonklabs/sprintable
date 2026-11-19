"""story 4976 (A5 · AC4) — the plaintext road of an instruction into a running turn is closed for a computer that said it opens a sealed one.

The computer says `sealed_prompt: true` with its startable list; the server stands `desktop_setups.sealed_prompts_at` (its own now(), first one kept, one way — a trigger, read by `org_id + machine_key` like the card mark);
from then on a plain `send_prompt` is 422 `sealed_required` — a fixed sentence, no `detail`, not a word of the body back, no command made. Each test goes red without the line it names.
"""
from __future__ import annotations

import asyncio
import importlib.util
import uuid
from pathlib import Path

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG2,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _tok
from tests.test_4529_desktop_relay_realdb import _device
from tests.test_4533_agent_permissions_realdb import _pair, _register
from tests.test_4534_desktop_commands_realdb import _cmd, _dm, _post, _remote_control_on, _state, _world  # noqa: F401
from tests.test_4424_desktop_setup_realdb import OWNER_TM
from tests.test_4976_sealed_prompt_realdb import MARKER, _sealed_cmd, _setup_id

pytestmark = pytest.mark.anyio


async def _says(c, device, **words):
    r = await c.put("/api/v2/desktop/relay/startable", json={"startable": [], **words}, headers=_tok(device["device_token"]))
    assert r.status_code == 200, r.text


async def _more(c, name, phone, der):
    """another computer of the same owner, its agent working, the SAME phone paired to it (a person may hold three phones at most — five worlds of one test share one)"""
    device = await _device(c, name=name)
    agent = device["agents"][0]["member_id"]
    await _state(c, device, agent, "working", 1)
    await _pair(c, device["device_token"], der)
    return device, agent, phone, der, await _dm(OWNER_TM, agent)


async def _mark(name):
    return (await _sql(fetch=f"SELECT sealed_prompts_at FROM desktop_setups WHERE device_name = '{name}'"))[0][0]


async def _count(sid):
    return (await _sql(fetch=f"SELECT count(*) FROM desktop_commands WHERE kind = 'send_prompt' AND setup_id = '{sid}'"))[0][0]


async def test_a_computer_that_says_it_opens_a_sealed_instruction_takes_no_plain_one_and_nothing_of_the_body_comes_back(world):
    name = "d4976 a5 mac a"
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, name)
        sid = await _setup_id(name)
        assert (await _post(c, agent, _cmd("send_prompt", phone, conv=conv))).status_code == 201, "control: before the word, the plain road is as it was"
        assert await _mark(name) is None
        n0 = await _count(sid)
        await _says(c, device, sealed_prompt=True)
        assert await _mark(name) is not None, "the computer said it: the mark stands"
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv, text=f"{MARKER} plain after the mark"))
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "sealed_required" and "detail" not in r.json()["error"], r.text
        assert MARKER not in r.text, "not a word of the body comes back"
        assert await _count(sid) == n0, "no command is made"
        # a re-send of the same plain body is the same answer (no branch that tells the first from the second)
        again = await _post(c, agent, _cmd("send_prompt", phone, conv=conv, text=f"{MARKER} plain after the mark"))
        assert again.status_code == 422 and again.json()["error"]["code"] == "sealed_required"
        # the sealed road is the way in
        assert (await _post(c, agent, _sealed_cmd(sid, phone, conv))).status_code == 201
        # only an instruction is closed: a stop is not an instruction
        assert (await _post(c, agent, _cmd("stop_session", phone))).status_code == 201


async def test_the_same_press_again_gets_back_the_command_it_made_before_the_mark_and_makes_no_new_one(world):
    """codex 4976 A5: the idempotent re-post (the same key — Kadir 4955: «whatever the computer says now») returns the plain command that was made BEFORE the mark; it makes nothing new, so the closed road stays closed for every NEW plain instruction
    (a different key is refused). What was already queued is the person's own earlier press — its words are on the server already; the mark closes the road, it does not reach back."""
    name = "d4976 a5 mac idem"
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, name)
        sid = await _setup_id(name)
        body = _cmd("send_prompt", phone, conv=conv)
        first = await _post(c, agent, body)
        assert first.status_code == 201, first.text
        await _says(c, device, sealed_prompt=True)
        again = await _post(c, agent, body)  # the same key, after the mark
        assert again.status_code == 201 and again.json()["command_id"] == first.json()["command_id"], again.text
        assert await _count(sid) == 1, "no second command"
        other = await _post(c, agent, _cmd("send_prompt", phone, conv=conv))  # another key: a NEW plain instruction
        assert other.status_code == 422 and other.json()["error"]["code"] == "sealed_required", other.text


async def test_the_mark_stands_only_from_the_word_true_not_from_a_list_without_it(world):
    name = "d4976 a5 mac b"
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, name)
        await _says(c, device)  # a list with no word (an app from before)
        assert await _mark(name) is None
        await _says(c, device, computer_press=True)  # another word
        assert await _mark(name) is None
        assert (await _post(c, agent, _cmd("send_prompt", phone, conv=conv))).status_code == 201, "an app from before keeps the plain road"
        r = await c.put("/api/v2/desktop/relay/startable", json={"startable": [], "sealed_prompt": False}, headers=_tok(device["device_token"]))
        assert r.status_code == 422 and await _mark(name) is None, "false is not a word the computer may say"


async def test_the_mark_is_one_way_a_list_without_the_word_takes_the_capability_out_not_the_mark_and_the_database_says_no_to_a_clear(world):
    name = "d4976 a5 mac c"
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, name)
        await _says(c, device, sealed_prompt=True)
        first = await _mark(name)
        await _says(c, device, sealed_prompt=True)
        assert await _mark(name) == first, "the first time is kept: a repeated word does not move it"
        await _says(c, device)  # the app went back
        assert (await _sql(fetch=f"SELECT capabilities FROM desktop_setups WHERE device_name = '{name}'"))[0][0] in (None, []), "the capability goes out…"
        assert await _mark(name) == first, "…the mark does not"
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv))
        assert r.status_code == 422 and r.json()["error"]["code"] == "sealed_required", "the road stays shut for a computer that went back (it can only be reached sealed)"
        for sql in (f"UPDATE desktop_setups SET sealed_prompts_at = NULL WHERE device_name = '{name}'",
                    f"UPDATE desktop_setups SET sealed_prompts_at = sealed_prompts_at - interval '1 day' WHERE device_name = '{name}'"):
            with pytest.raises(Exception) as e:
                await _sql(sql)
            assert "one-way" in str(e.value), str(e.value)
        assert await _mark(name) == first


async def test_a_replaced_setup_and_a_sibling_lane_of_the_same_mac_keep_the_mark_other_organizations_and_no_machine_key_do_not(world):
    mk = "mk-4976-a5-" + uuid.uuid4().hex[:8]
    async with _client() as c:
        a_name, b_name, c_name, d_name, e_name = (f"d4976 a5 mac s{x}" for x in "abcde")
        dev_a, agent_a, phone_a, der, conv_a = await _world(c, a_name)
        dev_b, agent_b, phone_b, _d2, conv_b = await _more(c, b_name, phone_a, der)  # the same Mac: a replacement · a sibling lane
        dev_c, _ag_c, _p_c, _d3, _cv_c = await _more(c, c_name, phone_a, der)  # the same machine key, ANOTHER organization
        dev_d, agent_d, phone_d, _d4, conv_d = await _more(c, d_name, phone_a, der)  # no machine key at all
        dev_e, agent_e, phone_e, _d5, conv_e = await _more(c, e_name, phone_a, der)  # a machine key of its own: the ONLY mark with it sits in another organization
        mk2 = mk + "-2"
        await _sql(f"UPDATE desktop_setups SET machine_key = '{mk}' WHERE device_name IN ('{a_name}','{b_name}')")
        await _sql(f"UPDATE desktop_setups SET machine_key = '{mk2}' WHERE device_name = '{e_name}'")
        await _sql(f"UPDATE desktop_setups SET machine_key = '{mk2}', org_id = '{ORG2}', sealed_prompts_at = now() WHERE device_name = '{c_name}'")
        await _says(c, dev_a, sealed_prompt=True)
        await _sql(f"UPDATE desktop_setups SET revoked_at = now(), revoked_reason = 'replaced_by_new_setup' WHERE device_name = '{a_name}'")  # A is the replaced one: its mark is kept
        r = await _post(c, agent_b, _cmd("send_prompt", phone_b, conv=conv_b))
        assert r.status_code == 422 and r.json()["error"]["code"] == "sealed_required", r.text  # the new setup's first plain instruction: refused at once
        assert (await _post(c, agent_e, _cmd("send_prompt", phone_e, conv=conv_e))).status_code == 201  # the same key's mark in ANOTHER organization is not this one's
        assert (await _post(c, agent_d, _cmd("send_prompt", phone_d, conv=conv_d))).status_code == 201  # no machine key: its own mark only (a known limit — written down)


async def test_the_plain_decision_waits_for_a_sibling_setup_of_the_same_mac_the_lock_covers_the_machine_not_one_row(world):
    """the mark is shared by org + machine_key, so the lock must be too: another connection holds a FOR UPDATE on the SIBLING's row; A's plain instruction must WAIT for it (and then be taken — no mark stood)."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from tests.test_4424_desktop_setup_realdb import _ASYNC

    a_name, b_name = "d4976 a5 mac la", "d4976 a5 mac lb"
    mk = "mk-4976-a5-lock-" + uuid.uuid4().hex[:8]
    async with _client() as c:
        dev_a, agent_a, phone_a, der, conv_a = await _world(c, a_name)
        await _more(c, b_name, phone_a, der)
        await _sql(f"UPDATE desktop_setups SET machine_key = '{mk}' WHERE device_name IN ('{a_name}','{b_name}')")
        eng = create_async_engine(_ASYNC, poolclass=NullPool)
        try:
            async with async_sessionmaker(eng)() as holder:
                await holder.execute(text("SELECT id FROM desktop_setups WHERE device_name = :n FOR UPDATE"), {"n": b_name})  # the sibling's row is held
                task = asyncio.create_task(_post(c, agent_a, _cmd("send_prompt", phone_a, conv=conv_a)))
                await asyncio.sleep(1.5)
                assert not task.done(), "A's plain decision did not wait for the sibling setup of the same Mac (the lock covers one row only)"
                await holder.commit()
            r = await asyncio.wait_for(task, 15)
            assert r.status_code == 201, r.text
        finally:
            await eng.dispose()


async def test_a_plain_instruction_and_the_word_at_the_same_moment_end_consistently_in_either_order(world):
    async with _client() as c:
        for i in range(3):
            name = f"d4976 a5 mac r{i}"
            device, agent, phone, _der, conv = await _world(c, name)
            r_word, r_plain = await asyncio.gather(c.put("/api/v2/desktop/relay/startable", json={"startable": [], "sealed_prompt": True}, headers=_tok(device["device_token"])),
                                                   _post(c, agent, _cmd("send_prompt", phone, conv=conv)))
            assert r_word.status_code == 200, r_word.text
            assert await _mark(name) is not None
            assert r_plain.status_code in (201, 422), r_plain.text  # 201: the plain one went first · 422: after — never an error
            assert (await _post(c, agent, _cmd("send_prompt", phone, conv=conv))).status_code == 422, "from the mark on the road is shut"


def _migration(monkeypatch):
    path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0489_desktop_setups_sealed_prompts.py"
    spec = importlib.util.spec_from_file_location("m0489", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    assert (mod.revision, mod.down_revision) == ("0489", "0488")
    return mod


async def test_the_migration_marks_a_computer_that_already_says_the_word_and_nobody_else(world, monkeypatch):
    mod = _migration(monkeypatch)
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(mod.op, "add_column", lambda t, col: calls.append(("add_column", f"{t}.{col.name}")))
    monkeypatch.setattr(mod.op, "execute", lambda sql: calls.append(("execute", str(sql))))
    mod.upgrade()
    assert calls[0] == ("add_column", "desktop_setups.sealed_prompts_at")
    backfill = calls[1][1]
    assert "capabilities @>" in backfill and "sealed_prompt" in backfill and backfill.lstrip().startswith("UPDATE desktop_setups")
    assert "one_way" in calls[2][1] and "CREATE OR REPLACE FUNCTION" in calls[2][1], "the trigger comes after the backfill (a backfill under it would be allowed anyway: NULL → time is not a change of a set value)"
    async with _client() as c:
        said, _a1, _p1, _d1, _c1 = await _world(c, "d4976 a5 mac ma")
        quiet, _a2, _p2, _d2, _c2 = await _more(c, "d4976 a5 mac mb", _p1, _d1)
        await _sql("UPDATE desktop_setups SET capabilities = '[\"move\", \"sealed_prompt\"]'::jsonb WHERE device_name = 'd4976 a5 mac ma'")
        await _sql("UPDATE desktop_setups SET capabilities = '[\"move\", \"computer_press\"]'::jsonb WHERE device_name = 'd4976 a5 mac mb'")
        await _sql(backfill)
        assert await _mark("d4976 a5 mac ma") is not None and await _mark("d4976 a5 mac mb") is None
