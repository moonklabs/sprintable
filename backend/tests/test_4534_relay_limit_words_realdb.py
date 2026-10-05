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
        assert (await _view(c, agent))[["state", "limit"][0]] == "waiting_input"
        assert (await post("error")).status_code == 200
        v = await _view(c, agent)
        assert (v["state"], v["limit"]) == ("error", None), "an error that is not a limit carries no limit"
        # Codex continuing at a known time — paused, with when and «again»
        assert (await post("paused_limit", limit={"at": at.isoformat(), "again": True})).status_code == 200
        v = await _view(c, agent)
        assert v["state"] == "paused_limit" and datetime.fromisoformat(v["limit"]["at"]) == at and v["limit"]["again"] is True
        # Claude that may continue by itself
        assert (await post("waiting_input", limit={"self_resume": "maybe"})).status_code == 200
        assert (await _view(c, agent))["limit"] == {"self_resume": "maybe"}
        # a limit whose time is not known: still a limit (the web says «where to see when»)
        assert (await post("error", limit={})).status_code == 200
        assert (await _view(c, agent))["limit"] == {}
        # the limit is over: a report without one clears it
        assert (await post("working")).status_code == 200
        v = await _view(c, agent)
        assert (v["state"], v["limit"]) == ("working", None)
        rows = await _sql(fetch=f"SELECT limited, limit_at, limit_again, limit_self_resume FROM desktop_sessions WHERE setup_id = '{d['setup_id']}'")
        assert [tuple(r) for r in rows] == [(None, None, None, None)]
        # the device's own list carries it too
        assert (await post("paused_limit", limit={"at": at.isoformat(), "again": False})).status_code == 200
        listed = await c.get(f"/api/v2/desktop/setups/{d['setup_id']}/sessions", headers=_person(OWNER))
        [s] = listed.json()["sessions"]
        assert s["state"] == "paused_limit" and s["limit"]["again"] is False


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
