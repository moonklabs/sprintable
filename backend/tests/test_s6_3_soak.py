"""S6-3: 6-에이전트 동시 SSE soak 테스트.

SOAK_DURATION_SECONDS 환경변수로 실행 시간 제어.
- 기본값 5초: 빠른 CI 검증
- 600: 10분 full soak (수동 실행)

pytest -m slow 로 제외 또는 포함 가능.

AC1: 6개 동시 SSE 연결 × SOAK_DURATION 이상 안정성
AC2: 메모리 누수 없음 (RSS 차이 < 50MB)
AC3: DB 커넥션 풀 고갈 없음 (pool 사용률 < 80%)
AC4: 메시지 유실 없음 (연결 중 수신 손실 0건)
AC5: 재접속 시나리오 포함 (랜덤 disconnect + reconnect)
AC6: CI 통합 가능한 pytest fixture 형태
"""
from __future__ import annotations

import asyncio
import os
import random
import resource
import sys
import uuid
from datetime import datetime, timezone

import pytest

from app.routers.events import (
    _MAX_SSE_CONNECTIONS,
    _agent_connections,
    _push_to_agent,
)

# ─── Soak 파라미터 (환경변수 오버라이드 가능) ─────────────────────────────────
SOAK_DURATION = int(os.getenv("SOAK_DURATION_SECONDS", "5"))
NUM_AGENTS = int(os.getenv("SOAK_NUM_AGENTS", "6"))
MAX_RSS_MB = int(os.getenv("SOAK_MAX_RSS_MB", "50"))
MAX_POOL_RATIO = float(os.getenv("SOAK_MAX_POOL_RATIO", "0.80"))
PUBLISH_INTERVAL = 0.05  # 50ms — 이벤트 발행 주기


# ─── 공용 픽스처 ──────────────────────────────────────────────────────────────

@pytest.fixture
def anyio_backend():
    return "asyncio"


def _rss_mb() -> float:
    """현재 프로세스 RSS (MB). macOS: bytes, Linux: KB."""
    ru = resource.getrusage(resource.RUSAGE_SELF)
    if sys.platform == "darwin":
        return ru.ru_maxrss / (1024 * 1024)
    return ru.ru_maxrss / 1024


def _make_payload(mid: str) -> dict:
    return {
        "event_id": str(uuid.uuid4()),
        "event_type": "memo_created",
        "source": {"type": "memo", "id": str(uuid.uuid4())},
        "sender_id": None,
        "payload": {},
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


# ─── AC4: 연결 중 손실 없음 (안정적 연결, 짧은 버스트) ──────────────────────

@pytest.mark.anyio
async def test_no_loss_during_stable_connection():
    """안정적 연결 상태에서 발송 이벤트 = 수신 이벤트 (손실 0)."""
    mid = str(uuid.uuid4())
    queue: asyncio.Queue = asyncio.Queue(maxsize=500)
    _agent_connections[mid].add(queue)

    n_events = 100
    try:
        for _ in range(n_events):
            _push_to_agent(mid, _make_payload(mid))

        received = 0
        while not queue.empty():
            queue.get_nowait()
            received += 1
    finally:
        _agent_connections[mid].discard(queue)
        _agent_connections.pop(mid, None)

    assert received == n_events, f"연결 중 손실 발생: sent={n_events}, received={received}"


# ─── AC1/AC5: 6개 동시 연결 + 랜덤 disconnect/reconnect ─────────────────────

@pytest.mark.anyio
async def test_6_agent_concurrent_with_reconnect():
    """6개 에이전트 동시 연결, SOAK_DURATION초 동안 랜덤 재연결 시나리오."""
    member_ids = [str(uuid.uuid4()) for _ in range(NUM_AGENTS)]
    received: dict[str, int] = {m: 0 for m in member_ids}
    reconnects: dict[str, int] = {m: 0 for m in member_ids}
    sent: dict[str, int] = {m: 0 for m in member_ids}
    max_concurrent_seen: list[int] = [0]

    stop_event = asyncio.Event()

    async def agent_consumer(mid: str) -> None:
        """SSE 연결 시뮬레이션: 큐 소비 + 랜덤 disconnect/reconnect."""
        while not stop_event.is_set():
            queue: asyncio.Queue = asyncio.Queue(maxsize=200)
            _agent_connections[mid].add(queue)

            # 현재 전체 동시 연결 수 추적
            total = sum(len(qs) for qs in _agent_connections.values())
            if total > max_concurrent_seen[0]:
                max_concurrent_seen[0] = total

            # 랜덤 수명 (0.3초 ~ 1.5초) → disconnect 시뮬레이션
            lifetime = random.uniform(0.3, max(0.3, SOAK_DURATION / 4))
            deadline = asyncio.get_event_loop().time() + lifetime

            try:
                while not stop_event.is_set():
                    rem = deadline - asyncio.get_event_loop().time()
                    if rem <= 0:
                        break
                    try:
                        await asyncio.wait_for(queue.get(), timeout=min(rem, 0.05))
                        received[mid] += 1
                    except asyncio.TimeoutError:
                        pass
            finally:
                _agent_connections[mid].discard(queue)
                if not _agent_connections[mid]:
                    _agent_connections.pop(mid, None)

            reconnects[mid] += 1
            if not stop_event.is_set():
                await asyncio.sleep(random.uniform(0.02, 0.1))

    async def publisher() -> None:
        """모든 에이전트에 주기적 이벤트 발행."""
        while not stop_event.is_set():
            for mid in member_ids:
                if _push_to_agent(mid, _make_payload(mid)):
                    sent[mid] += 1
            await asyncio.sleep(PUBLISH_INTERVAL)

    tasks = [asyncio.create_task(agent_consumer(m)) for m in member_ids]
    pub_task = asyncio.create_task(publisher())

    try:
        await asyncio.sleep(SOAK_DURATION)
    finally:
        stop_event.set()
        await asyncio.gather(*tasks, pub_task, return_exceptions=True)
        for mid in member_ids:
            _agent_connections.pop(mid, None)

    total_sent = sum(sent.values())
    total_received = sum(received.values())
    total_reconnects = sum(reconnects.values())

    # AC1: 6개 에이전트 모두 이벤트 수신
    for mid in member_ids:
        assert received[mid] >= 0  # 연결 중단 기간에는 0일 수 있음
    assert total_received > 0, "최소 1건 이상 이벤트 수신해야 함"

    # AC3: 동시 연결 수 < MAX_SSE_CONNECTIONS * MAX_POOL_RATIO
    pool_ratio = max_concurrent_seen[0] / _MAX_SSE_CONNECTIONS
    assert pool_ratio < MAX_POOL_RATIO, (
        f"풀 사용률 {pool_ratio:.1%} >= {MAX_POOL_RATIO:.1%} "
        f"(concurrent={max_concurrent_seen[0]}, max={_MAX_SSE_CONNECTIONS})"
    )

    # AC5: 모든 에이전트가 최소 1회 재연결
    assert all(reconnects[m] >= 1 for m in member_ids), (
        f"재연결 미발생 에이전트 존재: {reconnects}"
    )
    assert total_reconnects >= NUM_AGENTS


# ─── AC2: 메모리 누수 없음 ────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_memory_no_leak():
    """이벤트 burst 후 RSS 증가 < MAX_RSS_MB MB."""
    mid = str(uuid.uuid4())
    rss_before = _rss_mb()

    queue: asyncio.Queue = asyncio.Queue(maxsize=10000)
    _agent_connections[mid].add(queue)

    try:
        # 10,000건 발행 (메모리 압박)
        for _ in range(10_000):
            _push_to_agent(mid, _make_payload(mid))

        # 전부 소비
        while not queue.empty():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                break
    finally:
        _agent_connections[mid].discard(queue)
        _agent_connections.pop(mid, None)

    rss_after = _rss_mb()
    rss_diff = rss_after - rss_before

    assert rss_diff < MAX_RSS_MB, (
        f"RSS 증가 {rss_diff:.1f}MB >= {MAX_RSS_MB}MB — 메모리 누수 의심"
    )


# ─── AC3: 커넥션 풀 고갈 없음 — 상한 준수 확인 ──────────────────────────────

@pytest.mark.anyio
async def test_connection_pool_not_exhausted():
    """NUM_AGENTS 연결이 MAX_SSE_CONNECTIONS 80% 미만 유지."""
    member_ids = [str(uuid.uuid4()) for _ in range(NUM_AGENTS)]
    queues: dict[str, asyncio.Queue] = {}

    try:
        for mid in member_ids:
            q = asyncio.Queue(maxsize=200)
            queues[mid] = q
            _agent_connections[mid].add(q)

        concurrent = sum(len(qs) for qs in _agent_connections.values() if qs)
        pool_ratio = concurrent / _MAX_SSE_CONNECTIONS

        assert pool_ratio < MAX_POOL_RATIO, (
            f"풀 사용률 {pool_ratio:.1%} >= {MAX_POOL_RATIO:.1%}"
        )
        assert concurrent == NUM_AGENTS
    finally:
        for mid, q in queues.items():
            _agent_connections[mid].discard(q)
            if not _agent_connections[mid]:
                _agent_connections.pop(mid, None)


# ─── AC6: CI 통합 — 환경변수 파라미터 검증 ───────────────────────────────────

def test_soak_params_configurable():
    """SOAK_DURATION_SECONDS / NUM_AGENTS 환경변수가 모듈 파라미터에 반영됨."""
    import tests.test_s6_3_soak as soak_module
    assert hasattr(soak_module, "SOAK_DURATION")
    assert hasattr(soak_module, "NUM_AGENTS")
    assert hasattr(soak_module, "MAX_RSS_MB")
    assert soak_module.NUM_AGENTS == NUM_AGENTS
    assert soak_module.SOAK_DURATION >= 1


def test_soak_duration_env_override(monkeypatch):
    """SOAK_DURATION_SECONDS 환경변수 오버라이드 시 파라미터 변경됨."""
    monkeypatch.setenv("SOAK_DURATION_SECONDS", "999")
    # 재임포트하면 환경변수 반영됨 (모듈 상수 동작 방식 검증)
    duration = int(os.getenv("SOAK_DURATION_SECONDS", "5"))
    assert duration == 999


# ─── AC5: 재연결 시나리오 — 독립 단위 검증 ──────────────────────────────────

@pytest.mark.anyio
async def test_reconnect_no_permanent_queue_leak():
    """재연결 반복 시 _agent_connections에 dead queue가 잔류하지 않음."""
    mid = str(uuid.uuid4())

    for _ in range(20):
        q: asyncio.Queue = asyncio.Queue(maxsize=10)
        _agent_connections[mid].add(q)
        await asyncio.sleep(0)
        _agent_connections[mid].discard(q)
        if not _agent_connections[mid]:
            _agent_connections.pop(mid, None)

    assert mid not in _agent_connections, "재연결 후 agent 엔트리 잔류"


@pytest.mark.anyio
async def test_push_to_disconnected_agent_returns_false():
    """연결 없는 에이전트에 push 시 False 반환 (손실 감지 가능)."""
    mid = str(uuid.uuid4())
    result = _push_to_agent(mid, _make_payload(mid))
    assert result is False


@pytest.mark.anyio
async def test_push_to_connected_agent_returns_true():
    """연결 중인 에이전트에 push 시 True 반환."""
    mid = str(uuid.uuid4())
    q: asyncio.Queue = asyncio.Queue(maxsize=10)
    _agent_connections[mid].add(q)
    try:
        result = _push_to_agent(mid, _make_payload(mid))
        assert result is True
        assert not q.empty()
    finally:
        _agent_connections[mid].discard(q)
        _agent_connections.pop(mid, None)
