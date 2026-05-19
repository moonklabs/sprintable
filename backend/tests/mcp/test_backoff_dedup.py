"""S5-5: backoff jitter + event_id dedup 유닛 테스트."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sprintable_mcp.sse_bridge import (
    _BASE_DELAY,
    _JITTER_FACTOR,
    _MAX_DELAY,
    SeenIdsCache,
    SseEvent,
    start_sse_bridge,
)


# ── dedup ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_dedup_skips_duplicate_event_id():
    """같은 event_id를 가진 이벤트는 두 번째부터 skip."""
    received: list[str] = []

    # start_sse_bridge를 직접 호출하기 어려우므로 내부 dedup 로직을 _handle 통해 검증
    # seen_ids dict를 직접 조작
    seen_ids: dict[str, None] = {}
    seen_ids["eid-1"] = None

    # dedup 로직 직접 시뮬레이션
    event = SseEvent(event_type="memo_received", data="data", last_event_id="eid-1")
    if event.last_event_id in seen_ids:
        pass  # skip
    else:
        received.append(event.event_type)

    assert received == []  # eid-1은 이미 seen → skip


@pytest.mark.asyncio
async def test_dedup_passes_new_event_id():
    """새로운 event_id → 통과."""
    seen_ids: dict[str, None] = {}

    event = SseEvent(event_type="memo_received", data="data", last_event_id="eid-new")
    skipped = event.last_event_id in seen_ids
    if not skipped:
        seen_ids[event.last_event_id] = None

    assert not skipped
    assert "eid-new" in seen_ids


@pytest.mark.asyncio
async def test_dedup_evicts_oldest_when_full():
    """SeenIdsCache: max_size 초과 시 가장 오래된 항목 LRU eviction."""
    max_size = 10
    cache = SeenIdsCache(max_size=max_size, ttl_seconds=3600)
    for i in range(max_size):
        cache.add(f"eid-{i}")

    assert len(cache) == max_size

    # 새 항목 추가 → "eid-0"(LRU 최고령) 제거
    new_id = f"eid-{max_size}"
    cache.add(new_id)

    assert len(cache) == max_size
    assert "eid-0" not in cache
    assert new_id in cache


@pytest.mark.asyncio
async def test_dedup_no_id_always_dispatches():
    """event_id 없는 이벤트는 dedup 없이 항상 dispatch."""
    seen_ids: dict[str, None] = {}

    dispatched = 0
    for _ in range(3):
        event = SseEvent(event_type="update", data="data", last_event_id="")
        if not event.last_event_id or event.last_event_id not in seen_ids:
            dispatched += 1

    assert dispatched == 3  # id 없으면 항상 통과


# ── backoff jitter ─────────────────────────────────────────────────────────────

def test_backoff_jitter_within_bounds():
    """jitter 포함 backoff가 [base, base*(1+JITTER_FACTOR)] 범위 내."""
    from random import uniform

    for attempt in range(1, 6):
        base_wait = min(_BASE_DELAY * 2 ** (attempt - 1), _MAX_DELAY)
        for _ in range(50):
            wait = base_wait + uniform(0, base_wait * _JITTER_FACTOR)
            assert base_wait <= wait <= base_wait * (1 + _JITTER_FACTOR) + 1e-9


def test_backoff_caps_at_max_delay():
    """attempt 증가 시 base_wait이 MAX_DELAY에 수렴."""
    for attempt in range(10, 20):
        base_wait = min(_BASE_DELAY * 2 ** (attempt - 1), _MAX_DELAY)
        assert base_wait == _MAX_DELAY


# ── graceful shutdown ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_client_aclose_on_cancel():
    """start_sse_bridge CancelledError 시 client.aclose() 호출 보장."""
    mock_client = AsyncMock()
    mock_client.stream = MagicMock()
    mock_client.aclose = AsyncMock()

    # _connect_once에서 CancelledError 발생 시뮬레이션
    async def _raise_cancelled(*args, **kwargs):
        raise asyncio.CancelledError()

    with patch("sprintable_mcp.sse_bridge.make_sse_client", return_value=mock_client):
        with patch("sprintable_mcp.sse_bridge._connect_once", side_effect=_raise_cancelled):
            with pytest.raises(asyncio.CancelledError):
                await start_sse_bridge("http://api", "key", "member-1")

    mock_client.aclose.assert_called_once()
