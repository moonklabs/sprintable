"""S6-2: SeenIdsCache LRU + TTL eviction 정책 테스트.

AC1: SSE_SEEN_IDS_MAX_SIZE 환경변수 (default 10000)
AC2: SSE_SEEN_IDS_TTL_SECONDS 환경변수 (default 3600초)
AC3: max_size 초과 시 LRU eviction
AC4: TTL 만료 항목 자동 제거
AC5: 환경변수 오버라이드 동작 검증
AC6: eviction 발동 시 DEBUG 로그 출력
"""
from __future__ import annotations

import time
from unittest.mock import patch

import pytest

from sprintable_mcp.sse_bridge import SeenIdsCache


# ─── AC1/AC2: 환경변수 기본값 ────────────────────────────────────────────────

def test_config_defaults():
    """SSE_SEEN_IDS_MAX_SIZE=10000, SSE_SEEN_IDS_TTL_SECONDS=3600 기본값."""
    from sprintable_mcp.config import settings
    assert settings.sse_seen_ids_max_size == 10000
    assert settings.sse_seen_ids_ttl_seconds == 3600


# ─── AC5: 환경변수 오버라이드 ────────────────────────────────────────────────

def test_config_env_override(monkeypatch):
    """환경변수 오버라이드 시 settings에 반영됨."""
    monkeypatch.setenv("SSE_SEEN_IDS_MAX_SIZE", "500")
    monkeypatch.setenv("SSE_SEEN_IDS_TTL_SECONDS", "60")

    from sprintable_mcp.config import McpSettings
    overridden = McpSettings()
    assert overridden.sse_seen_ids_max_size == 500
    assert overridden.sse_seen_ids_ttl_seconds == 60


# ─── SeenIdsCache 기본 동작 ──────────────────────────────────────────────────

def test_add_and_contains():
    """add() 후 __contains__가 True 반환."""
    cache = SeenIdsCache(max_size=100, ttl_seconds=3600)
    cache.add("evt-1")
    assert "evt-1" in cache
    assert "evt-2" not in cache


def test_unknown_id_not_in_cache():
    """추가하지 않은 ID는 __contains__에서 False."""
    cache = SeenIdsCache(max_size=100, ttl_seconds=3600)
    assert "never-added" not in cache


def test_len_reflects_count():
    """__len__이 실제 저장 건수를 반환."""
    cache = SeenIdsCache(max_size=100, ttl_seconds=3600)
    for i in range(5):
        cache.add(f"evt-{i}")
    assert len(cache) == 5


# ─── AC3: max_size 초과 시 LRU eviction ──────────────────────────────────────

def test_lru_eviction_on_max_size_exceeded():
    """max_size=3 → 4번째 add 시 가장 오래된 항목 제거."""
    cache = SeenIdsCache(max_size=3, ttl_seconds=3600)
    cache.add("a")
    cache.add("b")
    cache.add("c")
    cache.add("d")  # "a"가 LRU eviction 대상

    assert len(cache) == 3
    assert "a" not in cache  # 가장 오래된 항목 제거됨
    assert "b" in cache
    assert "c" in cache
    assert "d" in cache


def test_lru_access_promotes_entry():
    """access된 항목은 LRU 우선순위가 높아져 eviction에서 보호됨."""
    cache = SeenIdsCache(max_size=3, ttl_seconds=3600)
    cache.add("a")
    cache.add("b")
    cache.add("c")
    # "a" access → 최근 사용으로 갱신
    _ = "a" in cache
    # "d" 추가 → "b"가 LRU (가장 오래 미사용)
    cache.add("d")

    assert "a" in cache  # 보호됨
    assert "b" not in cache  # eviction 대상
    assert "c" in cache
    assert "d" in cache


def test_lru_eviction_logs_debug(capsys):
    """LRU eviction 시 [debug] lru-evict 로그 출력."""
    cache = SeenIdsCache(max_size=2, ttl_seconds=3600)
    cache.add("x")
    cache.add("y")
    cache.add("z")  # "x" eviction → 로그 발생

    import sys
    captured = capsys.readouterr()
    assert "lru-evict" in captured.err


# ─── AC4: TTL 만료 항목 자동 제거 ────────────────────────────────────────────

def test_ttl_expired_returns_false(monkeypatch):
    """TTL 만료된 항목은 __contains__에서 False + 제거됨."""
    cache = SeenIdsCache(max_size=100, ttl_seconds=10)
    cache.add("old-event")

    # time.monotonic()을 100초 이후로 offset
    original = time.monotonic()
    monkeypatch.setattr("sprintable_mcp.sse_bridge.time.monotonic", lambda: original + 100)

    assert "old-event" not in cache
    assert len(cache) == 0


def test_ttl_not_expired_remains(monkeypatch):
    """TTL 미만인 항목은 __contains__에서 True."""
    cache = SeenIdsCache(max_size=100, ttl_seconds=3600)
    cache.add("recent-event")

    original = time.monotonic()
    monkeypatch.setattr("sprintable_mcp.sse_bridge.time.monotonic", lambda: original + 5)

    assert "recent-event" in cache


def test_ttl_batch_evict_on_add(monkeypatch):
    """add() 호출 시 만료 항목 배치 제거 + 로그 출력."""
    cache = SeenIdsCache(max_size=100, ttl_seconds=10)
    cache.add("old-1")
    cache.add("old-2")

    original = time.monotonic()
    monkeypatch.setattr("sprintable_mcp.sse_bridge.time.monotonic", lambda: original + 100)

    cache.add("new-event")

    assert len(cache) == 1  # 만료 2건 제거 후 새 항목 1건


def test_ttl_batch_evict_logs_debug(monkeypatch, capsys):
    """TTL 배치 eviction 시 [debug] ttl-batch-evict 로그 출력."""
    cache = SeenIdsCache(max_size=100, ttl_seconds=10)
    cache.add("exp-1")
    cache.add("exp-2")

    original = time.monotonic()
    monkeypatch.setattr("sprintable_mcp.sse_bridge.time.monotonic", lambda: original + 100)

    cache.add("trigger")
    captured = capsys.readouterr()
    assert "ttl-batch-evict" in captured.err


def test_ttl_single_expire_logs_debug(monkeypatch, capsys):
    """단건 TTL 만료 시 [debug] ttl-evict 로그 출력."""
    cache = SeenIdsCache(max_size=100, ttl_seconds=10)
    cache.add("single-exp")

    original = time.monotonic()
    monkeypatch.setattr("sprintable_mcp.sse_bridge.time.monotonic", lambda: original + 100)

    result = "single-exp" in cache
    assert result is False
    captured = capsys.readouterr()
    assert "ttl-evict" in captured.err


# ─── AC6: start_sse_bridge SeenIdsCache 사용 확인 ────────────────────────────

def test_start_sse_bridge_uses_seen_ids_cache():
    """start_sse_bridge 소스에 SeenIdsCache 사용 확인."""
    import inspect
    from sprintable_mcp import sse_bridge
    source = inspect.getsource(sse_bridge.start_sse_bridge)
    assert "SeenIdsCache" in source
    assert "sse_seen_ids_max_size" in source
    assert "sse_seen_ids_ttl_seconds" in source


def test_seen_ids_add_called_instead_of_dict_assign():
    """seen_ids.add() 호출 방식으로 교체됨 (dict 직접 할당 방식 제거)."""
    import inspect
    from sprintable_mcp import sse_bridge
    source = inspect.getsource(sse_bridge.start_sse_bridge)
    assert "seen_ids.add(" in source
    assert "seen_ids[event.last_event_id] = None" not in source


def test_old_seen_ids_max_constant_removed():
    """_SEEN_IDS_MAX 상수가 sse_bridge 모듈에서 제거됨."""
    import sprintable_mcp.sse_bridge as bridge
    assert not hasattr(bridge, "_SEEN_IDS_MAX"), "_SEEN_IDS_MAX 상수는 SeenIdsCache로 대체됨"
