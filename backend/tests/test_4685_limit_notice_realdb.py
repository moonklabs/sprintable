"""story #4685 (AC1 · PO 10-14 00:27Z · Yuna limit-notice-1014.md) — an agent on a person's computer stands at the usage limit: the
person who connected that computer is told, once; and once more when work starts again.

10-13: five lanes stood and nobody was told — the only limit notice was the turn-end one a phone's [지금 지시] earned. These tests
drive the relay's own report endpoints over a migrated PG (the 4424/4534 harness): the report is the only input, the notice the
only output. Each claim has a test that goes red without it (mutants in the PR).
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    ORG2,
    OWNER,
    OWNER_TM,
    PLAIN as PLAIN_USER,
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

LOOKS = {"self_resume": "unknown", "looks": True}  # the 10-13 shape: Claude, reset time unknown, a daemon that looks again


@pytest.fixture(autouse=True)
async def _remote_control_on_and_korean(world):
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'",
               f"UPDATE users SET locale = 'ko' WHERE id = '{OWNER}'")
    yield


def _now():
    return datetime.now(timezone.utc)


async def _report(c, device, agent, state, seq, *, key="s-1", limit=None, at=None, expect=200):
    body = {"report_seq": seq, "agent_member_id": agent, "runtime": "claude", "state": state, "at": (at or _now()).isoformat()}
    if limit is not None:
        body["limit"] = limit
    r = await c.post(f"/api/v2/desktop/relay/sessions/{key}/state", headers=_tok(device["device_token"]), json=body)
    assert r.status_code == expect, r.text
    return r


async def _notices(event_type, member=OWNER_TM):
    rows = await _sql(fetch=("SELECT payload FROM events WHERE recipient_id = :m AND event_type = 'dispatched' "
                             "AND payload->>'event_type' = :t ORDER BY created_at"), params={"m": member, "t": event_type})
    return [r[0] for r in rows]


STOOD, LIFTED = "agent.limit_paused", "agent.limit_lifted"
UNKNOWN_BODY = "사용 한도에 걸려 멈췄어요 — 풀리는 시각은 아직 몰라요. 다시 일하기 시작하면 또 알려요."


async def test_01_a_session_that_stands_tells_the_person_who_connected_the_computer_once(world):
    async with _client() as c:
        device = await _device(c, "d4685 mac a")
        agent = device["agents"][0]["member_id"]
        await _report(c, device, agent, "working", 1)
        assert await _notices(STOOD) == []
        await _report(c, device, agent, "waiting_input", 2, limit=LOOKS)
        (n,) = await _notices(STOOD)
        assert n["title"] == f"{n['agent_name']} · 한도로 쉬는 중"  # the existing paused_limit title — Yuna: the same words for the same state
        assert n["body"] == UNKNOWN_BODY  # no reset time → the unknown body; no number of tries, no account, no model in the words
        # the same limit reported again is not a new stand
        await _report(c, device, agent, "waiting_input", 3, limit=LOOKS)
        await _report(c, device, agent, "waiting_input", 4, limit={**LOOKS, "held": "screen"})  # held: still the same limit episode
        assert len(await _notices(STOOD)) == 1


async def test_02_nothing_for_a_move_that_is_not_into_a_limit(world):
    async with _client() as c:
        device = await _device(c, "d4685 mac b")
        agent = device["agents"][0]["member_id"]
        for seq, state in enumerate(["working", "idle", "waiting_permission", "working", "error"], start=1):
            await _report(c, device, agent, state, seq)  # an error with no limit is not a usage limit
        assert await _notices(STOOD) == [] and await _notices(LIFTED) == []


async def test_03_others_that_stand_within_the_window_are_folded_and_the_lifted_line_waits_for_all(world):
    async with _client() as c:
        device = await _device(c, "d4685 mac c")
        a, b = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        await _report(c, device, a, "working", 1, key="s-a")
        await _report(c, device, b, "working", 2, key="s-b")
        await _report(c, device, a, "waiting_input", 3, key="s-a", limit=LOOKS)
        await _report(c, device, b, "waiting_input", 4, key="s-b", limit=LOOKS)  # inside the window: not told again
        stood = await _notices(STOOD)
        assert len(stood) == 1 and stood[0]["title"] == f"{stood[0]['agent_name']} · 한도로 쉬는 중"
        # one is back — the other still stands: «all working again» would be false
        await _report(c, device, a, "working", 5, key="s-a")
        assert await _notices(LIFTED) == []
        # the last one is back: the one line, the same agent as the stood notice
        await _report(c, device, b, "working", 6, key="s-b")
        (back,) = await _notices(LIFTED)
        assert back["title"] == f"{stood[0]['agent_name']} · 작업 중"
        assert back["body"] == "사용 한도가 풀려 다시 일하기 시작했어요."
        await _report(c, device, b, "idle", 7, key="s-b")  # told once
        assert len(await _notices(LIFTED)) == 1


async def test_04_several_standing_at_once_in_a_snapshot_are_one_notice_with_the_count_and_one_lifted_line_with_the_same_count(world):
    async with _client() as c:
        device = await _device(c, "d4685 mac d")
        a, b = device["agents"][0]["member_id"], device["agents"][1]["member_id"]

        def snap(seq, state_a, state_b):
            lim = {"limit": LOOKS}
            return {"report_seq": seq, "sessions": [
                {"session_key": "s-a", "agent_member_id": a, "runtime": "claude", "state": state_a, "at": _now().isoformat(), **(lim if state_a == "waiting_input" else {})},
                {"session_key": "s-b", "agent_member_id": b, "runtime": "claude", "state": state_b, "at": _now().isoformat(), **(lim if state_b == "waiting_input" else {})}]}

        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap(1, "working", "working"), headers=_tok(device["device_token"]))).status_code == 200
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap(2, "waiting_input", "waiting_input"), headers=_tok(device["device_token"]))).status_code == 200
        (stood,) = await _notices(STOOD)
        assert stood["title"] == f"{stood['agent_name']} 외 1개 · 한도로 쉬는 중"
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap(3, "working", "working"), headers=_tok(device["device_token"]))).status_code == 200
        (back,) = await _notices(LIFTED)
        assert back["title"] == f"{stood['agent_name']} 외 1개 · 작업 중"


async def test_05_a_known_reset_time_is_told_in_the_org_zone_and_a_past_one_is_not(world):
    async with _client() as c:
        device = await _device(c, "d4685 mac e")
        a, b = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        await _sql(f"UPDATE organizations SET timezone = 'Asia/Seoul' WHERE id = '{ORG}'")
        later = _now() + timedelta(hours=26)  # another day for sure
        await _report(c, device, a, "working", 1, key="s-a")
        await _report(c, device, a, "paused_limit", 2, key="s-a", limit={"at": later.isoformat(), "again": False})
        (n,) = await _notices(STOOD)
        local = later.astimezone(__import__("zoneinfo").ZoneInfo("Asia/Seoul"))
        clock = f"{'오전' if local.hour < 12 else '오후'} {local.hour % 12 or 12}:{local.minute:02d}"
        assert n["body"] == f"사용 한도에 걸려 멈췄어요 — {local.month}월 {local.day}일 {clock}에 풀려요. 다시 일하기 시작하면 또 알려요."
        # another person's session with a time that has already passed: never «풀려요» at a time that has gone (the window is a PERSON's: the
        # same person's second computer inside it would be folded into the first notice — see test_15)
        await _second_person()
        other = await _device(c, "d4685 mac e2")
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN_USER}' WHERE id = '{other['setup_id']}'")
        o = other["agents"][0]["member_id"]
        await _report(c, other, o, "working", 1, key="s-o")
        await _report(c, other, o, "paused_limit", 2, key="s-o", limit={"at": (_now() - timedelta(minutes=5)).isoformat(), "again": True})
        bodies = [x["body"] for x in await _notices(STOOD, PLAIN_TM)]
        assert bodies == [UNKNOWN_BODY]


async def test_06_a_session_that_ends_is_not_working_again_and_clears_what_was_promised(world):
    async with _client() as c:
        device = await _device(c, "d4685 mac f")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=LOOKS)
        await _report(c, device, a, "stopped", 3)
        assert await _notices(LIFTED) == []  # it ended — not «working again»
        await _report(c, device, a, "working", 4)  # a new session under the same key: nothing promised any more
        await _report(c, device, a, "idle", 5)
        assert await _notices(LIFTED) == []


async def test_07_nobody_to_tell_is_not_a_failure_and_a_failing_notice_never_fails_the_report(world, monkeypatch):
    async with _client() as c:
        device = await _device(c, "d4685 mac g")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        nobody = uuid.uuid4()
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{nobody}' WHERE id = '{device['setup_id']}'")  # nobody active (a seat but no account: story 4769 refuses a seatless confirmer at the relay)
        await _sql(f"INSERT INTO org_members (id, org_id, user_id, role) SELECT gen_random_uuid(), org_id, '{nobody}', 'admin' FROM desktop_setups WHERE id = '{device['setup_id']}' ON CONFLICT DO NOTHING")
        await _report(c, device, a, "waiting_input", 2, limit=LOOKS)  # 200 — nobody told
        assert await _notices(STOOD) == []
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{OWNER}' WHERE id = '{device['setup_id']}'")
        await _report(c, device, a, "working", 3)

        import app.services.notification_dispatch as nd

        async def boom(*_a, **_k):
            raise RuntimeError("the dispatcher is down")

        monkeypatch.setattr(nd, "dispatch_notification", boom)
        await _report(c, device, a, "waiting_input", 4, limit=LOOKS)  # the notice fails — the report still stands
        row = await _sql(fetch=f"SELECT state, limited FROM desktop_sessions WHERE setup_id = '{device['setup_id']}' AND session_key = 's-1'")
        assert row[0][0] == "waiting_input" and row[0][1] is True


async def test_08_looks_is_stored_shown_to_readers_and_only_ever_true(world):
    async with _client() as c:
        device = await _device(c, "d4685 mac h")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit={"self_resume": "maybe", "looks": False}, expect=422)  # `false` is not a word of the contract
        await _report(c, device, a, "waiting_input", 3, limit={"self_resume": "maybe"})
        view = (await c.get(f"/api/v2/agents/{a}/desktop-session", headers=_person(OWNER))).json()
        assert view["limit"] == {"self_resume": "maybe"}  # no `looks`: a daemon that does not look
        await _report(c, device, a, "waiting_input", 4, limit=LOOKS)
        view = (await c.get(f"/api/v2/agents/{a}/desktop-session", headers=_person(OWNER))).json()
        assert view["limit"] == {"self_resume": "unknown", "looks": True}


async def _record_dispatches(monkeypatch) -> list[dict]:
    """The dispatcher is replaced by a recorder: the claim under test is WHO the notice is addressed to — a call that would go to
    the wrong person must show up as a call, whatever the real dispatcher would later filter out."""
    import app.services.notification_dispatch as nd

    calls: list[dict] = []

    async def record(*_a, **kw):
        calls.append(kw)
        return 0

    monkeypatch.setattr(nd, "dispatch_notification", record)
    return calls


async def test_11_a_person_who_left_this_org_for_another_is_not_told(world, monkeypatch):
    """The notice goes to the person who connected the computer — as a member of THIS org. A person who has since left it (their
    only member row is in another org) gets nothing: the recipient lookup is bound to the setup's org (Kadir's pin, 10-14)."""
    calls = await _record_dispatches(monkeypatch)
    async with _client() as c:
        device = await _device(c, "d4685 mac i")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _sql(f"UPDATE members SET org_id = '{ORG2}' WHERE id = '{OWNER_TM}'")  # the person's only member row is now in another org
        await _report(c, device, a, "waiting_input", 2, limit=LOOKS)
        assert calls == [], "nobody in THIS org to tell — and never a member of another org"


async def test_12_an_inactive_member_is_not_told(world, monkeypatch):
    """A member who was removed (is_active false) is not told, even though they once connected the computer (Kadir's pin)."""
    calls = await _record_dispatches(monkeypatch)
    async with _client() as c:
        device = await _device(c, "d4685 mac j")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _sql(f"UPDATE members SET is_active = false WHERE id = '{OWNER_TM}'")
        await _report(c, device, a, "waiting_input", 2, limit=LOOKS)
        assert calls == []


@pytest.fixture(params=["local", "redis"])
def store(request):  # noqa: D401 — the two stores below (test_13 · test_14)
    """Where the window and the outstanding promise live: this process (no Redis) or Redis (fakeredis — the instances' shared store)."""
    if request.param == "local":
        yield "local"
        return
    from unittest.mock import patch

    aioredis = pytest.importorskip("fakeredis.aioredis")
    client = aioredis.FakeRedis(server=aioredis.FakeServer(), decode_responses=True)
    with patch("app.services.redis_shared.get_client", return_value=client):
        yield "redis"


async def test_13_one_working_again_line_even_when_a_second_agent_stands_and_returns_inside_the_window(world, store):
    """A stands → all back (the line goes, the promise is TAKEN) → B stands inside the 5-minute window (no new notice, nothing
    promised) → B is back: no second line. The promise is read-and-removed in one step (Redis GETDEL · the process map's pop) —
    a plain read would leave it standing and B's return would tell «working again» a second time (Kadir's pin, 10-14)."""
    async with _client() as c:
        device = await _device(c, "d4685 mac k")
        a, b = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        await _report(c, device, a, "working", 1, key="s-a")
        await _report(c, device, b, "working", 2, key="s-b")
        await _report(c, device, a, "waiting_input", 3, key="s-a", limit=LOOKS)
        assert len(await _notices(STOOD)) == 1
        await _report(c, device, a, "working", 4, key="s-a")
        assert len(await _notices(LIFTED)) == 1
        await _report(c, device, b, "waiting_input", 5, key="s-b", limit=LOOKS)  # inside the window: nothing told, nothing promised
        assert len(await _notices(STOOD)) == 1
        await _report(c, device, b, "working", 6, key="s-b")
        assert len(await _notices(LIFTED)) == 1, "the promise was kept once — B's return is not a second «working again»"


async def test_14_a_dispatch_that_reached_nobody_leaves_no_window_and_no_promise(world, store, monkeypatch):
    """The dispatcher answers 0 (it does not raise) when it told nobody. Then the 5-minute window is let go and nothing is promised: the
    NEXT report tells it, and no «working again» line goes for a «stopped» the person never got (Kadir's codex lens ③, 10-14)."""
    import app.services.notification_dispatch as nd

    calls: list[str] = []
    answers = iter([0, 1, 1, 1, 1])  # the first dispatch reaches nobody; the later ones do

    async def dispatch(*_a, **kw):
        calls.append(kw["event_type"])
        return next(answers)

    monkeypatch.setattr(nd, "dispatch_notification", dispatch)
    async with _client() as c:
        device = await _device(c, "d4685 mac l")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=LOOKS)  # the stood notice reaches nobody
        assert calls == ["agent.limit_paused"]
        await _report(c, device, a, "working", 3)  # back — but nothing was promised, so no «working again» is told
        assert calls == ["agent.limit_paused"], "no «working again» for a «stopped» nobody got"
        await _report(c, device, a, "waiting_input", 4, limit=LOOKS)  # stands again, inside what would have been the window
        assert calls == ["agent.limit_paused", "agent.limit_paused"], "the window was let go: this report tells it"
        await _report(c, device, a, "working", 5)  # now the promise was made, and kept once
        assert calls == ["agent.limit_paused", "agent.limit_paused", "agent.limit_lifted"]


def test_10_the_reset_time_reads_in_the_persons_zone_today_as_a_clock_another_day_with_the_date():
    """Yuna's {time}: «오후 3:20» / «3:20 PM» today · «10월 15일 오전 9:00» / «Oct 15, 9:00 AM» another day."""
    from zoneinfo import ZoneInfo

    from app.services.desktop_limit_notice import format_time

    seoul = ZoneInfo("Asia/Seoul")
    now = datetime(2026, 10, 14, 5, 0, tzinfo=timezone.utc)  # 14:00 in Seoul
    today = datetime(2026, 10, 14, 6, 20, tzinfo=timezone.utc)  # 15:20 Seoul
    tomorrow = datetime(2026, 10, 15, 0, 0, tzinfo=timezone.utc)  # 09:00 Seoul, the 15th
    assert format_time(today, seoul, "ko", now=now) == "오후 3:20"
    assert format_time(today, seoul, "en", now=now) == "3:20 PM"
    assert format_time(tomorrow, seoul, "ko", now=now) == "10월 15일 오전 9:00"
    assert format_time(tomorrow, seoul, "en", now=now) == "Oct 15, 9:00 AM"
    assert format_time(datetime(2026, 10, 14, 15, 0, tzinfo=timezone.utc), seoul, "en", now=now) == "Oct 15, 12:00 AM"  # midnight reads 12, not 0


def test_09_the_turn_end_word_follows_the_same_decision_as_the_strip():
    """Yuna §③ — one word for one state: a limit the app looks at again is «paused at the usage limit»; a held one, and one from a
    daemon that does not look, keep «usage limit» (fail-closed: never promise a look that never comes)."""
    from app.services.desktop_commands import _turn_end_kind

    def row(**kw):
        base = dict(state="waiting_input", limit_self_resume="unknown", limit_looks=None, limit_held=None, limited=True)
        return SimpleNamespace(**{**base, **kw})

    assert _turn_end_kind(row(limit_looks=True)) == ("paused_limit", "paused_limit")
    assert _turn_end_kind(row(limit_looks=True, limit_held="screen")) == ("usage_limit", "usage_limit")
    assert _turn_end_kind(row()) == ("usage_limit", "usage_limit")
    assert _turn_end_kind(row(limit_self_resume=None)) == ("waiting_input", "waiting_input")


# ── story 4685 AC8 (PO 10-21): the unit of the notice is the PERSON, not the setup ─────────────────────────────────────────────────
# 10-20 16:12Z: one Mac's six agents have six setups; they stood within 17 seconds and the person got six notices (the window and the
# promise were keyed by setup). A person's notice is one, and «working again» waits for ALL of that person's sessions.

async def test_15_three_setups_of_one_person_standing_in_a_window_are_one_notice_and_one_working_again_line(world):
    async with _client() as c:
        d1, d2, d3 = [await _device(c, f"d4685 mac m{i}") for i in (1, 2, 3)]
        a1, a2, a3 = [d["agents"][0]["member_id"] for d in (d1, d2, d3)]
        for seq, (d, a) in enumerate(((d1, a1), (d2, a2), (d3, a3)), start=1):
            await _report(c, d, a, "working", seq)
        for seq, (d, a) in enumerate(((d1, a1), (d2, a2), (d3, a3)), start=10):
            await _report(c, d, a, "waiting_input", seq, limit=LOOKS)
        assert len(await _notices(STOOD)) == 1, "three setups, one person: one notice (the window is the person's)"
        await _report(c, d1, a1, "working", 20)
        await _report(c, d2, a2, "working", 21)
        assert await _notices(LIFTED) == [], "the third setup still stands: «all working again» would be false"
        await _report(c, d3, a3, "working", 22)
        assert len(await _notices(LIFTED)) == 1, "the last of the person's sessions, in whichever setup, tells it once"


async def test_16_two_people_are_two_notices_each_to_the_person_who_connected_their_own_setup(world):
    plain_tm = PLAIN_TM
    await _second_person()
    async with _client() as c:
        d1, d2 = await _device(c, "d4685 mac n1"), await _device(c, "d4685 mac n2")
        await _sql(f"UPDATE desktop_setups SET confirmed_by = '{PLAIN_USER}' WHERE id = '{d2['setup_id']}'")
        a1, a2 = d1["agents"][0]["member_id"], d2["agents"][0]["member_id"]
        await _report(c, d1, a1, "working", 1)
        await _report(c, d2, a2, "working", 2)
        await _report(c, d1, a1, "waiting_input", 3, limit=LOOKS)
        await _report(c, d2, a2, "waiting_input", 4, limit=LOOKS)
        assert len(await _notices(STOOD, OWNER_TM)) == 1 and len(await _notices(STOOD, plain_tm)) == 1, "each person is told once, about their own"
        await _report(c, d1, a1, "working", 5)
        assert len(await _notices(LIFTED, OWNER_TM)) == 1 and await _notices(LIFTED, plain_tm) == [], "one person's setup being back says nothing for the other's"
        await _report(c, d2, a2, "working", 6)
        assert len(await _notices(LIFTED, plain_tm)) == 1


async def test_17_a_revoked_setups_stale_limited_row_does_not_hold_the_working_again_line_back(world):
    async with _client() as c:
        d1, d2 = await _device(c, "d4685 mac o1"), await _device(c, "d4685 mac o2")
        a1, a2 = d1["agents"][0]["member_id"], d2["agents"][0]["member_id"]
        await _report(c, d2, a2, "working", 1)
        await _report(c, d2, a2, "waiting_input", 2, limit=LOOKS)  # stands (the notice goes) ...
        assert len(await _notices(STOOD)) == 1
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{d2['setup_id']}'")  # ... then its setup is disconnected: the row is stale
        await _report(c, d1, a1, "working", 3)
        await _report(c, d1, a1, "waiting_input", 4, limit=LOOKS)  # inside the window: no new notice
        await _report(c, d1, a1, "working", 5)
        assert len(await _notices(LIFTED)) == 1, "a disconnected setup's old row is not the person's any more"


# ── story 4685 AC9 (PO 10-21): who is told — the owner of a phone paired with the setup, else whoever connected it ────────────────────
# 10-20 16:12Z: five of six setups were connected by the teacher's second account, whose only device is a dead iOS one; the one phone that is
# really paired (the DM account's android) heard about one agent of six. The phone that is paired is the person who holds the computer.

PLAIN_TM = uuid.UUID("d4424000-0000-0000-0000-000000000099")


async def _second_person():
    """A second person of the org in the same shape as the owner (a person's members.id is their org_members.id · project access granted) — the
    dispatcher resolves its targets through those."""
    from tests.test_4424_desktop_setup_realdb import PROJ

    await _sql(f"UPDATE org_members SET id = '{PLAIN_TM}' WHERE org_id = '{ORG}' AND user_id = '{PLAIN_USER}'",
               f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES ('{PLAIN_TM}','{ORG}','{PLAIN_USER}','human','Plain',true)",
               f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES (gen_random_uuid(),'{PROJ}','{PLAIN_TM}','granted')",
               f"UPDATE users SET locale = 'ko' WHERE id = '{PLAIN_USER}'")


async def _pair(setup_id, owner_member, *, removed=False, revoked=False):
    dev = uuid.uuid4()
    await _sql(
        f"INSERT INTO remote_devices (id,member_id,org_id,label,public_key,fingerprint,revoked_at) VALUES "
        f"('{dev}','{owner_member}','{ORG}','phone','pk-{dev}','fp-{dev}',{'now()' if revoked else 'NULL'})",
        f"INSERT INTO remote_device_pairings (id,remote_device_id,setup_id,paired_at,removed_at) VALUES "
        f"(gen_random_uuid(),'{dev}','{setup_id}',now(),{'now()' if removed else 'NULL'})",
    )


async def test_18_the_owner_of_a_paired_phone_is_told_not_the_person_who_connected_the_setup(world):
    await _second_person()
    async with _client() as c:
        d = await _device(c, "d4685 mac p1")  # connected by OWNER
        await _pair(d["setup_id"], PLAIN_TM)
        a = d["agents"][0]["member_id"]
        await _report(c, d, a, "working", 1)
        await _report(c, d, a, "waiting_input", 2, limit=LOOKS)
        assert len(await _notices(STOOD, PLAIN_TM)) == 1, "the phone paired with the computer is told"
        assert await _notices(STOOD, OWNER_TM) == [], "the person who only connected it is not — a paired phone is who holds the computer"
        await _report(c, d, a, "working", 3)
        assert len(await _notices(LIFTED, PLAIN_TM)) == 1 and await _notices(LIFTED, OWNER_TM) == []


async def test_19_one_paired_setup_among_unpaired_ones_two_people_two_notices_each_counting_its_own(world):
    """The 10-20 shape: one setup has the PO's phone, the other (older) setups have none and were connected by the second account."""
    await _second_person()
    async with _client() as c:
        paired, u1, u2 = [await _device(c, f"d4685 mac q{i}") for i in (1, 2, 3)]
        await _pair(paired["setup_id"], PLAIN_TM)  # u1 and u2 stay unpaired: connected by OWNER
        agents = {k: d["agents"][0]["member_id"] for k, d in (("p", paired), ("1", u1), ("2", u2))}
        for seq, (k, d) in enumerate((("p", paired), ("1", u1), ("2", u2)), start=1):
            await _report(c, d, agents[k], "working", seq)
        for seq, (k, d) in enumerate((("p", paired), ("1", u1), ("2", u2)), start=10):
            await _report(c, d, agents[k], "waiting_input", seq, limit=LOOKS)
        assert len(await _notices(STOOD, PLAIN_TM)) == 1 and len(await _notices(STOOD, OWNER_TM)) == 1, "two people, one notice each"
        # the two unpaired are one person's: they come back together or not at all
        await _report(c, u1, agents["1"], "working", 20)
        assert await _notices(LIFTED, OWNER_TM) == []
        await _report(c, u2, agents["2"], "working", 21)
        assert len(await _notices(LIFTED, OWNER_TM)) == 1 and await _notices(LIFTED, PLAIN_TM) == []
        await _report(c, paired, agents["p"], "working", 22)
        assert len(await _notices(LIFTED, PLAIN_TM)) == 1


async def test_20_a_removed_pairing_or_a_revoked_phone_key_is_no_pairing_the_connecter_is_told(world):
    await _second_person()
    async with _client() as c:
        d1, d2 = await _device(c, "d4685 mac r1"), await _device(c, "d4685 mac r2")
        await _pair(d1["setup_id"], PLAIN_TM, removed=True)   # the pairing was taken away
        await _pair(d2["setup_id"], PLAIN_TM, revoked=True)   # the phone key was revoked
        for seq, d in enumerate((d1, d2), start=1):
            await _report(c, d, d["agents"][0]["member_id"], "working", seq)
        for seq, d in enumerate((d1, d2), start=10):
            await _report(c, d, d["agents"][0]["member_id"], "waiting_input", seq, limit=LOOKS)
        assert await _notices(STOOD, PLAIN_TM) == [], "a dropped pairing / a revoked key is nobody's phone"
        assert len(await _notices(STOOD, OWNER_TM)) == 1, "so the person who connected the computer is told, once"


async def test_21_a_person_with_two_phones_paired_is_told_once(world):
    await _second_person()
    async with _client() as c:
        d = await _device(c, "d4685 mac s1")
        await _pair(d["setup_id"], PLAIN_TM)
        await _pair(d["setup_id"], PLAIN_TM)
        a = d["agents"][0]["member_id"]
        await _report(c, d, a, "working", 1)
        await _report(c, d, a, "waiting_input", 2, limit=LOOKS)
        assert len(await _notices(STOOD, PLAIN_TM)) == 1


# ── codex read (4685 AC8/AC9): the promise stays with its person · one person's failure is only theirs · two lifts at once ───────────────────

async def test_22_the_working_again_line_is_kept_to_the_person_it_was_promised_to_even_when_the_pairing_is_gone(world):
    await _second_person()
    async with _client() as c:
        d = await _device(c, "d4685 mac t1")
        await _pair(d["setup_id"], PLAIN_TM)
        a = d["agents"][0]["member_id"]
        await _report(c, d, a, "working", 1)
        await _report(c, d, a, "waiting_input", 2, limit=LOOKS)
        assert len(await _notices(STOOD, PLAIN_TM)) == 1
        await _sql(f"UPDATE remote_device_pairings SET removed_at = now() WHERE setup_id = '{d['setup_id']}'")  # the phone is taken off meanwhile
        await _report(c, d, a, "working", 3)
        assert len(await _notices(LIFTED, PLAIN_TM)) == 1, "told «stopped», so told «working again» — the pairing that made them the recipient is gone, the promise is not"
        assert await _notices(LIFTED, OWNER_TM) == [], "and nothing was promised to the person who only connected it"


async def test_25_a_removed_pairing_does_not_make_the_still_standing_sessions_of_that_setup_invisible_to_the_working_again_gate(world, store):
    await _second_person()
    async with _client() as c:
        d = await _device(c, "d4685 mac t1")
        await _pair(d["setup_id"], PLAIN_TM)
        a = d["agents"][0]["member_id"]
        for seq, key in ((1, "s-1"), (2, "s-2")):
            await _report(c, d, a, "working", seq, key=key)
        for seq, key in ((3, "s-1"), (4, "s-2")):
            await _report(c, d, a, "waiting_input", seq, key=key, limit=LOOKS)
        assert len(await _notices(STOOD, PLAIN_TM)) == 1
        await _sql(f"UPDATE remote_device_pairings SET removed_at = now() WHERE setup_id = '{d['setup_id']}'")  # the phone is taken off while both stand
        await _report(c, d, a, "working", 5, key="s-1")
        assert await _notices(LIFTED, PLAIN_TM) == [], "s-2 of the same setup still stands: «all working again» would be false, pairing or not"
        await _report(c, d, a, "working", 6, key="s-2")
        assert len(await _notices(LIFTED, PLAIN_TM)) == 1, "the last one back tells it once"


async def test_26_a_pairing_that_ended_before_the_episode_never_holds_a_persons_working_again_line_back(world):
    await _second_person()
    async with _client() as c:
        old, mine = [await _device(c, f"d4685 mac u{i}") for i in (1, 2)]
        await _pair(old["setup_id"], PLAIN_TM, removed=True)  # the person's phone was once on `old`, taken off long before
        await _pair(mine["setup_id"], PLAIN_TM)
        ao, am = old["agents"][0]["member_id"], mine["agents"][0]["member_id"]
        await _report(c, mine, am, "working", 1)
        await _report(c, mine, am, "waiting_input", 2, limit=LOOKS)
        assert len(await _notices(STOOD, PLAIN_TM)) == 1
        await _report(c, old, ao, "working", 3)
        await _report(c, old, ao, "waiting_input", 4, limit=LOOKS)  # `old` now stands — for whoever connected it, not for this person
        assert len(await _notices(STOOD, OWNER_TM)) == 1 and len(await _notices(STOOD, PLAIN_TM)) == 1
        await _report(c, mine, am, "working", 5)
        assert len(await _notices(LIFTED, PLAIN_TM)) == 1, "the setup this person was told about is back; another person's setup standing does not hold it"


async def test_27_a_setup_that_stood_inside_the_window_is_part_of_the_promise_even_when_its_pairing_goes_meanwhile(world, store):
    await _second_person()
    async with _client() as c:
        a, b = [await _device(c, f"d4685 mac w{i}") for i in (1, 2)]
        await _pair(a["setup_id"], PLAIN_TM)
        await _pair(b["setup_id"], PLAIN_TM)
        aa, ab = a["agents"][0]["member_id"], b["agents"][0]["member_id"]
        await _report(c, a, aa, "working", 1)
        await _report(c, b, ab, "working", 2)
        await _report(c, a, aa, "waiting_input", 3, limit=LOOKS)
        await _report(c, b, ab, "waiting_input", 4, limit=LOOKS)  # inside the window: folded, no second notice
        assert len(await _notices(STOOD, PLAIN_TM)) == 1
        await _sql(f"UPDATE remote_device_pairings SET removed_at = now() WHERE setup_id = '{b['setup_id']}'")  # the phone leaves b while it stands
        await _report(c, a, aa, "working", 5)
        assert await _notices(LIFTED, PLAIN_TM) == [], "b still stands and the person was told about it (folded): not «all working again»"
        await _report(c, b, ab, "working", 6)
        assert len(await _notices(LIFTED, PLAIN_TM)) == 1


async def test_28_a_stand_after_the_window_adds_to_the_promise_it_does_not_replace_it(world, store):
    from app.services import desktop_limit_notice as dln

    await _second_person()
    async with _client() as c:
        a, b = [await _device(c, f"d4685 mac x{i}") for i in (1, 2)]
        await _pair(a["setup_id"], PLAIN_TM)
        await _pair(b["setup_id"], PLAIN_TM)
        aa, ab = a["agents"][0]["member_id"], b["agents"][0]["member_id"]
        await _report(c, a, aa, "working", 1)
        await _report(c, b, ab, "working", 2)
        await _report(c, a, aa, "waiting_input", 3, limit=LOOKS)
        assert len(await _notices(STOOD, PLAIN_TM)) == 1
        await _sql(f"UPDATE remote_device_pairings SET removed_at = now() WHERE setup_id = '{a['setup_id']}'")  # the phone leaves a while it stands
        await dln._release_window(ORG, PLAIN_USER)  # the 5 minutes are over
        await _report(c, b, ab, "waiting_input", 4, limit=LOOKS)
        assert len(await _notices(STOOD, PLAIN_TM)) == 2, "a new window, a new notice"
        await _report(c, b, ab, "working", 5)
        assert await _notices(LIFTED, PLAIN_TM) == [], "a still stands and the person was told about it: the second notice did not make them forget it"
        await _report(c, a, aa, "working", 6)
        assert len(await _notices(LIFTED, PLAIN_TM)) == 1


async def test_29_setups_added_to_the_promise_at_the_same_instant_are_all_kept(world, store):
    from app.services import desktop_limit_notice as dln

    ids = [uuid.uuid4() for _ in range(6)]
    await asyncio.gather(*(dln._add_promised_setups(ORG, PLAIN_USER, [i]) for i in ids))
    assert await dln._promised_setups(ORG, PLAIN_USER) == frozenset(ids)
    await dln._take_open(ORG, PLAIN_USER)
    assert await dln._promised_setups(ORG, PLAIN_USER) == frozenset(), "taking the record takes what it was about"


@pytest.mark.parametrize("fails,how", [("owner", "python"), ("plain", "sql")])
async def test_23_one_persons_failure_takes_back_only_their_own_notice(world, monkeypatch, fails, how):
    """Two people have phones paired with the setup (told in a fixed order: the owner, then the second person). Telling one of them fails — as a Python
    error, or as an SQL error that aborts the transaction (the second's, after the first was told). The other is told all the same and the report stands."""
    await _second_person()
    import app.services.notification_dispatch as nd
    from sqlalchemy import text

    real = nd.dispatch_notification
    failing = OWNER_TM if fails == "owner" else PLAIN_TM

    async def flaky(db, *a, **kw):
        if kw.get("target_member_ids") == [failing]:
            if how == "python":
                raise RuntimeError("boom")
            await db.execute(text("SELECT 1/0"))  # an SQL error: the transaction would be unusable without a savepoint of this person's own
        return await real(db, *a, **kw)

    monkeypatch.setattr(nd, "dispatch_notification", flaky)
    async with _client() as c:
        d = await _device(c, "d4685 mac u1")
        await _pair(d["setup_id"], OWNER_TM)
        await _pair(d["setup_id"], PLAIN_TM)
        a = d["agents"][0]["member_id"]
        await _report(c, d, a, "working", 1)
        await _report(c, d, a, "waiting_input", 2, limit=LOOKS)  # 200: the report stands
        other = PLAIN_TM if fails == "owner" else OWNER_TM
        assert await _notices(STOOD, failing) == []
        assert len(await _notices(STOOD, other)) == 1, "one person's failure must neither silence nor take back the other person's notice"


async def test_24_two_of_one_persons_setups_coming_back_at_the_same_moment_still_tell_working_again_once(world):
    """Each transaction sees the OTHER's session still standing (not committed yet) and would return: nobody would tell «working again». The lift is
    serialised per person — the second waits for the first's commit, counts again, and tells."""
    import asyncio

    from sqlalchemy import select

    from app.core.database import async_session_factory
    from app.models.desktop_relay import DesktopSession
    from app.models.desktop_setup import DesktopSetup
    from app.services import desktop_limit_notice as dln

    async with _client() as c:
        d1, d2 = await _device(c, "d4685 mac v1"), await _device(c, "d4685 mac v2")
        a1, a2 = d1["agents"][0]["member_id"], d2["agents"][0]["member_id"]
        for seq, (d, a) in enumerate(((d1, a1), (d2, a2)), start=1):
            await _report(c, d, a, "working", seq)
        for seq, (d, a) in enumerate(((d1, a1), (d2, a2)), start=10):
            await _report(c, d, a, "waiting_input", seq, limit=LOOKS)
        assert len(await _notices(STOOD)) == 1

    async def load(s, setup_id):
        setup = await s.get(DesktopSetup, uuid.UUID(setup_id))
        row = (await s.execute(select(DesktopSession).where(DesktopSession.setup_id == setup.id))).scalars().one()
        return setup, row

    s1, s2 = async_session_factory(), async_session_factory()
    try:
        setup1, row1 = await load(s1, d1["setup_id"])
        row1.limited, row1.state = False, "working"
        await s1.flush()
        await dln.after_report(s1, setup1, row1, was_limited=True)  # the other is still standing (as far as this transaction can see): nothing to tell
        assert await _notices(LIFTED) == []

        setup2, row2 = await load(s2, d2["setup_id"])
        row2.limited, row2.state = False, "working"
        await s2.flush()
        second = asyncio.create_task(dln.after_report(s2, setup2, row2, was_limited=True))
        await asyncio.sleep(0.6)  # fixed-sleep-ok: the second must be WAITING on the first's lock, not finished
        assert not second.done(), "the second lift must wait for the first transaction"
        await s1.commit()
        await asyncio.wait_for(second, timeout=10)
        await s2.commit()
    finally:
        await s1.close()
        await s2.close()
    assert len(await _notices(LIFTED)) == 1
