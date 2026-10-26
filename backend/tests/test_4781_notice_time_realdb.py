"""story 4781 (AC7 · PO 10-26) — the «stopped» notice says the reset time once it is known, in the SAME notification.

10-26 (dev, a stand-in CLI on the real daemon): the notice went 19 ms after the stop hook, before the report that carries the reset time, and said «풀리는 시각은 아직 몰라요» while the
web strip a moment later said «오후 4:45에 이어서 해요». The notice is not delayed (a stop is a signal to tell at once). The next report of the SAME limit that carries the time rewrites
the notification that went — the card in the list and the bell line — and tells nothing new. The rewrite touches exactly the two rows the notice made (by id), only while their words are
still what the notice wrote, and only for a report from a computer the notice is about (codex 10-26). Both promise stores (this process · fakeredis) run every test."""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    OWNER_TM,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device
from tests.test_4685_limit_notice_realdb import LIFTED, STOOD, UNKNOWN_BODY, _notices, _report, store  # noqa: F401 — `store`: the two promise stores

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [pytest.mark.anyio, pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")]

import uuid

ORG_UUID, OWNER_UUID = uuid.UUID(str(ORG)), uuid.UUID(str(OWNER))
TIMED = {"self_resume": "unknown", "looks": True}  # (no time) — the first report of a limit


@pytest.fixture(autouse=True)
async def _remote_control_on_and_korean(world, store, monkeypatch):
    from app.services import desktop_limit_notice

    monkeypatch.setattr("app.services.desktop_limit_notice.LIFT_HOLD_SEC", 0)
    desktop_limit_notice._local.clear()  # (the no-Redis path of this process keeps its marks in a module map)
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now(), timezone = 'Asia/Seoul' WHERE id = '{ORG}'",
               f"UPDATE users SET locale = 'ko' WHERE id = '{OWNER}'",
               f"DELETE FROM notifications WHERE org_id = '{ORG}' AND user_id = '{OWNER}' AND type = 'agent.limit_paused'")  # (the cards of the other tests in this database are not under test here)
    yield
    desktop_limit_notice._local.clear()


def _later(hours: float = 26) -> datetime:
    return datetime.now(timezone.utc) + timedelta(hours=hours)  # another day, so the words carry the date and the test does not depend on the hour it runs


def _with_time(at: datetime) -> dict:
    return {**TIMED, "at": at.isoformat()}


def _words(at: datetime) -> str:
    from zoneinfo import ZoneInfo

    local = at.astimezone(ZoneInfo("Asia/Seoul"))
    clock = f"{'오전' if local.hour < 12 else '오후'} {local.hour % 12 or 12}:{local.minute:02d}"
    return f"사용 한도에 걸려 멈췄어요 — {local.month}월 {local.day}일 {clock}에 풀려요. 다시 일하기 시작하면 또 알려요."


async def _cards():
    rows = await _sql(fetch="SELECT body FROM notifications WHERE org_id = :o AND user_id = :u AND type = 'agent.limit_paused' ORDER BY created_at", params={"o": ORG, "u": OWNER})
    return [r[0] for r in rows]


async def _change_by_hand(suffix: str) -> None:
    """somebody edits this person's stopped notice (the card and the bell line)"""
    await _sql(f"UPDATE notifications SET body = body || '{suffix}' WHERE org_id = '{ORG}' AND user_id = '{OWNER}' AND type = 'agent.limit_paused'",
               f"UPDATE events SET payload = jsonb_set(payload, '{{body}}', to_jsonb((payload->>'body') || '{suffix}')) "
               f"WHERE org_id = '{ORG}' AND recipient_id = '{OWNER_TM}' AND payload->>'event_type' = 'agent.limit_paused'")


async def test_01_the_notice_that_said_unknown_is_rewritten_in_place_when_the_time_arrives(world):
    async with _client() as c:
        device = await _device(c, "d4781t mac a")
        a = device["agents"][0]["member_id"]
        at = _later()
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=TIMED)  # the first report of a limit: no time yet
        (n,) = await _notices(STOOD)
        assert n["body"] == UNKNOWN_BODY and await _cards() == [UNKNOWN_BODY]
        await _report(c, device, a, "waiting_input", 3, limit=_with_time(at))  # the same limit, now with its time
        (n,) = await _notices(STOOD)  # still ONE notification — rewritten, not told again
        assert n["body"] == _words(at), "the bell line has the time"
        assert await _cards() == [_words(at)], "and so has the card in the list"
        assert n["title"].endswith("한도로 쉬는 중"), "the title is not touched"


async def test_02_it_is_done_once_and_a_later_report_changes_nothing(world, caplog):
    async with _client() as c:
        device = await _device(c, "d4781t mac b")
        a = device["agents"][0]["member_id"]
        first, second = _later(), _later(30)
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=TIMED)
        await _report(c, device, a, "waiting_input", 3, limit=TIMED)  # again with no time: nothing to write
        assert await _cards() == [UNKNOWN_BODY]
        with caplog.at_level(logging.INFO, logger="app.services.desktop_limit_notice"):
            await _report(c, device, a, "waiting_input", 4, limit=_with_time(first))
            await _report(c, device, a, "waiting_input", 5, limit=_with_time(second))  # a changed time after it: not chased
        assert await _cards() == [_words(first)]
        assert sum("stood time filled in" in r.getMessage() for r in caplog.records) == 1
        assert len(await _notices(STOOD)) == 1 and await _notices(LIFTED) == []


async def test_03_a_notice_that_already_had_its_time_is_not_touched(world, caplog):
    async with _client() as c:
        device = await _device(c, "d4781t mac c")
        a = device["agents"][0]["member_id"]
        at = _later()
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit={"at": at.isoformat(), "again": False})
        assert await _cards() == [_words(at)]
        with caplog.at_level(logging.INFO, logger="app.services.desktop_limit_notice"):
            await _report(c, device, a, "waiting_input", 3, limit={"at": at.isoformat(), "again": False})
        assert not any("stood time filled in" in r.getMessage() for r in caplog.records), "nothing was waiting for a time"
        assert await _cards() == [_words(at)]


async def test_04_a_line_somebody_changed_is_left_alone_even_by_a_suffix(world, caplog):
    """The rewrite is for the words the notice wrote — exactly. A line changed since (a suffix too, not only a different text) is not clobbered."""
    async with _client() as c:
        device = await _device(c, "d4781t mac d")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=TIMED)
        await _change_by_hand(" (custom note)")
        with caplog.at_level(logging.INFO, logger="app.services.desktop_limit_notice"):
            await _report(c, device, a, "waiting_input", 3, limit=_with_time(_later()))
        assert await _cards() == [UNKNOWN_BODY + " (custom note)"]
        (n,) = await _notices(STOOD)
        assert n["body"] == UNKNOWN_BODY + " (custom note)"
        assert any("stood time filled in" in r.getMessage() and "notification=False bell=False" in r.getMessage() for r in caplog.records), "it looked, and wrote nothing"


async def test_05_two_sessions_the_time_is_filled_in_only_when_every_standing_session_has_one(world):
    async with _client() as c:
        device = await _device(c, "d4781t mac e")
        a, b = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        await _report(c, device, a, "working", 1, key="s-a")
        await _report(c, device, b, "working", 2, key="s-b")
        await _report(c, device, a, "waiting_input", 3, key="s-a", limit=TIMED)
        await _report(c, device, b, "waiting_input", 4, key="s-b", limit=TIMED)  # folded into the first notice's count
        at_a = _later()
        await _report(c, device, a, "waiting_input", 5, key="s-a", limit=_with_time(at_a))
        assert (await _cards())[0].startswith("사용 한도에 걸려 멈췄어요 — 풀리는 시각은 아직 몰라요"), "b still has no time: the words stay"
        at_b = _later(28)
        await _report(c, device, b, "waiting_input", 6, key="s-b", limit=_with_time(at_b))
        (card,) = await _cards()
        assert card.startswith("사용 한도에 걸려 멈췄어요 — ") and "에 풀려요" in card and "아직 몰라요" not in card


async def test_06_the_person_changed_language_meanwhile_and_the_notice_still_gets_its_time(world):
    """The words are matched by what was written, not by the person's language now (codex 10-26): a notice written in Korean is rewritten after the person switched to English."""
    async with _client() as c:
        device = await _device(c, "d4781t mac f")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=TIMED)
        assert await _cards() == [UNKNOWN_BODY]
        await _sql(f"UPDATE users SET locale = 'en' WHERE id = '{OWNER}'")
        await _report(c, device, a, "waiting_input", 3, limit=_with_time(_later()))
        (card,) = await _cards()
        assert "it resets at" in card and "아직 몰라요" not in card, card


async def test_07_a_report_from_a_computer_the_notice_is_not_about_does_not_rewrite_it(world):
    """The mark names the computers the notice is about. A report from a computer that is not among them (its pointer may be set because somebody else waits there) leaves the notice alone."""
    from app.services import desktop_limit_notice

    async with _client() as c:
        one = await _device(c, "d4781t mac g1")
        a = one["agents"][0]["member_id"]
        await _report(c, one, a, "working", 1)
        await _report(c, one, a, "waiting_input", 2, limit=TIMED)
        assert await _cards() == [UNKNOWN_BODY]
        other = await _device(c, "d4781t mac g2")
        peeked = await desktop_limit_notice._peek_time_unknown(ORG_UUID, OWNER_UUID)
        assert peeked is not None
        mark = {**peeked[1], "setups": [str(other["setup_id"])]}  # the same notice, now said to be about the other computer only (and that computer's pointer is set)
        await desktop_limit_notice._mark_time_unknown(ORG_UUID, OWNER_UUID, mark)
        await desktop_limit_notice._drop_setup_pointer(one["setup_id"])
        await desktop_limit_notice._mark_time_unknown(ORG_UUID, uuid.uuid4(), {"setups": [str(one["setup_id"])], "nonce": "x", "written": "x", "note": None, "bell": None})  # (somebody else waits on THIS computer: its pointer is set)
        await _report(c, one, a, "waiting_input", 3, limit=_with_time(_later(30)))
        assert await _cards() == [UNKNOWN_BODY], "the notice is not about this computer: this computer's report does not rewrite it"


async def test_08_nobody_waiting_for_a_time_costs_no_recipient_lookup(world, monkeypatch):
    """The common case — every report of a limit that already has its time — is one cheap lookup: the recipients (a pairing query) are asked only while a notice waits for its time (codex 10-26)."""
    from app.services import desktop_limit_notice

    asked = []
    real = desktop_limit_notice._recipients

    async def counting(db, setup):
        asked.append(setup.id)
        return await real(db, setup)

    async with _client() as c:
        device = await _device(c, "d4781t mac h")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=TIMED)  # told without its time: a notice waits for it
        monkeypatch.setattr(desktop_limit_notice, "_recipients", counting)
        await _report(c, device, a, "waiting_input", 3, limit=_with_time(_later()))  # the time comes: the recipients ARE asked, and the notice is rewritten
        assert asked, "while a notice waits for its time the recipients are looked up"
        asked.clear()
        for seq in range(4, 9):
            await _report(c, device, a, "waiting_input", seq, limit=_with_time(_later()))
        assert asked == [], "nothing waits any more: no recipient lookup on these reports"


async def test_09_a_notice_that_is_over_is_never_rewritten_by_a_later_limit(world):
    """The mark belongs to ITS notice: after the working-again line the person's open notice is gone, and the next limit's time must not be written onto the old card."""
    async with _client() as c:
        device = await _device(c, "d4781t mac i")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=TIMED)
        assert await _cards() == [UNKNOWN_BODY]
        await _report(c, device, a, "working", 3)  # lifted (hold 0): the open notice is gone
        assert len(await _notices(LIFTED)) == 1
        at = _later()
        await _report(c, device, a, "waiting_input", 4, limit=_with_time(at))  # a new limit (inside the cooldown: folded, no card of its own)
        await _report(c, device, a, "waiting_input", 5, limit=_with_time(at))  # the same new limit again: the fill path runs
        assert (await _cards())[0] == UNKNOWN_BODY, "the first notice stays what it said: its episode is over"


async def test_10_a_notice_that_is_not_committed_yet_keeps_its_mark_for_the_next_report(world):
    """The mark is written inside the report's transaction; a report that finds it before the notice is visible must not use it up (codex 10-26)."""
    from app.services import desktop_limit_notice

    async with _client() as c:
        device = await _device(c, "d4781t mac j")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=TIMED)
        await _sql(f"DELETE FROM notifications WHERE org_id = '{ORG}' AND user_id = '{OWNER}' AND type = 'agent.limit_paused'")  # (as if the card were not visible yet)
        await _report(c, device, a, "waiting_input", 3, limit=_with_time(_later()))
        assert await desktop_limit_notice._peek_time_unknown(ORG_UUID, OWNER_UUID) is not None, "the mark was not used up"


async def test_11_a_computer_folded_into_the_notice_is_part_of_its_wait(world):
    """Two computers of one person: A stands without a time, B stands inside the cooldown (folded, no card of its own). The notice's time is made of both — B's report must reach the fill too, or a
    notice whose last missing time comes from B would say «not known» for ever (codex 10-26)."""
    async with _client() as c:
        one = await _device(c, "d4781t mac k1")
        a = one["agents"][0]["member_id"]
        other = await _device(c, "d4781t mac k2")
        o = other["agents"][0]["member_id"]
        await _report(c, one, a, "working", 1)
        await _report(c, other, o, "working", 1)
        await _report(c, one, a, "waiting_input", 2, limit=TIMED)
        await _report(c, other, o, "waiting_input", 2, limit=TIMED)  # folded: no card of its own
        assert await _cards() == [UNKNOWN_BODY]
        at_a, at_o = _later(30), _later(40)
        await _report(c, one, a, "waiting_input", 3, limit=_with_time(at_a))
        assert await _cards() == [UNKNOWN_BODY], "B still has no time"
        await _report(c, other, o, "waiting_input", 3, limit=_with_time(at_o))  # the last missing time comes from the folded computer
        assert await _cards() == [_words(max(at_a, at_o))]


async def test_12_the_pointer_of_a_lifted_notice_is_dropped_by_the_next_report(world, monkeypatch):
    """A lifted notice leaves its mark to run out; its computer's reports must not keep asking for recipients for the hour (codex 10-26)."""
    from app.services import desktop_limit_notice

    asked = []
    real = desktop_limit_notice._recipients

    async def counting(db, setup):
        asked.append(setup.id)
        return await real(db, setup)

    async with _client() as c:
        device = await _device(c, "d4781t mac l")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=TIMED)
        await _report(c, device, a, "working", 3)  # lifted: the notice is over, its mark is left to run out
        monkeypatch.setattr(desktop_limit_notice, "_recipients", counting)
        await _report(c, device, a, "waiting_input", 4, limit=_with_time(_later()))  # the next limit
        await _report(c, device, a, "waiting_input", 5, limit=_with_time(_later()))  # the fill path: the stale pointer is looked at once and dropped
        asked.clear()
        for seq in range(6, 10):
            await _report(c, device, a, "waiting_input", seq, limit=_with_time(_later()))
        assert asked == [], "the pointer of a notice that is over is gone: these reports cost nothing"
