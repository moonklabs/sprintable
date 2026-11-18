"""story 4976 (A1) — a phone's instruction into the running turn, sealed: the server holds no word of it.

What each test pins (each goes red when its line of the change is put back):
- the SEALED road: {session_key, conversation_id, envelope} is all the row holds — no text, no plain signature (it carries an unsalted sha256 of the words), nothing readable; the header must be
  about THIS press; one road or the other, never both, never neither;
- a press that is over (done · failed · rejected — also by the switch-off path) keeps {session_key, conversation_id} only; the plain road's words go too;
- the conversation line of a done sealed instruction is the fixed words (the server never had the text); a plain one still writes its words (the person's own record — story 4977 replaces it);
- a refused press never sends the words back (FastAPI's 422 carries each error's `input`);
- the migration clears the old ended rows once and leaves the open ones.
"""
from __future__ import annotations

import base64
import importlib.util
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    OWNER,
    OWNER_TM,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _tok
from tests.test_4534_desktop_commands_realdb import _cmd, _post, _remote_control_on, _world  # noqa: F401 — the autouse fixture applies here too
from tests.test_4535_org_remote_control_realdb import _switch as _remote_control_switch  # noqa: F401

pytestmark = pytest.mark.anyio

MARKER = "MK4976words"


def b64(n: int) -> str:
    return base64.urlsafe_b64encode(b"\x09" * n).rstrip(b"=").decode()


def now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def sealed_env(setup_id, key, /, session_key="s-1", **over):
    ts = now_ms()
    env = {
        "v": 1, "kind": "send_prompt", "setup_id": str(setup_id), "session_key": session_key, "command_id": key, "expires_at": ts + 120_000,
        "from": "phone-1", "to": ["host-1"], "epoch": 1, "ctr": 0, "ts": ts, "nonce": b64(16),
        "wraps": [{"to": "host-1", "enc": b64(32), "ek": b64(48)}], "ct": b64(120), "sig": b64(71),
    }
    env.update(over)
    return env


async def _setup_id(name):
    return (await _sql(fetch=f"SELECT id FROM desktop_setups WHERE device_name = '{name}'"))[0][0]


def _sealed_cmd(setup_id, phone, conv, *, key=None, **env_over):
    key = key or str(uuid.uuid4())
    return {"kind": "send_prompt", "session_key": "s-1", "idempotency_key": key, "phone_key_id": phone, "conversation_id": conv,
            "envelope": sealed_env(setup_id, key, **env_over)}


async def _row(cid):
    return (await _sql(fetch=f"SELECT payload, state, kind FROM desktop_commands WHERE id = '{cid}'"))[0]


async def _result(c, device, cid, state, code=None):
    body = {"state": state, **({"result_code": code} if code else {})}
    r = await c.post(f"/api/v2/desktop/relay/commands/{cid}/result", json=body, headers=_tok(device["device_token"]))
    assert r.status_code == 200, r.text


async def _lines(conv):
    return [r[0] for r in await _sql(fetch=f"SELECT content FROM conversation_messages WHERE conversation_id = '{conv}' ORDER BY created_at")]


async def test_a_sealed_press_holds_no_word_and_its_header_must_be_its_own(world):
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4976 mac a")
        sid = await _setup_id("d4976 mac a")
        ok = await _post(c, agent, _sealed_cmd(sid, phone, conv))
        assert ok.status_code == 201, ok.text
        payload, state, _k = await _row(ok.json()["command_id"])
        assert state == "queued"
        assert set(payload) == {"session_key", "conversation_id", "envelope"}  # no `text` · no `signed` (a plain signature holds sha256 of the words)
        # a header that is not this press's: another computer · another session · another press id · a time far from now · an expiry before its own time
        key = str(uuid.uuid4())
        old, future = now_ms() - 3_600_000, now_ms() + 3_600_000  # a whole hour away, each with a lifetime of its own that is fine: only the clock check can refuse them
        for over in ({"setup_id": str(uuid.uuid4())}, {"session_key": "s-other"}, {"command_id": str(uuid.uuid4())}, {"ts": old, "expires_at": old + 120_000},
                     {"ts": future, "expires_at": future + 120_000}, {"expires_at": now_ms() - 5_000}, {"expires_at": now_ms() + 3_600_000}):
            r = await _post(c, agent, {**_sealed_cmd(sid, phone, conv, key=key), "envelope": sealed_env(sid, key, **over)})
            assert r.status_code == 422 and r.json()["error"]["code"] == "envelope_header_mismatch", (over, r.text)
        assert len(await _sql(fetch="SELECT id FROM desktop_commands WHERE kind = 'send_prompt'")) == 1  # none of them was kept


async def test_one_road_never_both_never_neither(world):
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4976 mac b")
        sid = await _setup_id("d4976 mac b")
        sealed = _sealed_cmd(sid, phone, conv)
        for bad in (
            {**sealed, "text": "a plain copy beside it"},  # both
            {**sealed, "signed": "eyJ2IjoxfQ.signed"},  # the plain signature beside the envelope
            {k: v for k, v in sealed.items() if k != "conversation_id"},  # no conversation
            {**sealed, "kind": "stop_session"},  # only an instruction is sealed
            {k: v for k, v in {**sealed, "kind": "stop_session"}.items() if k != "conversation_id"},  # (the same, so that no other line of the endpoint refuses it first)
            {**_cmd("send_prompt", phone, conv=conv), "signed": None},  # a plain press without its signature
            {k: v for k, v in _cmd("send_prompt", phone, conv=conv).items() if k not in ("text", "signed")},  # neither
            {**sealed, "envelope": {**sealed["envelope"], "kind": "approval_card"}},  # another kind of envelope
            {**sealed, "envelope": {**sealed["envelope"], "extra": 1}},  # not the agreed shape
            {**sealed, "envelope": {**sealed["envelope"], "ct": b64(8 * 1024 + 17)}},  # past the size an instruction's envelope may have (the card's cap is its own)
        ):
            r = await _post(c, agent, bad)
            assert r.status_code == 422, (list(bad), r.text)
        assert (await _sql(fetch="SELECT count(*) FROM desktop_commands WHERE kind = 'send_prompt'"))[0][0] == 0
        # control: the plain road is as it was (the same four keys · nothing else)
        plain = await _post(c, agent, _cmd("send_prompt", phone, conv=conv))
        assert plain.status_code == 201
        assert set((await _row(plain.json()["command_id"]))[0]) == {"session_key", "text", "conversation_id", "signed"}


async def test_a_finished_press_keeps_no_word_on_either_road_and_a_sealed_one_writes_the_fixed_line(world):
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4976 mac c")
        sid = await _setup_id("d4976 mac c")
        sealed = (await _post(c, agent, _sealed_cmd(sid, phone, conv))).json()["command_id"]
        plain = (await _post(c, agent, _cmd("send_prompt", phone, conv=conv, text=f"{MARKER} 테스트도 돌려 줘"))).json()["command_id"]
        failed = (await _post(c, agent, _cmd("send_prompt", phone, conv=conv, text=f"{MARKER} 실패할 지시"))).json()["command_id"]
        refused = (await _post(c, agent, _sealed_cmd(sid, phone, conv))).json()["command_id"]
        await _result(c, device, sealed, "done")
        await _result(c, device, plain, "done")
        await _result(c, device, failed, "failed", "tool_open")
        await _result(c, device, refused, "rejected", "unsigned")
        for cid in (sealed, plain, failed, refused):
            payload, state, _k = await _row(cid)
            assert state in ("done", "failed", "rejected")
            assert set(payload) == {"session_key", "conversation_id"}, (state, list(payload))
        assert MARKER not in json.dumps([r[0] for r in await _sql(fetch="SELECT payload FROM desktop_commands")])
        lines = await _lines(conv)
        sealed_line = [x for x in lines if "잠긴 글" in x]
        assert len(sealed_line) == 1 and sealed_line[0] == "지시 · 지금 턴에 보냄 · 잠긴 글(앱에서 열기)"  # the fixed words — the server never had the text
        plain_lines = [x for x in lines if MARKER in x]
        assert len(plain_lines) == 1  # the person's own record of a plain instruction is as it was (story 4977 replaces it) — only the failed one wrote none
        assert "실패할" not in "".join(lines)


async def test_the_switch_off_path_empties_a_press_that_never_reached_the_computer(world):
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4976 mac d")
        sid = await _setup_id("d4976 mac d")
        sealed = (await _post(c, agent, _sealed_cmd(sid, phone, conv))).json()["command_id"]
        plain = (await _post(c, agent, _cmd("send_prompt", phone, conv=conv, text=f"{MARKER} 닿지 못한 지시"))).json()["command_id"]
        assert (await _remote_control_switch(c, False)).status_code == 200
        for cid in (sealed, plain):
            payload, state, _k = await _row(cid)
            assert state == "rejected" and set(payload) == {"session_key", "conversation_id"}, (state, list(payload))
        assert MARKER not in json.dumps([r[0] for r in await _sql(fetch="SELECT payload FROM desktop_commands")])


async def test_a_refused_press_never_sends_the_words_back(world):
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4976 mac e")
        sid = await _setup_id("d4976 mac e")
        for body in (
            _cmd("send_prompt", phone, conv=conv, text=f"{MARKER} " + "x" * 8100),  # past the bound: the default 422 would carry the whole body in `input`
            {**_cmd("send_prompt", phone, conv=conv, text=f"{MARKER} words"), "unknown_field": 1},
            {**_sealed_cmd(sid, phone, conv), "text": f"{MARKER} beside the envelope"},
            {**_sealed_cmd(sid, phone, conv), "envelope": {**sealed_env(sid, str(uuid.uuid4())), "from": f"{MARKER}-" + "y" * 400}},  # a field of the envelope past its bound
        ):
            r = await _post(c, agent, body)
            assert r.status_code == 422
            assert MARKER not in r.text, r.text
            assert '"input"' not in r.text
        # control: the answer's own shape (a list of errors with a location) stays — only `input` goes
        assert "loc" in (await _post(c, agent, {**_cmd("send_prompt", phone, conv=conv), "unknown_field": 1})).text


def _migration_sql(monkeypatch) -> str:
    path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0485_desktop_prompt_ended_payload.py"
    spec = importlib.util.spec_from_file_location("m0485", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    assert (mod.revision, mod.down_revision) == ("0485", "0484")
    got: list[str] = []
    monkeypatch.setattr(mod.op, "execute", lambda sql: got.append(str(sql)))  # (alembic's `op` is one shared module: undone at the end of the test, or every later migration test would run nothing)
    mod.upgrade()
    assert len(got) == 1
    return got[0]


async def test_the_migration_clears_the_ended_old_rows_once_and_leaves_the_open_ones(world, monkeypatch):
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4976 mac f")
        sid = await _setup_id("d4976 mac f")
        ids = {}
        for state in ("queued", "delivered", "acked", "done", "failed", "rejected"):
            cid = (await _post(c, agent, _cmd("send_prompt", phone, conv=conv, text=f"{MARKER} {state}"))).json()["command_id"]
            ids[state] = cid
        # put the rows into their states the way an OLD build left them (full payload kept): states set by SQL, the payload untouched
        for state, cid in ids.items():
            await _sql(f"UPDATE desktop_commands SET state = '{state}' WHERE id = '{cid}'")
        await _sql(f"UPDATE desktop_commands SET payload = payload - 'text' WHERE id = '{ids['failed']}'")  # (a finished row that holds the plain signature and no text: it is cleared too)
        sealed_done = (await _post(c, agent, _sealed_cmd(sid, phone, conv))).json()["command_id"]  # (the sealed road too: an envelope-only row has no `text` and no `signed`)
        sealed_open = (await _post(c, agent, _sealed_cmd(sid, phone, conv))).json()["command_id"]
        await _sql(f"UPDATE desktop_commands SET state = 'done' WHERE id = '{sealed_done}'")
        other = (await _post(c, agent, {**_cmd("stop_session", phone), "idempotency_key": "stop-1"})).json()["command_id"]
        await _sql(f"UPDATE desktop_commands SET state = 'done' WHERE id = '{other}'")
        before_other = (await _row(other))[0]
        await _sql(_migration_sql(monkeypatch))
        for state in ("queued", "delivered", "acked"):
            payload = (await _row(ids[state]))[0]
            assert MARKER in json.dumps(payload) and "signed" in payload, state  # open: not touched
        for state in ("done", "failed", "rejected"):
            assert set((await _row(ids[state]))[0]) == {"session_key", "conversation_id"}, state
        assert set((await _row(sealed_done))[0]) == {"session_key", "conversation_id"}  # a finished sealed row loses its envelope
        assert "envelope" in (await _row(sealed_open))[0]  # an open sealed row keeps it
        assert (await _row(other))[0] == before_other  # another kind is not touched
        await _sql(_migration_sql(monkeypatch))  # once is enough: a second run changes nothing
        assert set((await _row(ids["done"]))[0]) == {"session_key", "conversation_id"}


async def test_the_relay_payload_is_one_road_whatever_made_it():
    """`enqueue_command` is the one way any command is made: its own schema keeps the two roads apart even for a caller that skips the endpoint's checks."""
    import pytest as _pytest

    from app.services.desktop_relay import DesktopRelayError, validate_payload

    env = sealed_env(uuid.uuid4(), "k1")
    base = {"session_key": "s-1", "conversation_id": str(uuid.uuid4())}
    assert validate_payload("send_prompt", {**base, "envelope": env}).envelope == env
    assert validate_payload("send_prompt", {**base, "text": "hi", "signed": "eyJ2IjoxfQ.s"}).text == "hi"
    for bad in ({**base, "envelope": env, "text": "hi"}, {**base, "envelope": env, "signed": "eyJ2IjoxfQ.s"}, {**base, "text": "hi"}, {**base, "signed": "eyJ2IjoxfQ.s"}, dict(base)):
        with _pytest.raises(DesktopRelayError):
            validate_payload("send_prompt", bad)


def test_the_request_model_alone_keeps_the_roads_apart():
    """The endpoint's second line (the relay payload schema) would refuse most of these too; the first line must hold by itself."""
    from pydantic import ValidationError

    from app.services.desktop_commands import CommandRequest

    phone, conv, env = str(uuid.uuid4()), str(uuid.uuid4()), sealed_env(uuid.uuid4(), "k1")
    base = {"kind": "send_prompt", "session_key": "s-1", "idempotency_key": "k1", "phone_key_id": phone, "conversation_id": conv}
    assert CommandRequest(**base, envelope=env).envelope == env
    assert CommandRequest(**base, text="hi", signed="eyJ2IjoxfQ.s").text == "hi"
    for bad in (
        {**base, "kind": "stop_session", "envelope": env},  # an envelope on a stop
        {**base, "envelope": {**env, "kind": "approval_card"}},  # another kind of envelope
        {**base, "text": "hi"},  # a plain press without its signature
        {**base, "kind": "stop_session"},  # a stop without its signature
        {**base, "envelope": env, "text": "hi"},
        {**base, "envelope": env, "signed": "eyJ2IjoxfQ.s"},
    ):
        with pytest.raises(ValidationError):
            CommandRequest(**bad)
    with pytest.raises(ValidationError):
        CommandRequest(**{k: v for k, v in base.items() if k != "conversation_id"}, envelope=env)  # a sealed instruction names its conversation


async def _prompts_of(sid):
    return [(r[0], set(r[1])) for r in await _sql(fetch=f"SELECT state, payload FROM desktop_commands WHERE setup_id = '{sid}' AND kind = 'send_prompt' ORDER BY device_seq")]


async def test_a_computer_cut_off_keeps_no_word_of_an_instruction_in_any_state(world):
    """`reject_open_commands` ends the open ones; an ACKED one (the computer took it, then the line was cut) and the paths that end nothing need the scrub of their own."""
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4976 mac g")
        sid = await _setup_id("d4976 mac g")
        ids = []
        for i in range(3):
            body = _sealed_cmd(sid, phone, conv) if i % 2 == 0 else _cmd("send_prompt", phone, conv=conv, text=f"{MARKER} {i}")
            ids.append((await _post(c, agent, body)).json()["command_id"])
        await _sql(f"UPDATE desktop_commands SET state = 'acked' WHERE id = '{ids[0]}'", f"UPDATE desktop_commands SET state = 'delivered' WHERE id = '{ids[1]}'")
        r = await c.delete(f"/api/v2/desktop/setups/{sid}", headers=_person(OWNER))  # the computer is disconnected on the web
        assert r.status_code == 200, r.text
        rows = await _prompts_of(sid)
        assert len(rows) == 3 and all(keys == {"session_key", "conversation_id"} for _s, keys in rows), rows  # the acked one too
        assert MARKER not in json.dumps([x[0] for x in await _sql(fetch="SELECT payload FROM desktop_commands")])


async def test_the_switch_off_scrubs_an_acked_instruction_too(world):
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4976 mac h")
        sid = await _setup_id("d4976 mac h")
        cid = (await _post(c, agent, _sealed_cmd(sid, phone, conv))).json()["command_id"]
        await _sql(f"UPDATE desktop_commands SET state = 'acked' WHERE id = '{cid}'")
        assert (await _remote_control_switch(c, False)).status_code == 200
        assert await _prompts_of(sid) == [("acked", {"session_key", "conversation_id"})]  # still acked (the computer took it) and no envelope left


async def test_forget_prompts_touches_only_the_given_computers_and_only_instructions(world):
    from app.services.desktop_relay import forget_prompts
    from tests.test_4424_desktop_setup_realdb import _ASYNC  # noqa: F401
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    async with _client() as c:
        a = await _world(c, "d4976 mac i")
        b = await _world(c, "d4976 mac j")
        sid_a, sid_b = await _setup_id("d4976 mac i"), await _setup_id("d4976 mac j")
        for (device, agent, phone, _der, conv), sid in ((a, sid_a), (b, sid_b)):
            assert (await _post(c, agent, _sealed_cmd(sid, phone, conv))).status_code == 201
            assert (await _post(c, agent, {**_cmd("stop_session", phone), "idempotency_key": f"stop-{sid}"})).status_code == 201
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as db:
            assert await forget_prompts(db, []) == 0
            assert await forget_prompts(db, [sid_a]) == 1  # one instruction (the stop has none to forget)
            await db.commit()
    finally:
        await eng.dispose()
    assert await _prompts_of(sid_a) == [("queued", {"session_key", "conversation_id"})]
    assert "envelope" in (await _sql(fetch=f"SELECT payload FROM desktop_commands WHERE setup_id = '{sid_b}' AND kind = 'send_prompt'"))[0][0]  # another computer: untouched
    assert (await _sql(fetch=f"SELECT payload FROM desktop_commands WHERE setup_id = '{sid_a}' AND kind = 'stop_session'"))[0][0]["signed"]  # another kind: untouched


def test_every_cut_off_path_calls_the_scrub():
    """The replaced line and the account cut-off are inside larger flows — a text guard keeps their call from going missing; the behaviour of the others is tested above."""
    root = Path(__file__).resolve().parents[1] / "app"
    for rel in ("services/desktop_setup.py", "services/remote_control.py", "routers/auth.py"):
        assert "forget_prompts(" in (root / rel).read_text(encoding="utf8"), rel
    assert (root / "services/desktop_setup.py").read_text(encoding="utf8").count("forget_prompts(") == 2  # the replaced line and the disconnect


async def test_a_command_is_not_made_for_a_computer_that_was_cut_off_after_the_caller_read_it(world):
    """codex 4976 delta (medium): the caller (the endpoint) reads the computer, THEN `enqueue_command` takes the number — a cut-off that commits in between must not be followed by a new row
    (with the words) that nobody scrubs. The caller's object below is stale on purpose: the row was revoked after it was read."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.models.desktop_setup import DesktopSetup
    from app.services.desktop_relay import DesktopRelayError, enqueue_command
    from tests.test_4424_desktop_setup_realdb import _ASYNC

    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4976 mac k")
        sid = await _setup_id("d4976 mac k")
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as db:
            stale = await db.get(DesktopSetup, sid)  # read while the computer is live
            await _sql(f"UPDATE desktop_setups SET revoked_at = now(), revoked_reason = 'replaced_by_new_setup' WHERE id = '{sid}'")  # …then it is cut off (another transaction)
            assert stale.revoked_at is None  # (the object keeps its old view: the caller's read is stale)
            with pytest.raises(DesktopRelayError) as e:
                await enqueue_command(db, setup=stale, kind="send_prompt", payload={"session_key": "s-1", "conversation_id": str(conv), "envelope": sealed_env(sid, "k-stale")},
                                      idempotency_key="b3:stale", requested_by=OWNER_TM)
            assert (e.value.status, e.value.code) == (409, "device_disconnected")
            await db.rollback()
    finally:
        await eng.dispose()
    assert (await _sql(fetch=f"SELECT count(*) FROM desktop_commands WHERE setup_id = '{sid}'"))[0][0] == 0  # nothing was made · nothing to scrub


async def test_an_instruction_copy_still_open_after_ten_minutes_is_ended_and_scrubbed(world):
    """what no cut-off path can close — a press made while a switch-off was committing (the switch-off ended the commands it saw, this one landed after), or a computer that took a press and
    never reported: the minute job ends every instruction copy that is still open long after its 120 seconds. A fresh one and any other kind are left alone."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.services.desktop_relay import purge_stale_prompts
    from tests.test_4424_desktop_setup_realdb import _ASYNC

    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4976 mac l")
        sid = await _setup_id("d4976 mac l")
        old = [(await _post(c, agent, body)).json()["command_id"] for body in (
            _sealed_cmd(sid, phone, conv), _cmd("send_prompt", phone, conv=conv, text=f"{MARKER} delivered"), _sealed_cmd(sid, phone, conv))]
        fresh = (await _post(c, agent, _sealed_cmd(sid, phone, conv))).json()["command_id"]
        stop = (await _post(c, agent, {**_cmd("stop_session", phone), "idempotency_key": "stop-stale"})).json()["command_id"]
        done_old = (await _post(c, agent, _sealed_cmd(sid, phone, conv))).json()["command_id"]
        for cid, state in zip(old, ("queued", "delivered", "acked")):
            await _sql(f"UPDATE desktop_commands SET state = '{state}', created_at = now() - interval '11 minutes' WHERE id = '{cid}'")
        await _sql(f"UPDATE desktop_commands SET created_at = now() - interval '11 minutes' WHERE id = '{stop}'",
                   f"UPDATE desktop_commands SET state = 'done', created_at = now() - interval '11 minutes' WHERE id = '{done_old}'")
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as db:
            assert await purge_stale_prompts(db) == 3
            await db.commit()
        async with async_sessionmaker(eng)() as db:
            assert await purge_stale_prompts(db) == 0  # once is enough
    finally:
        await eng.dispose()
    for cid in old:
        payload, state, _k = await _row(cid)
        assert state == "rejected" and set(payload) == {"session_key", "conversation_id"}, (state, list(payload))
        assert (await _sql(fetch=f"SELECT result_code FROM desktop_commands WHERE id = '{cid}'"))[0][0] == "expired"
    assert "envelope" in (await _row(fresh))[0] and (await _row(fresh))[1] == "queued"  # not old yet
    assert (await _row(stop))[1] == "queued" and (await _row(stop))[0]["signed"]  # another kind
    assert (await _row(done_old))[1] == "done"  # a finished one is not touched here (its own end scrubbed it)
    assert MARKER not in json.dumps([r[0] for r in await _sql(fetch="SELECT payload FROM desktop_commands")])


def test_the_minute_job_runs_the_stale_prompt_sweep():
    root = Path(__file__).resolve().parents[1] / "app"
    cron = (root / "routers/cron.py").read_text(encoding="utf8")
    assert "prompts = await purge_stale_prompts(session)" in cron and '@router.post("/changes-purge")' in cron  # (the call itself, not a mention of its name)


async def test_a_command_ended_while_the_stream_reads_it_is_not_sent_nor_brought_back_to_delivered(world):
    """codex 4976 (third delta): `commands_to_send` read a queued row, a sweep / cut-off ended and scrubbed it, then the blind ORM write put it back to `delivered` and the old words went down the stream.
    The transition is now a guarded statement: the row is dropped, stays `rejected`, nothing is sent."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.services.desktop_relay import commands_to_send
    from tests.test_4424_desktop_setup_realdb import _ASYNC

    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4976 mac m")
        sid = await _setup_id("d4976 mac m")
        ended = (await _post(c, agent, _sealed_cmd(sid, phone, conv))).json()["command_id"]
        stays = (await _post(c, agent, _cmd("send_prompt", phone, conv=conv, text=f"{MARKER} still queued"))).json()["command_id"]
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as db:
            real, n = db.execute, {"n": 0}

            async def wrapped(stmt, *a, **k):
                res = await real(stmt, *a, **k)
                n["n"] += 1
                if n["n"] == 1:  # right after the stream's read of the queued rows: another transaction ends and scrubs one of them (what the minute sweep does)
                    await _sql(f"UPDATE desktop_commands SET state = 'rejected', result_code = 'expired', payload = jsonb_build_object('session_key', payload -> 'session_key', 'conversation_id', payload -> 'conversation_id') WHERE id = '{ended}'")
                return res

            db.execute = wrapped
            sent = [str(x.id) for x in await commands_to_send(db, sid, 0)]
            await db.commit()
    finally:
        await eng.dispose()
    assert sent == [stays]  # only the live one goes down the stream
    payload, state, _k = await _row(ended)
    assert state == "rejected" and set(payload) == {"session_key", "conversation_id"}  # not brought back to `delivered` · its words stay gone
    assert (await _row(stays))[1] == "delivered"  # (and the live one moved on as always)


async def test_the_cut_off_scrub_does_not_wait_for_a_command_row_a_result_is_landing_on(world):
    """codex 4976 (third delta): a result takes the command row and then the device's token; the cut-off paths take the token first — so the scrub of an acked/open instruction must not WAIT for a row
    another transaction holds (deadlock). It skips it (the result ends and scrubs it, or the minute sweep does) and takes it when it is free."""
    import asyncio

    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.models.desktop_relay import DesktopCommand
    from app.services.desktop_relay import forget_prompts
    from tests.test_4424_desktop_setup_realdb import _ASYNC

    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, "d4976 mac n")
        sid = await _setup_id("d4976 mac n")
        cid = (await _post(c, agent, _sealed_cmd(sid, phone, conv))).json()["command_id"]
        await _sql(f"UPDATE desktop_commands SET state = 'acked' WHERE id = '{cid}'")
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as holder, async_sessionmaker(eng)() as scrub:
            await holder.execute(select(DesktopCommand.id).where(DesktopCommand.id == uuid.UUID(cid)).with_for_update())  # a result's transaction holds the row
            assert await asyncio.wait_for(forget_prompts(scrub, [sid]), timeout=4) == 0  # …the scrub does not wait for it
            await scrub.commit()
            await holder.commit()
        async with async_sessionmaker(eng)() as again:
            assert await forget_prompts(again, [sid]) == 1  # free now: taken
            await again.commit()
    finally:
        await eng.dispose()
    assert set((await _row(cid))[0]) == {"session_key", "conversation_id"}
