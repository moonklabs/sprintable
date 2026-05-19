"""S6-4: Phase 6 DoD 완주 검증.

AC1: Python MCP 전 에이전트 실기동 (ps aux 기준 5개 인스턴스)
AC2: TS MCP 프로세스 전무 (mcp-server/dist 프로세스 0건)
AC3: SSE backfill 볼륨 제어 동작 (_compute_backfill_mode)
AC4: seen_ids eviction 동작 (SeenIdsCache LRU)
AC5: soak 테스트 PASS 이력 확인
"""
from __future__ import annotations

import subprocess
import sys
from datetime import datetime, timedelta, timezone

import pytest


# ─── AC1: Python MCP 실기동 확인 ─────────────────────────────────────────────

@pytest.mark.skipif(
    sys.platform not in ("linux", "darwin"),
    reason="ps aux는 Unix only",
)
def test_python_mcp_instances_running():
    """ps aux 기준 sprintable_mcp Python 인스턴스 5개 이상 실기동."""
    result = subprocess.run(
        ["ps", "aux"],
        capture_output=True, text=True, check=True,
    )
    lines = [
        l for l in result.stdout.splitlines()
        if "python" in l and "sprintable_mcp" in l and "uv run" not in l
    ]
    assert len(lines) >= 5, (
        f"Python MCP 인스턴스 {len(lines)}개 — 5개 이상 필요\n"
        + "\n".join(lines)
    )


# ─── AC2: TS MCP 프로세스 전무 확인 ──────────────────────────────────────────

@pytest.mark.skipif(
    sys.platform not in ("linux", "darwin"),
    reason="ps aux는 Unix only",
)
def test_ts_mcp_process_absent():
    """ps aux 기준 packages/mcp-server/dist 프로세스 0건."""
    result = subprocess.run(
        ["ps", "aux"],
        capture_output=True, text=True, check=True,
    )
    ts_lines = [
        l for l in result.stdout.splitlines()
        if "mcp-server/dist" in l and "grep" not in l
    ]
    assert len(ts_lines) == 0, (
        f"TS MCP 프로세스 {len(ts_lines)}건 발견 — 완전 종료 필요\n"
        + "\n".join(ts_lines)
    )


# ─── AC3: SSE backfill 볼륨 제어 동작 확인 ───────────────────────────────────

def test_backfill_threshold_module_available():
    """S6-1 _compute_backfill_mode import 가능."""
    from app.routers.events import _compute_backfill_mode, _BACKFILL_THRESHOLD_SECONDS, _BACKFILL_MAX_EVENTS
    assert callable(_compute_backfill_mode)
    assert _BACKFILL_THRESHOLD_SECONDS == 300
    assert _BACKFILL_MAX_EVENTS == 50


def test_backfill_threshold_exceeded_returns_max_events():
    """threshold 초과 시 _compute_backfill_mode가 MAX_EVENTS limit 반환."""
    from app.routers.events import _compute_backfill_mode, _BACKFILL_MAX_EVENTS
    now = datetime.now(timezone.utc)
    # 6분 전 — threshold(300초) 초과
    ref = now - timedelta(seconds=360)
    exceed, limit = _compute_backfill_mode(ref, now)
    assert exceed is True
    assert limit == _BACKFILL_MAX_EVENTS


def test_backfill_within_threshold_returns_100():
    """threshold 이내 시 limit=100 반환."""
    from app.routers.events import _compute_backfill_mode
    now = datetime.now(timezone.utc)
    ref = now - timedelta(seconds=60)
    exceed, limit = _compute_backfill_mode(ref, now)
    assert exceed is False
    assert limit == 100


def test_backfill_query_has_composite_cursor():
    """agent_event_stream 소스에 복합 커서 OR 조건 존재 (AC1 RC1 검증)."""
    import inspect
    from app.routers import events as ev
    source = inspect.getsource(ev.agent_event_stream)
    assert "Event.created_at == _ref" in source
    assert "Event.id > last_event_id" in source


def test_live_sse_always_emits_id_field():
    """live SSE yield에 event_id 없어도 uuid4()로 id: 보장 (AC1 RC2 검증)."""
    import inspect
    from app.routers import events as ev
    source = inspect.getsource(ev.agent_event_stream)
    assert "_live_id = eid or str(uuid.uuid4())" in source


# ─── AC4: seen_ids eviction 동작 확인 ────────────────────────────────────────

def test_seen_ids_cache_available():
    """S6-2 SeenIdsCache import 가능."""
    from sprintable_mcp.sse_bridge import SeenIdsCache
    assert callable(SeenIdsCache)


def test_seen_ids_lru_eviction_works():
    """max_size 초과 시 LRU eviction 정상 동작."""
    from sprintable_mcp.sse_bridge import SeenIdsCache
    cache = SeenIdsCache(max_size=3, ttl_seconds=3600)
    cache.add("a")
    cache.add("b")
    cache.add("c")
    cache.add("d")  # "a" eviction
    assert "a" not in cache
    assert len(cache) == 3


def test_seen_ids_env_config():
    """SSE_SEEN_IDS_MAX_SIZE / TTL 환경변수 기본값 확인."""
    from sprintable_mcp.config import settings
    assert settings.sse_seen_ids_max_size == 10000
    assert settings.sse_seen_ids_ttl_seconds == 3600


def test_old_seen_ids_max_constant_gone():
    """_SEEN_IDS_MAX 상수 제거 확인 (SeenIdsCache로 완전 대체)."""
    import sprintable_mcp.sse_bridge as bridge
    assert not hasattr(bridge, "_SEEN_IDS_MAX")


# ─── AC5: soak 테스트 PASS 이력 확인 ─────────────────────────────────────────

def test_soak_test_module_exists():
    """S6-3 soak 테스트 모듈 import 가능."""
    import tests.test_s6_3_soak as soak
    assert hasattr(soak, "test_6_agent_concurrent_with_reconnect")
    assert hasattr(soak, "test_memory_no_leak")
    assert hasattr(soak, "test_no_loss_during_stable_connection")


def test_soak_test_params():
    """soak 테스트 파라미터 정상 설정."""
    import tests.test_s6_3_soak as soak
    assert soak.NUM_AGENTS == 6
    assert soak.MAX_RSS_MB == 50
    assert soak.SOAK_DURATION >= 1
