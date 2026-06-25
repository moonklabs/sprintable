"""OB-4b: funnel BE seam 3종(first_auth_seen·stream_connected·abandoned) 가드.

abandoned 파생(furthest 단계 reason·terminal 이중계상 금지)은 단위 검증. first_auth_seen(auth 핫패스)·
stream_connected(SSE 제너레이터 lifecycle)은 무거운 경로라 배선 회귀 가드(emit isolation·non-blocking).
"""
from __future__ import annotations

import inspect
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services import onboarding_funnel as f


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── abandoned 실패사유 도출(furthest 단계) ────────────────────────────────────

def test_derive_abandon_reason_by_furthest_stage():
    assert f._derive_abandon_reason({"config_generated"}) == "no_copy"
    assert f._derive_abandon_reason({"config_generated", "config_copied"}) == "no_auth"
    assert f._derive_abandon_reason({"config_copied", "first_auth_seen"}) == "stream_unreachable"
    assert f._derive_abandon_reason({"first_auth_seen", "stream_connected"}) == "verify_timeout"
    assert f._derive_abandon_reason({"stream_connected", "event_sent"}) == "no_ack"
    # 도출 사유는 전부 §4 taxonomy 안
    for ev in (
        {"config_generated"}, {"config_copied"}, {"first_auth_seen"},
        {"stream_connected"}, {"event_sent"}, {"ack_received"},
    ):
        assert f._derive_abandon_reason(ev) in f.FAILURE_REASONS


# ─── abandoned sweep(terminal dedup·이중계상 금지) ────────────────────────────

def _scalars(vals):
    r = MagicMock()
    r.scalars.return_value.all.return_value = vals
    return r


def _first(val):
    r = MagicMock()
    r.first.return_value = val
    return r


@pytest.mark.anyio
async def test_sweep_emits_abandoned_for_stalled_agent():
    """config_generated 후 미verified·미abandoned → abandoned 1건(furthest reason)."""
    agent = uuid.uuid4()
    db = AsyncMock()
    db.add = MagicMock()
    db.flush = AsyncMock()
    db.commit = AsyncMock()
    db.execute = AsyncMock(side_effect=[
        _scalars([agent]),                                  # candidates
        _first(None),                                       # terminal? 아니오
        _scalars(["config_generated", "first_auth_seen"]),  # 도달 이벤트
    ])
    n = await f.sweep_abandoned_onboarding(db)
    assert n == 1
    row = db.add.call_args[0][0]
    assert row.event == "abandoned" and row.agent_id == agent
    assert row.failure_reason == "stream_unreachable"
    db.commit.assert_awaited_once()


@pytest.mark.anyio
async def test_sweep_skips_terminal_no_double_count():
    """이미 verified/abandoned(FE explicit 포함)면 skip — 이중계상 금지(AC3)."""
    agent = uuid.uuid4()
    db = AsyncMock()
    db.add = MagicMock()
    db.commit = AsyncMock()
    db.execute = AsyncMock(side_effect=[
        _scalars([agent]),          # candidates
        _first((uuid.uuid4(),)),    # terminal 존재 → skip
    ])
    n = await f.sweep_abandoned_onboarding(db)
    assert n == 0
    db.add.assert_not_called()


# ─── first_auth_seen / stream_connected 배선 회귀 가드 ────────────────────────

def test_first_auth_seen_wired_with_dedup_and_isolation():
    from app.dependencies import auth
    src = inspect.getsource(auth)
    assert "_first_auth_seen = api_key.last_used_at is None" in src  # 첫인증 dedup
    assert 'emit_onboarding_event(' in src and '"first_auth_seen"' in src


def test_stream_connected_wired_one_time_isolated():
    from app.routers import agent_gateway
    src = inspect.getsource(agent_gateway)
    assert '"stream_connected"' in src
    # 연결 establish(_pdb·presence) 블록 안에서 emit — 루프(_mark_agent_online)와 분리(1회)
    assert "emit_onboarding_event(" in src
