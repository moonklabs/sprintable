"""#2158: sse_transient_replay (B계열 재연결 갭 재생 버퍼) 단위 테스트.

flag off/Redis 다운 = no-op·빈 리스트(fail-open, 기존 유실 동작과 동일) · fakeredis 왕복
(TTL/cap/커서 배타 하한/동일-payload dedup 방지 nonce).
"""
from __future__ import annotations

import time
from unittest.mock import patch

import pytest

from app.services import sse_transient_replay


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def _flag_off():
    with patch.object(sse_transient_replay.settings, "sse_transient_replay_enabled", False):
        yield


@pytest.fixture
def _flag_on_fakeredis():
    aioredis = pytest.importorskip("fakeredis.aioredis")
    server = aioredis.FakeServer()
    client = aioredis.FakeRedis(server=server, decode_responses=True)
    with patch.object(sse_transient_replay.settings, "sse_transient_replay_enabled", True), \
         patch.object(sse_transient_replay.settings, "redis_url", "redis://fake"), \
         patch("app.services.redis_shared.get_client", return_value=client):
        yield client


# ── flag off / Redis 다운 = no-op·빈 리스트(fail-open) ─────────────────────────
@pytest.mark.anyio
async def test_flag_off_record_is_noop(_flag_off):
    await sse_transient_replay.record("m1", {"event_type": "conversation.read"})  # 예외 0


@pytest.mark.anyio
async def test_flag_off_replay_returns_empty(_flag_off):
    assert await sse_transient_replay.replay("m1", since=None) == []


@pytest.mark.anyio
async def test_redis_down_failopen():
    with patch.object(sse_transient_replay.settings, "sse_transient_replay_enabled", True), \
         patch.object(sse_transient_replay.settings, "redis_url", "redis://x"), \
         patch("app.services.redis_shared.get_client", return_value=None):
        await sse_transient_replay.record("m1", {"event_type": "presence"})  # no-op·예외 0
        assert await sse_transient_replay.replay("m1", since=None) == []


# ── fakeredis 왕복 ──────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_record_then_replay_since_none_returns_all_within_ttl(_flag_on_fakeredis):
    await sse_transient_replay.record("m1", {"event_type": "conversation.read", "unread_count": 3})
    out = await sse_transient_replay.replay("m1", since=None)
    assert len(out) == 1
    assert out[0]["event_type"] == "conversation.read"
    assert out[0]["unread_count"] == 3
    assert "_n" not in out[0]  # nonce는 재생 시 제거


@pytest.mark.anyio
async def test_replay_scoped_per_member(_flag_on_fakeredis):
    await sse_transient_replay.record("m1", {"event_type": "presence"})
    await sse_transient_replay.record("m2", {"event_type": "presence"})
    assert len(await sse_transient_replay.replay("m1", since=None)) == 1
    assert len(await sse_transient_replay.replay("m2", since=None)) == 1


@pytest.mark.anyio
async def test_replay_cutoff_is_exclusive(_flag_on_fakeredis):
    """since=그 이벤트 자신의 score면 재생 안 함(이미 받은 것으로 간주되는 커서 재중복 방지)."""
    client = _flag_on_fakeredis
    key = sse_transient_replay._key("m1")
    await client.zadd(key, {'{"_n": "a", "event_type": "presence"}': 100.0})
    assert await sse_transient_replay.replay("m1", since=100.0) == []
    assert len(await sse_transient_replay.replay("m1", since=99.999)) == 1


@pytest.mark.anyio
async def test_identical_payloads_do_not_collapse_via_nonce(_flag_on_fakeredis):
    """동일 payload(예: 연속 conversation.read 동일 unread_count)가 ZSET member 충돌로
    한 건으로 합쳐지지 않는다 — nonce가 문자열을 매번 유일하게 만든다."""
    payload = {"event_type": "conversation.read", "unread_count": 0}
    await sse_transient_replay.record("m1", payload)
    await sse_transient_replay.record("m1", payload)
    out = await sse_transient_replay.replay("m1", since=None)
    assert len(out) == 2


@pytest.mark.anyio
async def test_max_entries_cap_trims_oldest(_flag_on_fakeredis):
    with patch.object(sse_transient_replay, "_MAX_ENTRIES", 3):
        for i in range(5):
            await sse_transient_replay.record("m1", {"event_type": "presence", "i": i})
        out = await sse_transient_replay.replay("m1", since=None)
        assert len(out) == 3
        # 최신 3건(i=2,3,4)만 남는다(오래된 것부터 제거)
        assert sorted(o["i"] for o in out) == [2, 3, 4]


@pytest.mark.anyio
async def test_cap_trim_is_observable_via_log(_flag_on_fakeredis, caplog):
    """오르테가군 PR 전 리뷰 ②: cap이 실제로 뭔가를 버리면 로그로 남아야 라이브에서
    '넘치는지 모르는 채로 버리는' 상태를 벗어난다. 안 넘치면 로그가 안 남는 것도 유효한 근거."""
    import logging

    with patch.object(sse_transient_replay, "_MAX_ENTRIES", 2), \
         caplog.at_level(logging.INFO, logger="app.services.sse_transient_replay"):
        for i in range(4):
            await sse_transient_replay.record("m1", {"event_type": "presence", "i": i})
        trim_logs = [r for r in caplog.records if "trim" in r.message]
        assert len(trim_logs) >= 1
        assert "m1" in trim_logs[0].message


@pytest.mark.anyio
async def test_no_trim_log_when_under_cap(_flag_on_fakeredis, caplog):
    import logging

    with caplog.at_level(logging.INFO, logger="app.services.sse_transient_replay"):
        await sse_transient_replay.record("m1", {"event_type": "presence"})
        assert not any("trim" in r.message for r in caplog.records)


@pytest.mark.anyio
async def test_ttl_set_on_key(_flag_on_fakeredis):
    client = _flag_on_fakeredis
    await sse_transient_replay.record("m1", {"event_type": "presence"})
    ttl = await client.ttl(sse_transient_replay._key("m1"))
    assert 0 < ttl <= sse_transient_replay.TTL_SECONDS


@pytest.mark.anyio
async def test_replay_ordered_by_time(_flag_on_fakeredis):
    client = _flag_on_fakeredis
    key = sse_transient_replay._key("m1")
    now = time.time()
    await client.zadd(key, {
        '{"_n": "a", "event_type": "presence", "seq": 2}': now,
        '{"_n": "b", "event_type": "presence", "seq": 1}': now - 1,
    })
    out = await sse_transient_replay.replay("m1", since=now - 10)
    assert [o["seq"] for o in out] == [1, 2]


# ── 가드(silent-skip 문 닫기·#2121 교훈) ───────────────────────────────────────
def test_fakeredis_available():
    import fakeredis  # noqa: F401


def test_ttl_default_covers_reconnect_backoff_ceiling():
    """#2408 재연결 backoff 상한(20s)+jitter(최대 24s)를 한 사이클 여유 있게 넘겨야 한다."""
    assert sse_transient_replay.TTL_SECONDS > 24
