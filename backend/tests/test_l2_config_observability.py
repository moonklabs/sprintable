"""L2-S8: 운영 config + 관측성 단위 테스트.

AC① trigger type disable·AC② org allowlist·AC③ metrics·AC④ firing payload features snapshot·
AC⑤ org 시간당 wake rate limit. DB변경 0(0117 firings 사용).
"""
from __future__ import annotations

import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.config import settings
from app.services.l2_heuristics import TriggerDecision
from app.services.l2_trigger_worker import L2TriggerWorker, _csv_set, _uuid_set


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _decision(trigger_type="status_changed", anchor_type="epic"):
    return TriggerDecision(
        trigger_type=trigger_type,
        target_agent_id=uuid.uuid4(),
        anchor_type=anchor_type,
        anchor_id=uuid.uuid4(),
        reason="r",
        source_activity_seq=7,
    )


def _worker(**kw):
    return L2TriggerWorker(use_advisory_lock=False, **kw)


# ── 기본값 안전(전부 무제약) ────────────────────────────────────────────────────

def test_config_defaults_unconstrained():
    assert settings.l2_trigger_disabled_types == ""
    assert settings.l2_trigger_org_allowlist == ""
    assert settings.l2_trigger_max_wakes_per_org_per_hour == 0
    w = _worker()
    assert w._disabled_types == frozenset() and w._org_allowlist == frozenset()
    assert w._max_wakes_per_hour == 0
    assert all(v == 0 for v in w.metrics.values())


def test_csv_and_uuid_parsers():
    assert _csv_set(" a, b ,,c ") == frozenset({"a", "b", "c"})
    u = uuid.uuid4()
    assert _uuid_set(f"{u}, not-a-uuid, ") == frozenset({u})  # 무효 무시.


# ── AC①: trigger type disable ──────────────────────────────────────────────────

@pytest.mark.anyio
async def test_disabled_trigger_type_skips_before_claim():
    w = _worker(disabled_types={"velocity_spike"})
    db = AsyncMock()
    with patch.object(w, "_claim_firing", AsyncMock()) as claim:
        await w._fire_one(db, _decision("velocity_spike"), uuid.uuid4())
    claim.assert_not_awaited()  # 게이트가 claim 이전에 차단.
    assert w.metrics["skipped_disabled"] == 1


@pytest.mark.anyio
async def test_enabled_type_passes_gate():
    w = _worker(disabled_types={"velocity_spike"})
    db = AsyncMock()
    with patch.object(w, "_claim_firing", AsyncMock(return_value=False)) as claim:
        await w._fire_one(db, _decision("deadline_approaching"), uuid.uuid4())
    claim.assert_awaited_once()  # 다른 타입은 통과.


# ── AC②: org allowlist ─────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_org_not_in_allowlist_skips():
    allowed = uuid.uuid4()
    w = _worker(org_allowlist={allowed})
    db = AsyncMock()
    with patch.object(w, "_claim_firing", AsyncMock()) as claim:
        await w._fire_one(db, _decision(), uuid.uuid4())  # 다른 org.
    claim.assert_not_awaited()
    assert w.metrics["skipped_allowlist"] == 1


@pytest.mark.anyio
async def test_org_in_allowlist_passes():
    allowed = uuid.uuid4()
    w = _worker(org_allowlist={allowed})
    db = AsyncMock()
    with patch.object(w, "_claim_firing", AsyncMock(return_value=False)) as claim:
        await w._fire_one(db, _decision(), allowed)
    claim.assert_awaited_once()


# ── AC⑤: org 시간당 wake rate limit ────────────────────────────────────────────

@pytest.mark.anyio
async def test_rate_limit_blocks_when_over_cap():
    w = _worker(max_wakes_per_hour=3)
    db = AsyncMock()
    with patch.object(w, "_org_hourly_wake_count", AsyncMock(return_value=3)), \
         patch.object(w, "_claim_firing", AsyncMock()) as claim:
        await w._fire_one(db, _decision(), uuid.uuid4())
    claim.assert_not_awaited()  # cap 도달 → claim 이전 skip.
    assert w.metrics["skipped_rate_limited"] == 1


@pytest.mark.anyio
async def test_rate_limit_allows_under_cap():
    w = _worker(max_wakes_per_hour=3)
    db = AsyncMock()
    with patch.object(w, "_org_hourly_wake_count", AsyncMock(return_value=2)), \
         patch.object(w, "_claim_firing", AsyncMock(return_value=False)) as claim:
        await w._fire_one(db, _decision(), uuid.uuid4())
    claim.assert_awaited_once()


@pytest.mark.anyio
async def test_rate_limit_disabled_skips_count_query():
    w = _worker(max_wakes_per_hour=0)  # 0=무제한.
    db = AsyncMock()
    with patch.object(w, "_org_hourly_wake_count", AsyncMock()) as cnt, \
         patch.object(w, "_claim_firing", AsyncMock(return_value=False)):
        await w._fire_one(db, _decision(), uuid.uuid4())
    cnt.assert_not_awaited()  # 0이면 카운트 쿼리 자체 skip.


@pytest.mark.anyio
async def test_org_hourly_wake_count_query():
    w = _worker()
    db = AsyncMock()
    res = MagicMock()
    res.scalar.return_value = 5
    db.execute = AsyncMock(return_value=res)
    n = await w._org_hourly_wake_count(db, uuid.uuid4())
    assert n == 5
    sql = str(db.execute.await_args.args[0])
    assert "count(*)" in sql and "1 hour" in sql and "l2_trigger_firings" in sql


# ── AC④: firing payload features snapshot ──────────────────────────────────────

@pytest.mark.anyio
async def test_claim_firing_payload_has_reason_and_features():
    w = _worker()
    d = _decision("deadline_approaching", "epic")
    db = AsyncMock()
    res = MagicMock()
    res.first.return_value = ("id",)
    db.execute = AsyncMock(return_value=res)
    won = await w._claim_firing(db, d, uuid.uuid4(), "dk1")
    assert won is True
    params = db.execute.await_args.args[1]
    payload = json.loads(params["payload"])
    assert payload["reason"] == "r" and payload["source"] == "l2_heuristic"
    feat = payload["features"]
    assert feat["trigger_type"] == "deadline_approaching"
    assert feat["anchor_type"] == "epic" and feat["anchor_id"] == str(d.anchor_id)
    assert feat["target_agent_id"] == str(d.target_agent_id)
    assert feat["source_activity_seq"] == 7 and "evaluated_at" in feat


# ── AC③: metrics 카운터 + 요약 로깅 ────────────────────────────────────────────

@pytest.mark.anyio
async def test_fired_metric_increments_on_dispatch():
    w = _worker()
    d = _decision("status_changed", "epic")
    db = AsyncMock()
    resp = MagicMock(dispatched=True, event_id=uuid.uuid4())
    with patch.object(w, "_claim_firing", AsyncMock(return_value=True)), \
         patch.object(w, "_link_event", AsyncMock()), \
         patch("app.services.agent_dispatch.dispatch_entity_to_assignee",
               AsyncMock(return_value=(resp, None))):
        await w._fire_one(db, d, uuid.uuid4())
    assert w.metrics["fired"] == 1


@pytest.mark.anyio
async def test_duplicate_metric_increments_on_conflict():
    w = _worker()
    db = AsyncMock()
    with patch.object(w, "_claim_firing", AsyncMock(return_value=False)):
        await w._fire_one(db, _decision(), uuid.uuid4())
    assert w.metrics["skipped_duplicate"] == 1
    db.rollback.assert_awaited_once()


def test_log_metrics_emits_summary(caplog):
    import logging

    w = _worker()
    w.metrics["fired"] = 2
    w.metrics["skipped_duplicate"] = 1
    with caplog.at_level(logging.INFO):
        w._log_metrics()
    assert any("L2 metrics" in r.message and "fired=2" in r.message for r in caplog.records)
