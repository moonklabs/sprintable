"""story #4686 (PO 10-14 01:06Z · Yuna run-info-1014.md) — a session says what it really runs on: the model, the thinking depth, the account.

10-13: eight sessions started with `model: null`, the CLI's default (fable) ran, five lanes stood at its limit — and nothing on the
board, the phone or the web said which model or account. Server half: the report carries `run`, the row keeps it, both readers show it,
the limit notice names where the limit hit. Each claim has a test that goes red without it (mutants in the PR).
"""
from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
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

RUN = {"model": "claude-fable-5-1", "model_set": False, "effort": "high", "account": "moonklabs (Max)"}


@pytest.fixture(autouse=True)
async def _remote_control_on_and_korean(world):
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'",
               f"UPDATE users SET locale = 'ko' WHERE id = '{OWNER}'")
    yield


def _now():
    return datetime.now(timezone.utc)


async def _report(c, device, agent, state, seq, *, key="s-1", run=None, expect=200):
    body = {"report_seq": seq, "agent_member_id": agent, "runtime": "claude", "state": state, "at": _now().isoformat()}
    if run is not None:
        body["run"] = run
    r = await c.post(f"/api/v2/desktop/relay/sessions/{key}/state", headers=_tok(device["device_token"]), json=body)
    assert r.status_code == expect, r.text
    return r


async def _header(c, agent) -> dict:
    return (await c.get(f"/api/v2/agents/{agent}/desktop-session", headers=_person(OWNER))).json()


async def _list(c, device) -> list[dict]:
    r = await c.get(f"/api/v2/desktop/setups/{device['setup_id']}/sessions", headers=_person(OWNER))
    assert r.status_code == 200, r.text
    return r.json()["sessions"]


async def test_01_the_report_keeps_it_and_both_readers_show_it(world):
    async with _client() as c:
        device = await _device(c, "d4686 mac a")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1, run=RUN)
        assert (await _header(c, a))["run"] == RUN  # the DM header (the strip, the workforce detail)
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert row["run"] == RUN  # the device's session list (the board's «연결된 기기»)
        # a model the profile did name: model_set true; no effort / account: only what is set is said
        await _report(c, device, a, "idle", 2, run={"model": "claude-sonnet-5-5", "model_set": True})
        assert (await _header(c, a))["run"] == {"model": "claude-sonnet-5-5", "model_set": True}


async def test_02_a_report_without_run_clears_it_never_a_stale_value(world):
    async with _client() as c:
        device = await _device(c, "d4686 mac b")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1, run=RUN)
        await _report(c, device, a, "idle", 2)  # an older daemon, or one that could not read it
        assert (await _header(c, a))["run"] is None
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert "run" not in row


async def test_03_the_snapshot_path_carries_it_too_and_a_dropped_session_loses_it(world):
    async with _client() as c:
        device = await _device(c, "d4686 mac c")
        a, b = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        snap = {"report_seq": 1, "sessions": [
            {"session_key": "s-a", "agent_member_id": a, "runtime": "claude", "state": "working", "at": _now().isoformat(), "run": RUN},
            {"session_key": "s-b", "agent_member_id": b, "runtime": "codex", "state": "idle", "at": _now().isoformat(),
             "run": {"model": "gpt-5-codex", "model_set": True, "effort": "medium"}}]}
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap, headers=_tok(device["device_token"]))).status_code == 200
        rows = {s["session_key"]: s for s in await _list(c, device)}
        assert rows["s-a"]["run"] == RUN and rows["s-b"]["run"] == {"model": "gpt-5-codex", "model_set": True, "effort": "medium"}  # Codex: no account
        snap2 = {"report_seq": 2, "sessions": [snap["sessions"][0]]}  # s-b is gone from the daemon's list
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap2, headers=_tok(device["device_token"]))).status_code == 200
        rows = {s["session_key"]: s for s in await _list(c, device)}
        assert rows["s-b"]["state"] == "stopped" and "run" not in rows["s-b"]


@pytest.mark.parametrize("bad", [
    {"model": "claude fable"}, {"model": "--dangerously-skip-permissions"}, {"model": "x" * 80}, {"model": ""},
    {"effort": "turbo"}, {"model_set": "yes"}, {"account": ""}, {"account": "a" * 81},
    {"account": "org‮txt"}, {"account": "line\nbreak"}, {"account": " padded "},
    {"account": "someone@moonklabs.com (Pro)"},  # an address written out in full never gets in
    # Kadir 5073 (10-14): every row he called — short addresses, the fullwidth «＠», token shapes — each refused alone
    {"account": "jo@gmail.com (Pro)"}, {"account": "j@x.io (Pro)"}, {"account": "john＠gmail.com"}, {"account": "Acme (bob@acme.io)"},
    {"account": "sk-ant-api03-AbCdEf0123456789"}, {"account": "Bearer eyJhbGciOiJIUzI1NiJ9"}, {"account": "eyJhbGciOiJIUzI1NiJ9.e30.abc"},
    {"account": "0123456789abcdef0123456789abcdef01234567"},
    # the allow-list: not a label the daemon makes — a sentence, a plan word that is not one, a bracket that is not a plan, a mask on the wrong shape
    {"account": "moonklabs (Gold)"}, {"account": "moonklabs (Pro) (Max)"}, {"account": "moonklabs [Max]"}, {"account": "yo***@host (Pro)"},
    {"account": "y***@a.b"}, {"account": "yon***@moonklabs.com"}, {"account": "yo*** @moonklabs.com"}, {"account": "yo***@moonklabs.com extra"},
    {"account": "moonklabs (Max)", "token": "sk-live-1"},  # a field the contract does not have
])
async def test_04_what_is_not_a_model_a_word_or_a_label_is_refused(world, bad):
    async with _client() as c:
        device = await _device(c, "d4686 mac d")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1, run=bad, expect=422)


async def test_05_a_masked_address_and_an_org_name_are_accepted(world):
    async with _client() as c:
        device = await _device(c, "d4686 mac e")
        a = device["agents"][0]["member_id"]
        for seq, account in enumerate(["yo***@moonklabs.com (Pro)", "moonklabs (Max)", "Acme Co. 한국"], start=1):
            await _report(c, device, a, "working", seq, run={"account": account})
            assert (await _header(c, a))["run"] == {"account": account}
        await _report(c, device, a, "idle", 4, run={"model": "claude-opus-5-5[1m]", "model_set": True})  # the 1M tail is part of the id
        assert (await _header(c, a))["run"]["model"] == "claude-opus-5-5[1m]"


async def test_06_a_device_that_went_quiet_says_nothing_of_what_runs(world):
    async with _client() as c:
        device = await _device(c, "d4686 mac f")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1, run=RUN)
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '5 minutes' WHERE setup_id = '{device['setup_id']}'")
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert row["state"] == "unknown" and "run" not in row  # a value from before the silence is not told as current
        assert (await _header(c, a))["run"] is None


async def test_07_the_database_holds_its_own_caps(world):
    """The API check is not the last word: the DB refuses an effort that is not a word and over-long texts."""
    import sqlalchemy.exc

    async with _client() as c:
        device = await _device(c, "d4686 mac g")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        for col, val in (("run_effort", "'turbo'"), ("run_account", f"'{'a' * 81}'"), ("run_model", f"'{'m' * 71}'")):
            with pytest.raises(Exception) as e:
                await _sql(f"UPDATE desktop_sessions SET {col} = {val} WHERE setup_id = '{device['setup_id']}'")
            assert "ck_desktop_sessions_run" in str(e.value) or isinstance(e.value, sqlalchemy.exc.IntegrityError)


async def test_08_the_limit_notice_names_where_the_limit_hit(world):
    LOOKS = {"self_resume": "unknown", "looks": True}
    from tests.test_4685_limit_notice_realdb import STOOD, UNKNOWN_BODY, _notices

    async with _client() as c:
        device = await _device(c, "d4686 mac h")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1, run=RUN)
        body = {"report_seq": 2, "agent_member_id": a, "runtime": "claude", "state": "waiting_input", "at": _now().isoformat(), "limit": LOOKS, "run": RUN}
        assert (await c.post("/api/v2/desktop/relay/sessions/s-1/state", headers=_tok(device["device_token"]), json=body)).status_code == 200
        (n,) = await _notices(STOOD)
        assert n["body"] == f"{UNKNOWN_BODY} 한도가 걸린 곳: moonklabs (Max) · claude-fable-5-1."  # the account first, then the model


def test_09_where_the_limit_hit_follows_yunas_table():
    """run-info-1014.md (5): an account is where a usage limit hits — it comes first; the model follows only when they all run one."""
    from app.services.desktop_limit_notice import where_text

    def row(account=None, model=None):
        return SimpleNamespace(run_account=account, run_model=model, id=object())

    one = where_text([row("moonklabs (Max)", "claude-fable-5-1")], "ko")
    assert one == "한도가 걸린 곳: moonklabs (Max) · claude-fable-5-1."
    assert where_text([row("moonklabs (Max)", "claude-fable-5-1")], "en") == "Limit reached on: moonklabs (Max) · claude-fable-5-1."
    # several, one account: the model too when it is one; the account alone when the models are mixed
    assert where_text([row("A (Max)", "m1"), row("A (Max)", "m1")], "ko") == "한도가 걸린 곳: A (Max) · m1."
    assert where_text([row("A (Max)", "m1"), row("A (Max)", "m2")], "ko") == "한도가 걸린 곳: A (Max)."
    # several accounts: the first and how many more
    assert where_text([row("A (Max)", "m1"), row("B (Pro)", "m1"), row("C (Pro)", "m1")], "ko") == "한도가 걸린 곳: A (Max) 외 계정 2개."
    assert where_text([row("A (Max)", "m1"), row("B (Pro)", "m1")], "en") == "Limit reached on: A (Max) and 1 more accounts."
    # no account (Codex · a login that could not be read): the model alone, and for several only when they run one
    assert where_text([row(None, "gpt-5-codex")], "ko") == "한도가 걸린 곳: gpt-5-codex."
    assert where_text([row(None, "m1"), row(None, "m1")], "ko") == "한도가 걸린 곳: m1."
    assert where_text([row(None, "m1"), row(None, "m2")], "ko") is None
    # nothing known: no line (never «한도가 걸린 곳: » alone)
    assert where_text([row(), row()], "ko") is None
    # an account whose model is not known: the account alone
    assert where_text([row("A (Max)", None)], "ko") == "한도가 걸린 곳: A (Max)."


def test_07_the_account_label_is_an_allow_list_not_a_refusal_list():
    """Kadir 5073 (PO 10-14): only what the daemon makes gets in — a masked address or an org name, then a plan word from a closed set —
    read after NFKC, and what is kept is the normalized form. The refusals of every shape Kadir called are in test_04 (one row each)."""
    from pydantic import ValidationError

    from app.services.desktop_relay import SessionRun

    for ok in ["yo***@moonklabs.com", "y***@x.io (Max)", "j.***@sub.moonklabs.co.kr (Enterprise)", "Acme Co. 한국 (Team)", "Free & Co, Ltd (Free)", "moonklabs"]:
        assert SessionRun(account=ok).account == ok, ok
    # a fullwidth letter is the letter it means; the kept form is the normalized one
    assert SessionRun(account="Ａcme (Pro)").account == "Acme (Pro)"
    for bad in ["jo@gmail.com", "j@x.io (Pro)", "john＠gmail.com", "Acme (bob@acme.io)", "sk-ant-api03-AbCdEf0123456789", "Bearer eyJhbGciOiJIUzI1NiJ9",
                "0123456789abcdef0123456789abcdef01234567", "moonklabs (Gold)", "yo***@host (Pro)", "Acme\u2028Corp", "Acme*Corp"]:
        with pytest.raises(ValidationError):
            SessionRun(account=bad)


async def test_08_a_stopped_session_in_the_device_list_carries_no_run(world):
    """Kadir 5073 (10-14): the DM header's twin is test_06 of the commands; the device list's own `state != "stopped"` had no test."""
    async with _client() as c:
        device = await _device(c, "d4686 mac g")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1, run=RUN)
        await _report(c, device, a, "stopped", 2, run=RUN)  # the daemon says «stopped» and still carries what it ran on
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert row["state"] == "stopped" and "run" not in row  # an ended session is not told as running on anything
