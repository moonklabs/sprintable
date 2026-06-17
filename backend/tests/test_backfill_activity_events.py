"""L1 BE-4: backfill job 테스트.

cursor 페이지네이션·배치·skip 집계·idempotent 호출 패턴을 mock으로 검증한다. 실제 upsert
SQL(array union·dedup)은 BE-2 real-DB 테스트가 커버한다.
"""
from __future__ import annotations

import contextlib
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services import activity_stream as svc

TS = datetime(2026, 6, 11, 12, 0, 0, tzinfo=timezone.utc)


def _scan_db(batches: list[list]):
    """db.execute가 SELECT scan을 호출할 때마다 다음 배치를 반환하는 stub."""
    state = {"i": 0}

    async def _execute(_stmt):
        res = MagicMock()
        rows = batches[state["i"]] if state["i"] < len(batches) else []
        state["i"] += 1
        res.all.return_value = rows
        return res

    db = AsyncMock()
    db.execute = _execute

    @contextlib.asynccontextmanager
    async def _savepoint():
        yield

    db.begin_nested = lambda: _savepoint()
    return db


@pytest.mark.anyio
async def test_backfill_paginates_and_counts(monkeypatch):
    b1 = [(uuid.uuid4(), TS) for _ in range(3)]
    b2 = [(uuid.uuid4(), TS) for _ in range(2)]
    db = _scan_db([b1, b2, []])

    async def _upsert(_db, ids):
        return [uuid.uuid4() for _ in ids]

    monkeypatch.setattr(svc, "upsert_activity_from_events", _upsert)

    result = await svc.backfill_activity_events(db, batch_size=3)
    assert result == {"events_processed": 5, "events_skipped": 0, "batches": 2}


@pytest.mark.anyio
async def test_backfill_empty(monkeypatch):
    db = _scan_db([[]])
    monkeypatch.setattr(svc, "upsert_activity_from_events", AsyncMock(return_value=[]))
    result = await svc.backfill_activity_events(db)
    assert result == {"events_processed": 0, "events_skipped": 0, "batches": 0}


@pytest.mark.anyio
async def test_backfill_skips_failing_event_via_per_event_fallback(monkeypatch):
    bad = uuid.uuid4()
    b1 = [(uuid.uuid4(), TS), (bad, TS), (uuid.uuid4(), TS)]
    db = _scan_db([b1, []])

    async def _upsert(_db, ids):
        # 배치 일괄(>1)은 실패 → per-event fallback 유도. fallback에서 bad만 실패.
        if len(ids) > 1:
            raise RuntimeError("batch failed")
        if ids[0] == bad:
            raise RuntimeError("bad event")
        return [uuid.uuid4()]

    monkeypatch.setattr(svc, "upsert_activity_from_events", _upsert)

    result = await svc.backfill_activity_events(db, batch_size=3)
    assert result == {"events_processed": 3, "events_skipped": 1, "batches": 1}
    db.rollback.assert_awaited()  # 배치 실패 시 rollback 후 fallback
