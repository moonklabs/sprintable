"""L2-S5: L2 트리거 워커 루프 단위 테스트.

AC① default-off·AC② cursor 성공 후만 전진(실패 시 미전진)·AC③ advisory lock holder만 동작.
백오프 리셋/성장·graceful shutdown·deadline scan evaluator 통합.
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.config import settings
from app.services.l1_activity_source import ActivitySignal
from app.services.l2_trigger_worker import L2TriggerWorker


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _sig(seq: int) -> ActivitySignal:
    return ActivitySignal(
        activity_seq=seq,
        activity_id=uuid.uuid4(),
        org_id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        verb="dispatched",
        occurred_at=datetime(2026, 6, 12, tzinfo=timezone.utc),
    )


# ── AC①: default-off ─────────────────────────────────────────────────────────

def test_l2_trigger_disabled_by_default():
    assert settings.l2_trigger_enabled is False
    assert settings.l2_trigger_advisory_lock is False


# ── AC②: cursor 성공 후만 전진 ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_poll_advances_cursor_on_success():
    w = L2TriggerWorker(use_advisory_lock=False)
    db = AsyncMock()
    with patch.object(w, "_read_cursor", AsyncMock(return_value=10)), \
         patch.object(w.source, "poll_after_seq", AsyncMock(return_value=([_sig(11), _sig(15)], None))), \
         patch.object(w, "_evaluate_signals", AsyncMock(return_value=[])), \
         patch.object(w, "_write_cursor", AsyncMock()) as wc:
        await w._poll_once(db)
    wc.assert_awaited_once()
    assert wc.await_args.args[1] == 15  # 마지막 처리 seq로 전진.


@pytest.mark.anyio
async def test_poll_does_not_advance_cursor_when_processing_fails():
    w = L2TriggerWorker(use_advisory_lock=False)
    db = AsyncMock()
    with patch.object(w, "_read_cursor", AsyncMock(return_value=10)), \
         patch.object(w.source, "poll_after_seq", AsyncMock(return_value=([_sig(11)], None))), \
         patch.object(w, "_evaluate_signals", AsyncMock(side_effect=RuntimeError("boom"))), \
         patch.object(w, "_write_cursor", AsyncMock()) as wc:
        with pytest.raises(RuntimeError):
            await w._poll_once(db)
    wc.assert_not_awaited()  # 실패 시 cursor 미전진(AC②) → 다음 iter 재처리.


@pytest.mark.anyio
async def test_poll_empty_batch_no_cursor_write():
    w = L2TriggerWorker(use_advisory_lock=False)
    with patch.object(w, "_read_cursor", AsyncMock(return_value=99)), \
         patch.object(w.source, "poll_after_seq", AsyncMock(return_value=([], None))), \
         patch.object(w, "_write_cursor", AsyncMock()) as wc:
        out = await w._poll_once(AsyncMock())
    assert out == [] and not wc.await_count


@pytest.mark.anyio
async def test_write_cursor_inserts_when_no_row():
    w = L2TriggerWorker(use_advisory_lock=False)
    db = AsyncMock()
    update_res = MagicMock()
    update_res.rowcount = 0  # UPDATE가 0행 → INSERT 경로.
    db.execute = AsyncMock(return_value=update_res)
    await w._write_cursor(db, 42)
    assert db.execute.await_count == 2  # UPDATE 후 INSERT.
    db.commit.assert_awaited_once()


# ── AC③: advisory lock ────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_ensure_lock_disabled_always_true():
    w = L2TriggerWorker(use_advisory_lock=False)
    assert await w._ensure_lock() is True


@pytest.mark.anyio
async def test_ensure_lock_holder_true_standby_false():
    # holder: pg_try_advisory_lock → True.
    w = L2TriggerWorker(use_advisory_lock=True)
    conn = AsyncMock()
    lock_res = MagicMock()
    lock_res.scalar.return_value = True
    conn.execute = AsyncMock(return_value=lock_res)
    conn.execution_options = AsyncMock()
    with patch("app.core.database.engine") as eng:
        eng.connect = AsyncMock(return_value=conn)
        assert await w._ensure_lock() is True
        assert w._holds_lock is True
        # 이미 보유 시 재호출은 추가 lock 쿼리 없이 True.
        conn.execute.reset_mock()
        assert await w._ensure_lock() is True
        conn.execute.assert_not_awaited()

    # standby: 다른 인스턴스가 holder → False.
    w2 = L2TriggerWorker(use_advisory_lock=True)
    conn2 = AsyncMock()
    res2 = MagicMock()
    res2.scalar.return_value = False
    conn2.execute = AsyncMock(return_value=res2)
    conn2.execution_options = AsyncMock()
    with patch("app.core.database.engine") as eng2:
        eng2.connect = AsyncMock(return_value=conn2)
        assert await w2._ensure_lock() is False
        assert w2._holds_lock is False


@pytest.mark.anyio
async def test_release_lock_unlocks_and_closes():
    w = L2TriggerWorker(use_advisory_lock=True)
    conn = AsyncMock()
    w._lock_conn = conn
    w._holds_lock = True
    await w._release_lock()
    # pg_advisory_unlock 실행 + close.
    assert conn.execute.await_count == 1
    conn.close.assert_awaited_once()
    assert w._lock_conn is None and w._holds_lock is False


# ── deadline scan: evaluator 통합 ─────────────────────────────────────────────

@pytest.mark.anyio
async def test_scan_deadlines_fires_for_imminent_hypothesis():
    w = L2TriggerWorker(use_advisory_lock=False)
    agent = uuid.uuid4()
    hyp_id = uuid.uuid4()
    now = datetime.now(timezone.utc)
    rows = [
        {  # 임박(5h 후) + drafted_by 있음 → 발사.
            "id": hyp_id,
            "measure_after": now + timedelta(hours=5),
            "status": "measuring",
            "drafted_by_member_id": agent,
            "created_by_member_id": None,
        },
        {  # target 없음(drafted/created 둘 다 None) → evaluator skip.
            "id": uuid.uuid4(),
            "measure_after": now + timedelta(hours=2),
            "status": "active",
            "drafted_by_member_id": None,
            "created_by_member_id": None,
        },
    ]
    result = MagicMock()
    result.mappings.return_value.all.return_value = rows
    db = AsyncMock()
    db.execute = AsyncMock(return_value=result)
    with patch.object(w, "_dispatch_decisions") as disp:
        decisions = await w._scan_deadlines(db)
    assert len(decisions) == 1
    d = decisions[0]
    assert d.trigger_type == "deadline_approaching"
    assert d.anchor_type == "hypothesis" and d.anchor_id == hyp_id and d.target_agent_id == agent
    disp.assert_called_once()


# ── graceful shutdown ─────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_run_cancels_gracefully_and_releases_lock():
    w = L2TriggerWorker(use_advisory_lock=False, poll_interval_s=0.01)
    with patch.object(w, "_ensure_lock", AsyncMock(return_value=True)), \
         patch.object(w, "_poll_once", AsyncMock(return_value=[])), \
         patch.object(w, "_scan_deadlines", AsyncMock(return_value=[])), \
         patch.object(w, "_release_lock", AsyncMock()) as rel, \
         patch("app.core.database.async_session_factory") as sf:
        sf.return_value.__aenter__ = AsyncMock(return_value=AsyncMock())
        sf.return_value.__aexit__ = AsyncMock(return_value=False)
        task = asyncio.create_task(w.run())
        await asyncio.sleep(0.05)  # 몇 iteration 돌게.
        task.cancel()
        await task  # CancelledError를 run이 흡수 → 정상 종료.
    rel.assert_awaited_once()  # shutdown 시 lock 해제 보장.
