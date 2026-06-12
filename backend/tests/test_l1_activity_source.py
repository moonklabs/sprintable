"""L2-S3: L1ActivitySource 어댑터 단위 테스트.

AC① normalize·AC② disabled graceful·AC③ activity_seq ASC 보장.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.services import l1_activity_source as mod
from app.services.l1_activity_source import ActivitySignal, L1ActivitySource


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _row(seq: int, **over):
    base = dict(
        activity_seq=seq,
        activity_id=uuid.uuid4(),
        org_id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        verb="dispatched",
        occurred_at=datetime(2026, 6, 12, tzinfo=timezone.utc),
        actor_id=uuid.uuid4(),
        object_type="story",
        object_id=uuid.uuid4(),
        dedup_key=f"dk-{seq}",
        payload={"k": "v"},
        recipient_ids=[uuid.uuid4()],
        recipient_types=["agent"],
        representative_event_id=uuid.uuid4(),
        source_event_ids=[uuid.uuid4(), uuid.uuid4()],
    )
    base.update(over)
    return SimpleNamespace(**base)


# ── AC①: normalize ─────────────────────────────────────────────────────────────

def test_from_activity_normalizes_all_fields():
    row = _row(7)
    sig = ActivitySignal.from_activity(row)
    assert sig.activity_seq == 7
    assert sig.activity_id == row.activity_id
    assert sig.org_id == row.org_id and sig.project_id == row.project_id
    assert sig.verb == "dispatched" and sig.object_type == "story"
    assert sig.payload == {"k": "v"}
    # frozen dataclass — 컬렉션은 복사(tuple/dict)되어 원본과 격리.
    assert isinstance(sig.recipient_ids, tuple) and isinstance(sig.source_event_ids, tuple)
    assert sig.payload is not row.payload


def test_from_activity_handles_null_collections():
    row = _row(1, payload=None, recipient_ids=None, recipient_types=None, source_event_ids=None)
    sig = ActivitySignal.from_activity(row)
    assert sig.payload == {} and sig.recipient_ids == () and sig.source_event_ids == ()


def test_signal_is_frozen():
    sig = ActivitySignal.from_activity(_row(1))
    with pytest.raises(Exception):
        sig.activity_seq = 99  # type: ignore[misc]


# ── AC③: poll ASC + normalize + cursor passthrough ─────────────────────────────

@pytest.mark.anyio
async def test_poll_returns_sorted_signals_and_cursor():
    # helper가 (방어 시나리오상) 뒤섞여 와도 어댑터는 activity_seq ASC를 보장.
    unsorted = [_row(5), _row(2), _row(9)]
    with patch.object(mod, "_poll_activities_after_seq", new=AsyncMock(return_value=(unsorted, 9))):
        src = L1ActivitySource()
        signals, nxt = await src.poll_after_seq(AsyncMock(), after_seq=1, limit=3, org_id=None)
    assert [s.activity_seq for s in signals] == [2, 5, 9]  # ASC
    assert all(isinstance(s, ActivitySignal) for s in signals)
    assert nxt == 9


@pytest.mark.anyio
async def test_poll_passes_org_and_limit_to_helper():
    org = uuid.uuid4()
    spy = AsyncMock(return_value=([], None))
    with patch.object(mod, "_poll_activities_after_seq", new=spy):
        await L1ActivitySource().poll_after_seq(AsyncMock(), after_seq=10, limit=50, org_id=org)
    _, kwargs = spy.call_args
    assert kwargs["limit"] == 50 and kwargs["org_id"] == org


# ── latest_for_object ──────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_latest_for_object_normalizes_and_none_passthrough():
    row = _row(3)
    with patch.object(mod, "_latest_activity_for_object", new=AsyncMock(return_value=row)):
        sig = await L1ActivitySource().latest_for_object(AsyncMock(), row.org_id, "story", row.object_id)
    assert isinstance(sig, ActivitySignal) and sig.activity_seq == 3

    with patch.object(mod, "_latest_activity_for_object", new=AsyncMock(return_value=None)):
        assert await L1ActivitySource().latest_for_object(AsyncMock(), uuid.uuid4(), "story", uuid.uuid4()) is None


# ── AC②: disabled graceful (import 실패 시 crash 0·무동작) ──────────────────────

@pytest.mark.anyio
async def test_disabled_source_is_inert_and_skips_helpers():
    poll_spy = AsyncMock(return_value=([_row(1)], 1))
    latest_spy = AsyncMock(return_value=_row(1))
    with patch.object(mod, "_L1_AVAILABLE", False), \
         patch.object(mod, "_poll_activities_after_seq", new=poll_spy), \
         patch.object(mod, "_latest_activity_for_object", new=latest_spy):
        src = L1ActivitySource()  # 생성만으로 crash 없음(AC②)
        assert src.enabled is False
        assert await src.poll_after_seq(AsyncMock(), 0) == ([], None)
        assert await src.latest_for_object(AsyncMock(), uuid.uuid4(), "story", uuid.uuid4()) is None
    poll_spy.assert_not_awaited()
    latest_spy.assert_not_awaited()
