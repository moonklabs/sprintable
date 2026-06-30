"""L2-S5: L2 트리거 워커 루프 단위 테스트.

AC① default-off·AC② cursor 성공 후만 전진(실패 시 미전진)·AC③ advisory lock holder만 동작.
백오프 리셋/성장·graceful shutdown·deadline scan evaluator 통합.
"""
from __future__ import annotations

import asyncio
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.config import settings
from app.services.l1_activity_source import ActivitySignal
from app.services.l2_heuristics import TriggerDecision
from app.services.l2_trigger_worker import L2TriggerWorker

# 실 Postgres가 있을 때만 도는 동시성 테스트(CI alembic-fresh-db가 0117 적용). 로컬은 temp PG로 실증.
_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


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

def _rows_result(rows):
    res = MagicMock()
    res.mappings.return_value.all.return_value = rows
    return res


@pytest.mark.anyio
async def test_collect_hypothesis_deadlines_pairs_org():
    w = L2TriggerWorker(use_advisory_lock=False)
    agent, org, hyp_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    now = datetime.now(timezone.utc)
    rows = [
        {  # S27: 임박 + owner_member_id → 발사(wake 타깃=owner·dispatchable 정합).
            "id": hyp_id, "org_id": org, "measure_after": now + timedelta(hours=5),
            "status": "measuring", "owner_member_id": agent,
        },
        {  # target 없음 → evaluator skip(쿼리 WHERE owner IS NOT NULL 가 실DB선 제외).
            "id": uuid.uuid4(), "org_id": org, "measure_after": now + timedelta(hours=2),
            "status": "active", "owner_member_id": None,
        },
    ]
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_rows_result(rows))
    pairs = await w._collect_hypothesis_deadlines(db, now)
    assert len(pairs) == 1
    d, pair_org = pairs[0]
    assert d.anchor_type == "hypothesis" and d.anchor_id == hyp_id and d.target_agent_id == agent
    assert pair_org == org


@pytest.mark.anyio
async def test_collect_epic_deadlines_dispatchable_anchor():
    w = L2TriggerWorker(use_advisory_lock=False)
    assignee, org, epic_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    now = datetime.now(timezone.utc)
    rows = [{
        "id": epic_id, "org_id": org,
        "target_date": (now + timedelta(hours=10)).date(),  # 임박(epic 3d 윈도우 내).
        "status": "active", "assignee_id": assignee,
    }]
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_rows_result(rows))
    pairs = await w._collect_epic_deadlines(db, now)
    assert len(pairs) == 1
    d, pair_org = pairs[0]
    assert d.anchor_type == "epic" and d.anchor_id == epic_id and d.target_agent_id == assignee
    assert pair_org == org and d.anchor_type in ("epic", "story", "doc")  # dispatchable.


@pytest.mark.anyio
async def test_collect_sprint_deadlines_dispatchable_anchor():
    """ed904b9d AC③: sprint deadline → wake. sprint 은 assignee 컬럼 없음 → _fetch_entity 가 relay-owner 로
    target 해소(S27). dispatchable anchor 라 L2 firing 이 wake skip 안 됨."""
    w = L2TriggerWorker(use_advisory_lock=False)
    owner, org, sprint_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    now = datetime.now(timezone.utc)
    rows = [{
        "id": sprint_id, "org_id": org,
        # sprint 윈도우=deadline_sprint_end_h(24h). collect 가 end_date를 당일 23:59:59 로 combine 하므로
        # 오늘 날짜면 remaining ≤ 24h → 임박 발사(어느 시각이든 안정·non-flaky).
        "end_date": now.date(),
        "status": "active",
    }]
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_rows_result(rows))
    with patch(
        "app.services.agent_dispatch._fetch_entity", new_callable=AsyncMock,
        return_value=(owner, "Sprint", "status=active", uuid.uuid4()),
    ):
        pairs = await w._collect_sprint_deadlines(db, now)
    assert len(pairs) == 1
    d, pair_org = pairs[0]
    assert d.anchor_type == "sprint" and d.anchor_id == sprint_id and d.target_agent_id == owner
    assert pair_org == org


# ── S6: dedup 발사 ─────────────────────────────────────────────────────────────

def _decision(anchor_type="epic", seq=None):
    return TriggerDecision(
        trigger_type="deadline_approaching",
        target_agent_id=uuid.uuid4(),
        anchor_type=anchor_type,
        anchor_id=uuid.uuid4(),
        reason="마감 임박",
        source_activity_seq=seq,
    )


def test_dedup_key_time_vs_activity_bucket():
    d_time = _decision(seq=None)
    d_act = _decision(seq=77)
    k_time = L2TriggerWorker._dedup_key(d_time)
    k_act = L2TriggerWorker._dedup_key(d_act)
    assert L2TriggerWorker._dedup_key(d_time) == k_time  # 결정적(같은 결정·같은 날).
    assert k_act.endswith(":a77") and d_act.trigger_type in k_act
    assert k_time != k_act


@pytest.mark.anyio
async def test_fire_one_winner_dispatches_and_links_event():
    w = L2TriggerWorker(use_advisory_lock=False)
    d = _decision("epic")
    org = uuid.uuid4()
    db = AsyncMock()
    event_id = uuid.uuid4()
    resp = MagicMock(dispatched=True, event_id=event_id)
    delivery = {"org_id": org, "recipient_id": d.target_agent_id, "content": "x", "event_type": "dispatched"}
    with patch.object(w, "_claim_firing", AsyncMock(return_value=True)), \
         patch.object(w, "_link_event", AsyncMock()) as link, \
         patch("app.services.agent_dispatch.dispatch_entity_to_assignee",
               AsyncMock(return_value=(resp, delivery))) as disp, \
         patch("app.services.conversation_webhook.deliver_injected_event_webhook",
               AsyncMock()) as web:
        await w._fire_one(db, d, org)
    disp.assert_awaited_once()
    # dispatch는 anchor(entity_type, entity_id)로 호출·trigger_metadata 동봉.
    args, kwargs = disp.await_args
    assert args[2] == "epic" and args[3] == d.anchor_id
    assert kwargs["trigger_metadata"]["source"] == "l2_heuristic"
    link.assert_awaited_once()  # event_id 링크.
    web.assert_awaited_once()   # CC 릴레이.


@pytest.mark.anyio
async def test_fire_one_conflict_loser_skips_dispatch():
    w = L2TriggerWorker(use_advisory_lock=False)
    d = _decision("epic")
    db = AsyncMock()
    with patch.object(w, "_claim_firing", AsyncMock(return_value=False)), \
         patch("app.services.agent_dispatch.dispatch_entity_to_assignee", AsyncMock()) as disp:
        await w._fire_one(db, d, uuid.uuid4())
    disp.assert_not_awaited()  # AC②④: 패자는 dispatch 0.
    db.rollback.assert_awaited_once()


@pytest.mark.anyio
async def test_fire_one_non_dispatchable_records_firing_no_wake():
    w = L2TriggerWorker(use_advisory_lock=False)
    # S27: matrix 5종(story/hyp/doc/epic/sprint) 전부 dispatch_capable=True 가 됐으므로 비-dispatchable
    # 검사는 matrix 미등록 타입으로(firing 기록되나 _DISPATCHABLE_ANCHORS 밖이라 wake skip).
    d = _decision("task")  # 비-matrix anchor.
    db = AsyncMock()
    with patch.object(w, "_claim_firing", AsyncMock(return_value=True)), \
         patch("app.services.agent_dispatch.dispatch_entity_to_assignee", AsyncMock()) as disp:
        await w._fire_one(db, d, uuid.uuid4())
    disp.assert_not_awaited()  # firing은 기록되나 wake skip.
    db.commit.assert_awaited_once()


@pytest.mark.anyio
async def test_dispatch_decisions_isolates_per_decision_failure():
    w = L2TriggerWorker(use_advisory_lock=False)
    good, bad = _decision("epic"), _decision("epic")
    org = uuid.uuid4()
    db = AsyncMock()
    calls = []

    async def fire(_db, decision, _org):
        calls.append(decision)
        if decision is bad:
            raise RuntimeError("boom")

    with patch.object(w, "_fire_one", side_effect=fire):
        await w._dispatch_decisions(db, [(bad, org), (good, org)])
    assert bad in calls and good in calls  # 한 결정 실패가 배치를 막지 않음.
    db.rollback.assert_awaited()  # 실패 결정은 rollback 후 계속.


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


# ── AC①: 멀티인스턴스 동시성 — 동일 dedup_key 2 워커 동시 INSERT → firing 1개만 ──────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
def test_concurrent_dedup_exactly_one_winner():
    """동일 dedup_key를 두 커넥션이 동시에 INSERT ON CONFLICT DO NOTHING RETURNING.

    두 워커가 같은 트리거 후보를 동시에 발사해도 unique(dedup_key)가 정확히 1행만 허용 —
    패자는 RETURNING 0행이라 dispatch를 호출하지 않는다(정확히 1 wake).
    """
    import psycopg2

    sync_url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql://").replace(
        "postgresql+asyncpg://", "postgresql://"
    )
    dedup_key = f"concurrency-test-{uuid.uuid4()}"
    org = str(uuid.uuid4())
    insert = (
        "INSERT INTO l2_trigger_firings "
        "(id, org_id, trigger_type, target_agent_id, anchor_type, anchor_id, dedup_key) "
        "VALUES (gen_random_uuid(), %(org)s, 'deadline_approaching', gen_random_uuid(), "
        "'epic', gen_random_uuid(), %(dk)s) ON CONFLICT (dedup_key) DO NOTHING RETURNING id"
    )
    barrier = threading.Barrier(2)
    won: list[bool] = []
    lock = threading.Lock()

    def race():
        conn = psycopg2.connect(sync_url)
        try:
            cur = conn.cursor()
            barrier.wait(timeout=10)  # 두 스레드 동시 시작.
            cur.execute(insert, {"org": org, "dk": dedup_key})
            row = cur.fetchone()
            conn.commit()
            with lock:
                won.append(row is not None)
        finally:
            conn.close()

    threads = [threading.Thread(target=race) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=15)

    try:
        assert sum(won) == 1, f"정확히 1 승자여야 함(got {sum(won)})"
        # 실제로도 firing 1행만 존재.
        conn = psycopg2.connect(sync_url)
        cur = conn.cursor()
        cur.execute("SELECT count(*) FROM l2_trigger_firings WHERE dedup_key = %s", (dedup_key,))
        assert cur.fetchone()[0] == 1
        conn.close()
    finally:
        conn = psycopg2.connect(sync_url)
        cur = conn.cursor()
        cur.execute("DELETE FROM l2_trigger_firings WHERE dedup_key = %s", (dedup_key,))
        conn.commit()
        conn.close()
