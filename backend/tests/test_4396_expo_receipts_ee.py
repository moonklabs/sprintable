"""story #4396 — Expo push receipts: ok tickets are remembered in Redis and read 15 min later by the delivery loop.

Pinned (PO 17:20Z · Expo docs, Last Updated 2026-09-25):
- record: HASH per ticket (device_id · org_id · platform · sent_at — no token) with TTL 24 h · ZSET score = sent + 15 min;
- check: only due tickets · ≤1000 ids per request · each ticket processed by one instance (ZREM ownership);
- DeviceNotRegistered → device deactivated (own session) · other errors → one log line per kind · org · platform with a count,
  no token and no ticket id;
- result unknown (Expo 5xx · network · receipt not ready) → re-queued a few minutes later, not logged as an error; never past
  24 h;
- sweep of ZSET members past 24 h · a ticket whose hash already expired is dropped quietly;
- without Redis nothing happens;
- the dispatcher loop runs the check isolated: a failing check does not stop that tick's deliveries.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from types import SimpleNamespace

import fakeredis.aioredis
import pytest

from ee.services import expo_receipts as er

ORG = uuid.uuid4()
NOW = 1_800_000_000.0


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def redis(monkeypatch):
    client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(er, "_redis", lambda: client)
    return client


@pytest.fixture
def fetched(monkeypatch):
    """Records getReceipts calls; answers from `fetched.answer` (ticket id → receipt), or raises `fetched.error`."""
    box = SimpleNamespace(calls=[], answer={}, error=None)

    async def fake_fetch(ids):
        box.calls.append(list(ids))
        if box.error is not None:
            raise box.error
        return {t: box.answer[t] for t in ids if t in box.answer}

    monkeypatch.setattr(er, "_fetch_receipts", fake_fetch)
    return box


@pytest.fixture
def deactivated(monkeypatch):
    calls: list[tuple[uuid.UUID, list[uuid.UUID]]] = []

    async def fake_deactivate(org_id, device_ids):
        calls.append((org_id, sorted(device_ids)))
        return len(device_ids)

    monkeypatch.setattr(er, "_deactivate_devices", fake_deactivate)
    return calls


async def _record(monkeypatch, tickets, *, at=NOW):
    monkeypatch.setattr(er.time, "time", lambda: at)
    await er.record_expo_tickets(ORG, tickets)


def _receipt_errors(caplog):
    return [r.structured for r in caplog.records if getattr(r, "structured", {}).get("event") == "expo_receipt_error"]


@pytest.mark.anyio
async def test_record_keeps_device_org_platform_no_token_24h_ttl_and_due_in_15_min(redis, monkeypatch):
    dev = uuid.uuid4()
    await _record(monkeypatch, [("tk-1", dev, "android")])
    meta = await redis.hgetall("expo:receipt:tk-1")
    assert meta == {"device_id": str(dev), "org_id": str(ORG), "platform": "android", "sent_at": str(NOW)}
    assert not any("token" in k for k in meta)
    assert 0 < await redis.ttl("expo:receipt:tk-1") <= 24 * 3600
    assert await redis.zscore(er.DUE_KEY, "tk-1") == NOW + 15 * 60


@pytest.mark.anyio
async def test_nothing_is_read_before_15_minutes(redis, fetched, monkeypatch):
    await _record(monkeypatch, [("tk-1", uuid.uuid4(), "ios")])
    await er.check_due_expo_receipts(now=NOW + 14 * 60)
    assert fetched.calls == []
    assert await redis.zscore(er.DUE_KEY, "tk-1") is not None


@pytest.mark.anyio
async def test_ok_receipt_is_taken_off_and_nothing_else_happens(redis, fetched, deactivated, caplog, monkeypatch):
    caplog.set_level(logging.INFO, logger=er.logger.name)
    await _record(monkeypatch, [("tk-1", uuid.uuid4(), "ios")])
    fetched.answer = {"tk-1": {"status": "ok"}}
    await er.check_due_expo_receipts(now=NOW + 15 * 60)
    assert fetched.calls == [["tk-1"]]
    assert await redis.zscore(er.DUE_KEY, "tk-1") is None
    assert deactivated == [] and _receipt_errors(caplog) == []
    # one pass line with counts only — what the live check reads ~15 min after a normal notification
    passes = [r.structured for r in caplog.records if getattr(r, "structured", {}).get("event") == "expo_receipt_check"]
    assert passes == [{"event": "expo_receipt_check", "checked": 1, "ok": 1, "error": 0, "requeued": 0, "deactivated": 0}]


@pytest.mark.anyio
async def test_device_not_registered_deactivates_and_errors_log_one_line_per_kind_org_platform(
    redis, fetched, deactivated, caplog, monkeypatch,
):
    caplog.set_level(logging.WARNING, logger=er.logger.name)
    d1, d2, d3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await _record(monkeypatch, [("tk-1", d1, "android"), ("tk-2", d2, "android"), ("tk-3", d3, "ios")])
    fetched.answer = {
        "tk-1": {"status": "error", "message": "x", "details": {"error": "DeviceNotRegistered"}},
        "tk-2": {"status": "error", "message": "x", "details": {"error": "DeviceNotRegistered"}},
        "tk-3": {"status": "error", "message": "x", "details": {"error": "MessageRateExceeded"}},
    }
    await er.check_due_expo_receipts(now=NOW + 16 * 60)
    assert deactivated == [(ORG, sorted([(d1, NOW), (d2, NOW)]))]
    lines = sorted(_receipt_errors(caplog), key=lambda x: x["error"])
    assert lines == [
        {"event": "expo_receipt_error", "error": "DeviceNotRegistered", "org_id": str(ORG), "platform": "android", "count": 2},
        {"event": "expo_receipt_error", "error": "MessageRateExceeded", "org_id": str(ORG), "platform": "ios", "count": 1},
    ]
    assert "tk-" not in repr(lines)  # no ticket id in the log line


@pytest.mark.anyio
async def test_expo_failure_requeues_in_5_minutes_and_is_not_logged_as_an_error(redis, fetched, deactivated, caplog, monkeypatch):
    caplog.set_level(logging.INFO, logger=er.logger.name)
    await _record(monkeypatch, [("tk-1", uuid.uuid4(), "android")])
    fetched.error = RuntimeError("503 from Expo")
    await er.check_due_expo_receipts(now=NOW + 15 * 60)
    assert await redis.zscore(er.DUE_KEY, "tk-1") == NOW + 15 * 60 + 5 * 60
    assert _receipt_errors(caplog) == [] and deactivated == []
    passes = [r.structured for r in caplog.records if getattr(r, "structured", {}).get("event") == "expo_receipt_check"]
    assert passes == [{"event": "expo_receipt_check", "checked": 1, "ok": 0, "error": 0, "requeued": 1, "deactivated": 0}]


@pytest.mark.anyio
async def test_receipt_not_ready_is_requeued_but_never_past_24_hours(redis, fetched, monkeypatch):
    await _record(monkeypatch, [("tk-1", uuid.uuid4(), "android")])
    fetched.answer = {}  # not ready yet
    await er.check_due_expo_receipts(now=NOW + 15 * 60)
    assert await redis.zscore(er.DUE_KEY, "tk-1") == NOW + 20 * 60
    late = NOW + 24 * 3600 - 60  # 5 more minutes would pass Expo's 24 h
    await redis.zadd(er.DUE_KEY, {"tk-1": late})
    await er.check_due_expo_receipts(now=late)
    assert await redis.zscore(er.DUE_KEY, "tk-1") is None


@pytest.mark.anyio
async def test_a_missing_hash_is_dropped_quietly(redis, fetched):
    await redis.zadd(er.DUE_KEY, {"orphan": NOW - 60})  # its hash already expired (TTL)
    await er.check_due_expo_receipts(now=NOW)
    assert await redis.zcard(er.DUE_KEY) == 0
    assert fetched.calls == []


@pytest.mark.anyio
async def test_sweep_clears_members_past_24_hours_before_they_can_crowd_out_due_tickets(redis, fetched, monkeypatch):
    """Stale members (past 24 h) are swept first, so they never take the per-pass slots of tickets that can still be read."""
    await redis.zadd(er.DUE_KEY, {f"stale-{i}": NOW - 24 * 3600 - 100 - i for i in range(3)})
    await _record(monkeypatch, [("tk-fresh", uuid.uuid4(), "android")], at=NOW - 20 * 60)
    fetched.answer = {"tk-fresh": {"status": "ok"}}
    await er.check_due_expo_receipts(now=NOW, limit=2)
    assert fetched.calls == [["tk-fresh"]]
    assert await redis.zcard(er.DUE_KEY) == 0


@pytest.mark.anyio
async def test_at_most_1000_ids_per_request(redis, fetched, monkeypatch):
    await _record(monkeypatch, [(f"tk-{i}", uuid.uuid4(), "android") for i in range(1500)])
    fetched.answer = {f"tk-{i}": {"status": "ok"} for i in range(1500)}
    await er.check_due_expo_receipts(now=NOW + 15 * 60)
    await er.check_due_expo_receipts(now=NOW + 15 * 60)
    assert [len(c) for c in fetched.calls] == [1000, 500]


@pytest.mark.anyio
async def test_a_ticket_another_instance_took_first_is_not_read_again(redis, fetched, monkeypatch):
    """The race between instances: both see the same due tickets, but only the one whose ZREM removed a ticket reads it.
    Here another instance takes tk-1 between our candidate read and our ZREM."""
    await _record(monkeypatch, [("tk-1", uuid.uuid4(), "android"), ("tk-2", uuid.uuid4(), "android")])
    fetched.answer = {"tk-1": {"status": "ok"}, "tk-2": {"status": "ok"}}
    real_range = redis.zrangebyscore

    async def range_then_other_instance_takes_tk1(*args, **kwargs):
        found = await real_range(*args, **kwargs)
        await redis.zrem(er.DUE_KEY, "tk-1")  # the other instance's ZREM wins
        return found

    monkeypatch.setattr(redis, "zrangebyscore", range_then_other_instance_takes_tk1)
    await er.check_due_expo_receipts(now=NOW + 15 * 60)
    assert fetched.calls == [["tk-2"]]


@pytest.mark.anyio
async def test_without_redis_nothing_happens(monkeypatch, fetched):
    monkeypatch.setattr(er, "_redis", lambda: None)
    await er.record_expo_tickets(ORG, [("tk-1", uuid.uuid4(), "android")])
    await er.check_due_expo_receipts(now=NOW + 3600)
    assert fetched.calls == []


@pytest.mark.anyio
async def test_send_records_ok_tickets_by_device_not_error_ones(monkeypatch):
    from ee.services import expo_push

    d_ok, d_err = uuid.uuid4(), uuid.uuid4()
    devices = [
        {"expo_push_token": "ExponentPushToken[a]", "id": d_ok, "platform": "ios"},
        {"expo_push_token": "ExponentPushToken[b]", "id": d_err, "platform": "android"},
    ]

    async def fake_send(_chunk):
        return [{"status": "ok", "id": "tk-ok"}, {"status": "error", "details": {"error": "DeviceNotRegistered"}}]

    recorded: list = []

    async def fake_record(org_id, tickets, *, sent_at=None):
        recorded.append((org_id, tickets, sent_at))

    monkeypatch.setattr(expo_push, "_expo_send_chunk", fake_send)
    monkeypatch.setattr(er, "record_expo_tickets", fake_record)
    dead = await expo_push._send_expo_push_targets(devices, title="t", body="b", event_type="e", org_id=ORG)
    assert dead == ["ExponentPushToken[b]"]
    assert [(o, t) for o, t, _ in recorded] == [(ORG, [("tk-ok", d_ok, "ios")])]


@pytest.mark.anyio
async def test_sent_at_is_taken_before_sending_not_after_the_loop(monkeypatch):
    """PO 17:58Z ① — a device registered again while the chunks were going out counts as registered after the push."""
    from ee.services import expo_push

    clock = {"now": NOW}
    monkeypatch.setattr(expo_push.time, "time", lambda: clock["now"])

    async def slow_send(_chunk):
        clock["now"] += 10  # sending takes a while
        return [{"status": "ok", "id": "tk-ok"}]

    recorded: list = []

    async def fake_record(org_id, tickets, *, sent_at=None):
        recorded.append(sent_at)

    monkeypatch.setattr(expo_push, "_expo_send_chunk", slow_send)
    monkeypatch.setattr(er, "record_expo_tickets", fake_record)
    devices = [{"expo_push_token": "ExponentPushToken[a]", "id": uuid.uuid4(), "platform": "ios"}]
    await expo_push._send_expo_push_targets(devices, title="t", body="b", event_type="e", org_id=ORG)
    assert recorded == [NOW]


@pytest.mark.anyio
async def test_the_count_line_reports_rows_actually_switched_off(redis, fetched, caplog, monkeypatch):
    """PO 17:58Z ② — two DeviceNotRegistered receipts, but one device was registered again → deactivated=1, not 2."""
    caplog.set_level(logging.INFO, logger=er.logger.name)

    async def one_of_them(org_id, devices):
        return 1

    monkeypatch.setattr(er, "_deactivate_devices", one_of_them)
    await _record(monkeypatch, [("tk-1", uuid.uuid4(), "android"), ("tk-2", uuid.uuid4(), "android")])
    gone = {"status": "error", "details": {"error": "DeviceNotRegistered"}}
    fetched.answer = {"tk-1": gone, "tk-2": gone}
    await er.check_due_expo_receipts(now=NOW + 16 * 60)
    passes = [r.structured for r in caplog.records if getattr(r, "structured", {}).get("event") == "expo_receipt_check"]
    assert passes[-1]["deactivated"] == 1 and passes[-1]["error"] == 2


@pytest.mark.anyio
async def test_a_failing_receipt_check_does_not_stop_the_ticks_deliveries(monkeypatch, caplog):
    """PO 17:20Z ① — the check runs isolated in the dispatcher loop: it raising must not skip that tick's claim / deliver,
    and the failure is logged inside the pass (not left as an unretrieved task exception)."""
    from app.core.config import settings
    from app.services import delivery_dispatcher as dd

    monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda self: True))
    monkeypatch.setattr(dd, "_receipt_task", None)

    async def broken_check(*_a, **_k):
        raise RuntimeError("redis exploded mid-check")

    monkeypatch.setattr(er, "check_due_expo_receipts", broken_check)

    async def no_reap():
        return 0

    claims = iter([[{"id": uuid.uuid4(), "org_id": ORG, "kind": "expo_push", "payload": {}, "attempts": 0}]])

    async def claim_once(*_a, **_k):
        try:
            return next(claims)
        except StopIteration:
            raise asyncio.CancelledError

    events: list = []

    async def fake_deliver(job):
        events.append("deliver")

    real_sleep = asyncio.sleep

    async def recording_sleep(delay):
        events.append(f"sleep {delay}")
        await real_sleep(0)

    monkeypatch.setattr(dd, "_reap_expired_claims", no_reap)
    monkeypatch.setattr(dd, "_claim_batch", claim_once)
    monkeypatch.setattr(dd, "_deliver_one", fake_deliver)
    monkeypatch.setattr(dd.asyncio, "sleep", recording_sleep)
    await dd.delivery_dispatcher_loop()  # ends on the CancelledError from the second claim
    # delivered in the same tick — no error backoff (sleep) before it
    assert events[0] == "deliver" and not any(e.startswith("sleep 1") for e in events)
    if not dd._receipt_task.done():
        await dd._receipt_task
    assert dd._receipt_task.exception() is None  # the pass swallowed and logged its own failure
    assert any("expo receipt check failed" in r.getMessage() for r in caplog.records)


@pytest.mark.anyio
async def test_a_slow_receipt_check_does_not_delay_the_ticks_claim_and_delivery(monkeypatch):
    """PO 17:27Z ① — the pass runs beside the tick. A check that never finishes (a hung Expo) must not hold up delivery."""
    from app.core.config import settings
    from app.services import delivery_dispatcher as dd

    monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda self: True))
    monkeypatch.setattr(dd, "_receipt_task", None)
    never = asyncio.Event()

    async def hung_check(*_a, **_k):
        await never.wait()

    monkeypatch.setattr(er, "check_due_expo_receipts", hung_check)

    async def no_reap():
        return 0

    claims = iter([[{"id": uuid.uuid4(), "org_id": ORG, "kind": "expo_push", "payload": {}, "attempts": 0}]])

    async def claim_once(*_a, **_k):
        try:
            return next(claims)
        except StopIteration:
            raise asyncio.CancelledError

    delivered: list = []

    async def fake_deliver(job):
        delivered.append(job["id"])

    monkeypatch.setattr(dd, "_reap_expired_claims", no_reap)
    monkeypatch.setattr(dd, "_claim_batch", claim_once)
    monkeypatch.setattr(dd, "_deliver_one", fake_deliver)
    await asyncio.wait_for(dd.delivery_dispatcher_loop(), timeout=5)  # awaiting the check inside the tick would hang here
    assert len(delivered) == 1
    # the loop's shutdown cancels the pass still running beside it
    with pytest.raises(asyncio.CancelledError):
        await dd._receipt_task


@pytest.mark.anyio
async def test_only_one_receipt_pass_runs_at_a_time(monkeypatch):
    from app.core.config import settings
    from app.services import delivery_dispatcher as dd

    monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda self: True))
    monkeypatch.setattr(dd, "_receipt_task", None)
    started: list = []
    release = asyncio.Event()

    async def slow_check(*_a, **_k):
        started.append(1)
        await release.wait()

    monkeypatch.setattr(er, "check_due_expo_receipts", slow_check)
    dd._start_receipt_check()
    await asyncio.sleep(0)
    dd._start_receipt_check()  # the first is still running → no second pass
    await asyncio.sleep(0)
    assert len(started) == 1
    release.set()
    await dd._receipt_task
    dd._start_receipt_check()  # done → a new pass may start
    await asyncio.sleep(0)
    assert len(started) == 2
    release.set()
    await dd._receipt_task


@pytest.mark.anyio
async def test_a_hung_redis_does_not_hold_up_sending(monkeypatch):
    """PO 17:27Z ② — recording runs on the send path; a Redis that stops answering is skipped within the bound."""
    from ee.services import expo_push

    class HungPipeline:
        def hset(self, *a, **k): ...
        def expire(self, *a, **k): ...
        def zadd(self, *a, **k): ...

        async def execute(self):
            await asyncio.Event().wait()  # never answers

    class HungRedis:
        def pipeline(self, **_k):
            return HungPipeline()

    monkeypatch.setattr(er, "_redis", lambda: HungRedis())
    monkeypatch.setattr(er, "RECORD_TIMEOUT_SECONDS", 0.2)

    async def fake_send(_chunk):
        return [{"status": "ok", "id": "tk-ok"}]

    monkeypatch.setattr(expo_push, "_expo_send_chunk", fake_send)
    devices = [{"expo_push_token": "ExponentPushToken[a]", "id": uuid.uuid4(), "platform": "ios"}]
    dead = await asyncio.wait_for(
        expo_push._send_expo_push_targets(devices, title="t", body="b", event_type="e", org_id=ORG), timeout=5,
    )
    assert dead == []


def test_the_redis_client_gives_up_on_a_silent_server(monkeypatch):
    import redis.asyncio as aioredis

    from app.core.config import settings

    captured: dict = {}
    monkeypatch.setattr(aioredis, "from_url", lambda url, **kw: captured.update(kw) or object())
    monkeypatch.setattr(settings, "redis_url", "redis://example.invalid:6379/0")
    monkeypatch.setattr(er, "_client", None)
    er._redis()
    assert captured["socket_connect_timeout"] == er.REDIS_SOCKET_TIMEOUT_SECONDS
    assert captured["socket_timeout"] == er.REDIS_SOCKET_TIMEOUT_SECONDS
