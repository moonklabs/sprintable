"""story #4534 (relay contract v1.12 · alembic 0437 · PO 2026-10-05 03:06Z · Yuna) — the board's own words reach the phone and the web:
waiting_input · error · paused_limit, and a usage limit's why (`limit {at, again, self_resume}`) on those words only. Before, the
daemon folded them into idle — an agent stopped with an error looked idle on the phone."""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from app.models.desktop_relay import SESSION_SELF_RESUME, SESSION_STATES
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
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4534_desktop_commands_realdb import _remote_control_on, _sent_and_done, _turn_end_notices, _world  # noqa: F401

pytestmark = pytest.mark.anyio
STATE = "/api/v2/desktop/relay/sessions/s-1/state"


def _now():
    return datetime.now(timezone.utc)


def _report(agent, seq, state, **extra):
    return {"report_seq": seq, "agent_member_id": agent, "runtime": "codex", "state": state, "at": _now().isoformat(), **extra}


async def _view(c, agent):
    r = await c.get(f"/api/v2/agents/{agent}/desktop-session", headers=_person(OWNER))
    assert r.status_code == 200, r.text
    return r.json()


async def test_the_check_constraints_are_the_code_lists(world):
    """0437's CHECKs hold the model's words (one changed alone → RED)."""
    from app.core.database import async_session_factory

    async with async_session_factory() as s:
        defs = {n: d for n, d in (await s.execute(text(
            "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN "
            "('ck_desktop_sessions_state','ck_desktop_sessions_limit_self_resume')"))).all()}
    assert set(re.findall(r"'([a-z_]+)'", defs["ck_desktop_sessions_state"])) == set(SESSION_STATES)
    assert set(re.findall(r"'([a-z_]+)'", defs["ck_desktop_sessions_limit_self_resume"])) == set(SESSION_SELF_RESUME)


async def test_each_new_word_is_kept_as_itself_and_a_limit_with_its_why(world):
    async with _client() as c:
        d = await _device(c, name="d4534 limit a")
        token, agent = d["device_token"], d["agents"][0]["member_id"]
        at = (_now() + timedelta(hours=2)).replace(microsecond=0)
        seq = 0

        async def post(state, **extra):
            nonlocal seq
            seq += 1
            return await c.post(STATE, json=_report(agent, seq, state, **extra), headers=_tok(token))

        assert (await post("waiting_input")).status_code == 200
        v = await _view(c, agent)
        assert (v["state"], v["activity"]) == ("idle", "waiting_input"), "state stays one of the five · the word goes in activity"
        assert (await post("error")).status_code == 200
        v = await _view(c, agent)
        assert (v["state"], v["activity"], v["limit"]) == ("idle", "error", None), "an error that is not a limit carries no limit"
        # Codex continuing at a known time — paused, with when and «again»
        assert (await post("paused_limit", limit={"at": at.isoformat(), "again": True})).status_code == 200
        v = await _view(c, agent)
        assert (v["state"], v["activity"]) == ("idle", "paused_limit") and datetime.fromisoformat(v["limit"]["at"]) == at and v["limit"]["again"] is True
        # Claude that may continue by itself
        assert (await post("waiting_input", limit={"self_resume": "maybe"})).status_code == 200
        assert (await _view(c, agent))["limit"] == {"self_resume": "maybe"}
        # a limit whose time is not known: still a limit (the web says «where to see when»)
        assert (await post("error", limit={})).status_code == 200
        assert (await _view(c, agent))["limit"] == {}
        # the limit is over: a report without one clears it
        assert (await post("working")).status_code == 200
        v = await _view(c, agent)
        assert (v["state"], v["activity"], v["limit"]) == ("working", "working", None)
        rows = await _sql(fetch=f"SELECT limited, limit_at, limit_again, limit_self_resume FROM desktop_sessions WHERE setup_id = '{d['setup_id']}'")
        assert [tuple(r) for r in rows] == [(None, None, None, None)]
        # the device's own list carries it too
        assert (await post("paused_limit", limit={"at": at.isoformat(), "again": False})).status_code == 200
        listed = await c.get(f"/api/v2/desktop/setups/{d['setup_id']}/sessions", headers=_person(OWNER))
        [s] = listed.json()["sessions"]
        assert (s["state"], s["activity"]) == ("idle", "paused_limit") and s["limit"]["again"] is False


async def test_a_limit_on_any_other_word_an_extra_field_or_an_unknown_self_resume_is_refused(world):
    async with _client() as c:
        d = await _device(c, name="d4534 limit b")
        token, agent = d["device_token"], d["agents"][0]["member_id"]
        for seq, (state, limit) in enumerate([("idle", {}), ("working", {"again": False}), ("waiting_permission", {"self_resume": "no"}),
                                              ("paused_limit", {"why": "x"}), ("waiting_input", {"self_resume": "yes"}),
                                              ("paused_limit", {"at": "2026-10-05T05:00:00"})], start=1):
            r = await c.post(STATE, json=_report(agent, seq, state, limit=limit), headers=_tok(token))
            assert r.status_code == 422, (state, limit, r.text)
        assert (await c.post(STATE, json=_report(agent, 20, "sleeping"), headers=_tok(token))).status_code == 422


async def test_a_snapshot_keeps_the_words_and_limits_and_a_dropped_session_loses_its_limit(world):
    async with _client() as c:
        d = await _device(c, name="d4534 limit c")
        token, agent = d["device_token"], d["agents"][0]["member_id"]
        snap = {"report_seq": 1, "sessions": [
            {"session_key": "s-1", "agent_member_id": agent, "runtime": "claude", "state": "waiting_input", "at": _now().isoformat(), "limit": {"self_resume": "no"}},
        ]}
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap, headers=_tok(token))).status_code == 200
        assert (await _view(c, agent))["limit"] == {"self_resume": "no"}
        assert (await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 2, "sessions": []}, headers=_tok(token))).status_code == 200
        rows = await _sql(fetch=f"SELECT state, limited, limit_self_resume FROM desktop_sessions WHERE setup_id = '{d['setup_id']}'")
        assert [tuple(r) for r in rows] == [("stopped", None, None)]


@pytest.mark.parametrize(("end", "limit", "word", "body"), [
    ("waiting_input", None, "입력 대기", "그 컴퓨터의 터미널에서 답을 기다리고 있어요 — 눌러서 대화를 확인해 주세요"),
    ("waiting_input", {"self_resume": "maybe"}, "사용 한도", "사용 한도에 걸렸어요 — 눌러서 어떻게 이어 갈지 확인해 주세요"),
    ("paused_limit", {"at": "2030-01-01T00:00:00+00:00"}, "한도로 쉬는 중", "사용 한도에 걸려 멈췄어요 — 한도가 풀리면 스스로 이어서 해요"),
    ("error", {}, "오류", "사용 한도에 걸려 멈췄어요 — 눌러서 확인해 주세요"),
    ("error", None, "오류", "에이전트가 오류로 멈췄어요 — 까닭은 그 컴퓨터의 데스크톱 앱에서 볼 수 있어요"),
])
async def test_a_turn_that_ends_in_a_resting_word_tells_the_sender_once_in_that_words_terms(world, end, limit, word, body):
    """Before, these arrived as idle and the [지금 지시] sender was told «다음 일 기다림» — still told once, now in the words of the
    state the turn ended in (Yuna 04:05Z: the title is that state's chip word · an error · a limit are not «waiting for work»)."""
    async with _client() as c:
        device, agent, phone, _der, conv = await _world(c, f"d4534 limit turn {end} {bool(limit)}")
        await _sent_and_done(c, device, agent, phone, conv, key=f"t-{end}-{bool(limit)}")
        extra = {"limit": limit} if limit is not None else {}
        r = await c.post(STATE, json={**_report(agent, 2, end, **extra), "runtime": "claude"}, headers=_tok(device["device_token"]))
        assert r.status_code == 200, r.text
        notices = await _turn_end_notices(OWNER_TM)
        assert len(notices) == 1
        payload = notices[0][0]
        assert payload["title"] == f"{payload['agent_name']} · {word}"
        assert payload["body"] == body
        assert "그 PR 머리도" not in str(payload)


async def test_an_older_reader_never_meets_a_word_it_does_not_know(world):
    """Kadir 4960 · PO 05:36Z — a web bundle from before reads `state` with the five words only (it would throw on another): every
    new word reaches both reads as one of the five in `state`, the word itself in `activity`."""
    five = {"starting", "working", "idle", "waiting_permission", "stopped", "unknown"}
    async with _client() as c:
        d = await _device(c, name="d4534 limit old reader")
        token, agent = d["device_token"], d["agents"][0]["member_id"]
        for seq, (word, extra) in enumerate([("waiting_input", {}), ("error", {}), ("paused_limit", {"limit": {"at": _now().isoformat()}}),
                                             ("waiting_input", {"limit": {"self_resume": "maybe"}}), ("error", {"limit": {}})], start=1):
            assert (await c.post(STATE, json=_report(agent, seq, word, **extra), headers=_tok(token))).status_code == 200
            v = await _view(c, agent)
            assert v["state"] in five and v["activity"] == word, v
            [row] = (await c.get(f"/api/v2/desktop/setups/{d['setup_id']}/sessions", headers=_person(OWNER))).json()["sessions"]
            assert row["state"] in five and row["activity"] == word, row


async def test_instruct_now_is_each_reports_own_and_is_not_said_for_a_device_not_heard(world):
    """story #4534 (0438 · PO 06:30Z · Kadir 06:31Z (c)): whether [지금 지시] can go into the turn — each report sets it (a report
    without it clears it), a snapshot sets it, a session the snapshot drops loses it, and a device not heard says nothing."""
    async with _client() as c:
        d = await _device(c, name="d4534 instruct now")
        token, agent, sid = d["device_token"], d["agents"][0]["member_id"], d["setup_id"]

        async def both():
            v = await _view(c, agent)
            [row] = (await c.get(f"/api/v2/desktop/setups/{sid}/sessions", headers=_person(OWNER))).json()["sessions"]
            return v["instruct_now"], row["instruct_now"]

        assert (await c.post(STATE, json=_report(agent, 1, "working", instruct_now=True), headers=_tok(token))).status_code == 200
        assert await both() == (True, True)
        assert (await c.post(STATE, json=_report(agent, 2, "working", instruct_now=False), headers=_tok(token))).status_code == 200
        assert await both() == (False, False)
        assert (await c.post(STATE, json=_report(agent, 3, "working"), headers=_tok(token))).status_code == 200
        assert await both() == (None, None), "a daemon from before (no field) — the web hides the button"
        for bad in ("yes", 1, "true"):
            assert (await c.post(STATE, json=_report(agent, 4, "working", instruct_now=bad), headers=_tok(token))).status_code == 422, bad
        assert (await c.post(STATE, json=_report(agent, 5, "working", instruct_now=True), headers=_tok(token))).status_code == 200
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '5 minutes' WHERE setup_id = '{sid}'")
        assert await both() == (None, None), "a device not heard: not said (the button stays hidden)"

        snap = {"report_seq": 6, "sessions": [{"session_key": "s-1", "agent_member_id": agent, "runtime": "codex", "state": "working",
                                               "at": _now().isoformat(), "instruct_now": True}]}
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap, headers=_tok(token))).status_code == 200
        assert await both() == (True, True)
        assert (await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 7, "sessions": []}, headers=_tok(token))).status_code == 200
        rows = await _sql(fetch=f"SELECT state, instruct_now FROM desktop_sessions WHERE setup_id = '{sid}'")
        assert [tuple(r) for r in rows] == [("stopped", None)]


@pytest.mark.parametrize(("text", "status"), [
    ("가" * 400, 201), ("가" * 401, 422),
    ("😀" * 400, 201),  # code points: one emoji is one (two UTF-16 units in the browser — the sheet counts [...text] too)
    ("😀" * 401, 422),
])
async def test_an_instruction_into_the_turn_is_400_code_points_at_most(world, text, status):
    """story #4534 (Kadir 06:21Z ④ · Yuna 06:29Z ②): the sheet stops a longer one before it is signed — the server refuses it again."""
    from tests.test_4534_desktop_commands_realdb import _cmd, _post

    async with _client() as c:
        _device_, agent, phone, _der, conv = await _world(c, f"d4534 400 {len(text)} {text[0]}")
        r = await _post(c, agent, _cmd("send_prompt", phone, conv=conv, text=text))
        assert r.status_code == status, r.text
        if status == 422:
            assert r.json()["error"]["code"] == "instruct_too_long"
