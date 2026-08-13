"""story #2602(both-fix, PO 승인 2026-08-13) — heartbeat 전진 기반 lease refresh 게이트(Fix①)
+ wipe-race 억제(Fix②).

prod 관측(08-13 18:37): ①/agent/stream 429 재시도 폭풍 ②「Truncated response」연속(SSE
비정상 사망을 서버가 못 앎) ③429가 나는 동안 heartbeat는 200 흐름(독립 liveness 축)
④offline 오노출(wipe-race 정황).

검증 축:
- AC①: `evaluate_advance()` 순수 상태전이 — dial-out(전진 없음)은 영원히 미무장·정상 refresh
  유지(회귀 0), heartbeat-user는 무장 후 stale 전환 시에만 skip.
- AC②: 양 모드 분기 — AC2 on(게이트 작동)·off(현행 그대로, heartbeat_baseline 무시).
- AC③: orphan 시나리오에서 lease가 실제로(fakeredis 실 TTL 경과) evict — refresh 보류=
  #2630/#2622 QA式 라이브 재현과 동형 원리(메커니즘 자체를 짧은 TTL로 축소해 실측).
- skip·무장 카운터 실물(Redis INCR).
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

AGENT_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _fakeredis_client():
    aioredis = pytest.importorskip("fakeredis.aioredis")
    server = aioredis.FakeServer()
    return aioredis.FakeRedis(server=server, decode_responses=True)


def _patch_session_factory(execute_results=None):
    """test_agent_gateway.py의 헬퍼와 동형(파일 독립성 유지 — 다른 story 파일 재사용 관례,
    #2630/#2632 선례와 동일 이유)."""
    import contextlib

    db = MagicMock()
    results = list(execute_results or [])

    async def _execute(*a, **k):
        return results.pop(0) if results else MagicMock()

    db.execute = AsyncMock(side_effect=_execute)
    db.commit = AsyncMock()

    def _factory():
        @contextlib.asynccontextmanager
        async def _cm():
            yield db
        return _cm()

    return _factory, db


def _ac2_settings_patches():
    from app.core.config import settings
    return (patch.object(settings, "presence_online_redis_enabled", True),
            patch.object(settings, "redis_url", "redis://x"))


# ─── AC①: evaluate_advance() 순수 상태전이 ──────────────────────────────────────

def test_evaluate_advance_never_seen_stays_unarmed_no_skip():
    """dial-out 첫 tick(아직 heartbeat 신호 자체가 없음) — 무장 안 함·skip 안 함."""
    from app.services.heartbeat_freshness import evaluate_advance

    r = evaluate_advance(current=None, last_observed=None, armed=False)
    assert r.armed is False
    assert r.should_skip_refresh is False
    assert r.newly_armed is False


def test_evaluate_advance_frozen_value_after_arming_skips_refresh():
    """connect-time 최초 write 하나만 있고 그 뒤로 다시는 안 바뀌는 값(같은 last_seen_at
    반복 관측)은 최초 1회 무장 후 곧바로 skip 판정 — "heartbeat가 1번 오고 멈춘" 케이스의
    핵심 회귀가드(신선함이 아니라 전진을 본다)."""
    from app.services.heartbeat_freshness import evaluate_advance

    frozen = datetime(2026, 8, 13, 12, 0, 0, tzinfo=timezone.utc)
    r1 = evaluate_advance(current=frozen, last_observed=None, armed=False)
    assert r1.armed is True and r1.newly_armed is True
    r2 = evaluate_advance(current=frozen, last_observed=r1.last_observed, armed=r1.armed)
    assert r2.should_skip_refresh is True


def test_evaluate_advance_dial_out_realistic_never_arms():
    """진짜 dial-out 재현 — get_agent_last_heartbeat가 애초에 None을 반환(heartbeat
    엔드포인트를 한 번도 안 침, connect-time write는 last_seen_at이 아니라 별도 축이라고
    가정 못 하는 최악 케이스도 커버: profile row 자체가 없거나 MAX가 None인 경우).
    이 경로가 여러 tick 반복돼도 무장이 단 한 번도 안 걸려야 정상 refresh가 유지된다."""
    from app.services.heartbeat_freshness import evaluate_advance

    armed, last_observed = False, None
    for _ in range(5):  # 5 tick 시뮬레이션 — 매번 current=None(heartbeat 신호 전무)
        r = evaluate_advance(current=None, last_observed=last_observed, armed=armed)
        armed, last_observed = r.armed, r.last_observed
        assert r.should_skip_refresh is False
    assert armed is False


def test_evaluate_advance_heartbeat_user_then_stops_arms_then_skips():
    """heartbeat가 반복 전진하다가(무장) 멈추면(전진 정지) 그 다음 tick부터 skip — Fix①의
    핵심 시나리오(429 스톰의 원인이 된 실제 zombie 시그니처)."""
    from app.services.heartbeat_freshness import evaluate_advance

    t0 = datetime(2026, 8, 13, 12, 0, 0, tzinfo=timezone.utc)
    t1 = t0 + timedelta(seconds=30)
    t2 = t0 + timedelta(seconds=60)

    r1 = evaluate_advance(current=t0, last_observed=None, armed=False)
    assert r1.armed is True and r1.newly_armed is True and r1.should_skip_refresh is False

    r2 = evaluate_advance(current=t1, last_observed=r1.last_observed, armed=r1.armed)
    assert r2.armed is True and r2.newly_armed is False and r2.should_skip_refresh is False  # 계속 전진 — 재무장 카운트 없음

    r3 = evaluate_advance(current=t1, last_observed=r2.last_observed, armed=r2.armed)  # heartbeat 정지(같은 값)
    assert r3.should_skip_refresh is True

    r4 = evaluate_advance(current=t2, last_observed=r3.last_observed, armed=r3.armed)  # heartbeat 재개
    assert r4.should_skip_refresh is False and r4.armed is True and r4.newly_armed is False


# ─── AC②: _mark_agent_disconnected Fix② — wipe-race 억제(on 모드) ────────────────

@pytest.mark.anyio
async def test_wipe_suppressed_when_newer_heartbeat_after_baseline():
    """내 connect(baseline) 이후 heartbeat가 실제로 왔으면 오프라인 강등 skip."""
    from app.routers.agent_gateway import _mark_agent_disconnected

    s1, s2 = _ac2_settings_patches()
    no_remaining = MagicMock(); no_remaining.scalar_one_or_none.return_value = None
    newer_hb = MagicMock()
    baseline = datetime.now(timezone.utc) - timedelta(seconds=10)
    newer_hb.scalar_one_or_none.return_value = datetime.now(timezone.utc)  # baseline보다 새것
    factory, db = _patch_session_factory([MagicMock(), no_remaining, newer_hb])
    with s1, s2, \
         patch("app.routers.agent_gateway.async_session_factory", factory), \
         patch("app.services.agent_anchor_sync.sync_agent_profile_presence", new=AsyncMock()) as mock_sync, \
         patch("app.services.presence_online.is_online", new=AsyncMock(return_value=True)), \
         patch("app.services.presence_online.clear_online", new=AsyncMock()) as mock_clear, \
         patch("app.services.chat_presence.clear_member", new=AsyncMock(return_value=[])), \
         patch("app.services.heartbeat_freshness.incr_wipe_suppressed_counter", new=AsyncMock()) as mock_incr:
        await _mark_agent_disconnected(
            AGENT_ID, uuid.uuid4(), heartbeat_baseline=baseline,
        )
    mock_sync.assert_not_awaited()   # 강등 skip
    mock_clear.assert_not_awaited()
    mock_incr.assert_awaited_once()


@pytest.mark.anyio
async def test_wipe_proceeds_when_no_newer_heartbeat():
    """baseline 이후 새 신호가 없으면(내가 마지막) 기존대로 강등 진행."""
    from app.routers.agent_gateway import _mark_agent_disconnected

    s1, s2 = _ac2_settings_patches()
    no_remaining = MagicMock(); no_remaining.scalar_one_or_none.return_value = None
    older_hb = MagicMock()
    baseline = datetime.now(timezone.utc)
    older_hb.scalar_one_or_none.return_value = baseline - timedelta(seconds=5)  # baseline보다 오래됨
    factory, db = _patch_session_factory([MagicMock(), no_remaining, older_hb])
    with s1, s2, \
         patch("app.routers.agent_gateway.async_session_factory", factory), \
         patch("app.services.agent_anchor_sync.sync_agent_profile_presence", new=AsyncMock()) as mock_sync, \
         patch("app.services.presence_online.is_online", new=AsyncMock(return_value=True)), \
         patch("app.services.presence_online.clear_online", new=AsyncMock()) as mock_clear, \
         patch("app.services.chat_presence.clear_member", new=AsyncMock(return_value=[])):
        await _mark_agent_disconnected(
            AGENT_ID, uuid.uuid4(), heartbeat_baseline=baseline,
        )
    mock_sync.assert_awaited_once()
    _, kw = mock_sync.await_args
    assert kw["agent_status"] == "offline"
    mock_clear.assert_awaited_once()


@pytest.mark.anyio
async def test_wipe_check_skipped_when_baseline_not_provided():
    """heartbeat_baseline 미지정(기존 호출부·회귀 없음) — Fix② 쿼리 자체를 안 하고 기존 로직
    그대로(execute 호출 횟수가 기존과 동일해야 — 3번째 execute가 없어야 함)."""
    from app.routers.agent_gateway import _mark_agent_disconnected

    s1, s2 = _ac2_settings_patches()
    no_remaining = MagicMock(); no_remaining.scalar_one_or_none.return_value = None
    factory, db = _patch_session_factory([MagicMock(), no_remaining])  # 딱 2개만 — 3번째 있으면 MagicMock() 기본값 소비돼 조용히 통과하니 count로 명시 확인
    with s1, s2, \
         patch("app.routers.agent_gateway.async_session_factory", factory), \
         patch("app.services.agent_anchor_sync.sync_agent_profile_presence", new=AsyncMock()) as mock_sync, \
         patch("app.services.presence_online.is_online", new=AsyncMock(return_value=True)), \
         patch("app.services.presence_online.clear_online", new=AsyncMock()):
        await _mark_agent_disconnected(AGENT_ID, uuid.uuid4())  # heartbeat_baseline 생략
    mock_sync.assert_awaited_once()  # 기존(2620/49fed0a1) 동작 그대로 강등
    assert db.execute.await_count == 2  # Fix② 쿼리(3번째) 없음 — 진짜 no-op 확인


@pytest.mark.anyio
async def test_off_mode_ignores_heartbeat_baseline():
    """AC2 off — heartbeat_baseline을 넘겨도 무시(회로형 함정 방지, 페드루 판정 2026-08-13
    "off 모드 자기충족 루프" 우려에 대한 대칭 처리)."""
    from app.routers.agent_gateway import _mark_agent_disconnected

    no_remaining = MagicMock(); no_remaining.scalar_one_or_none.return_value = None
    factory, db = _patch_session_factory([MagicMock(), no_remaining])
    with patch("app.routers.agent_gateway.async_session_factory", factory), \
         patch("app.services.agent_anchor_sync.sync_agent_profile_presence", new=AsyncMock()) as mock_sync:
        await _mark_agent_disconnected(
            AGENT_ID, uuid.uuid4(), heartbeat_baseline=datetime.now(timezone.utc),
        )
    mock_sync.assert_awaited_once()  # off 모드는 기존 freshness 경로 그대로 — 강등 진행
    assert db.execute.await_count == 2  # AC2 분기(Fix② 포함) 자체를 안 탐


# ─── AC③: orphan 시 lease가 실제로 자연 evict(refresh 보류 메커니즘 실측) ──────────

@pytest.mark.anyio
async def test_lease_naturally_evicts_when_refresh_withheld():
    """Fix①이 refresh를 skip하면 sse_lease의 자기 TTL이 그 슬롯을 실제로 회수한다 — 좀비가
    lease를 영구 점유하던 원 사고(#2602 관측①②)를 메커니즘 레벨에서 실측. _TTL_SEC을
    축소(90s→1s)해 실 sleep으로 검증 — 값 자체는 축소해도 "refresh 안 하면 TTL이 회수한다"는
    메커니즘은 동치(TTL 값 자체는 sse_lease.py 자기 상수이지 이 스토리의 변경 대상 아님)."""
    from app.services import sse_lease
    from app.core.config import settings

    client = _fakeredis_client()
    with patch.object(settings, "sse_lease_redis_enabled", True), \
         patch.object(settings, "redis_url", "redis://x"), \
         patch("app.services.redis_shared.get_client", return_value=client), \
         patch.object(sse_lease, "_TTL_SEC", 1):
        acquired = await sse_lease.acquire("test_2602_scope", 1, "orphan-conn")
        assert acquired is True
        assert await sse_lease.count("test_2602_scope") == 1

        # orphan 시뮬레이션: Fix①이 skip 판정한 그 상황과 동형 — refresh를 의도적으로 안 침.
        await asyncio.sleep(1.3)

        assert await sse_lease.count("test_2602_scope") == 0  # TTL 자연만료로 evict
        # 새 연결이 그 슬롯을 즉시 획득할 수 있어야(429 스톰 원인이던 좀비 점유가 실제로 풀림).
        assert await sse_lease.acquire("test_2602_scope", 1, "new-conn") is True


# ─── 카운터 실물 ─────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_counters_increment_via_redis():
    from app.services import heartbeat_freshness as hf

    client = _fakeredis_client()
    with patch("app.services.redis_shared.get_client", return_value=client):
        await hf.incr_armed_counter()
        await hf.incr_armed_counter()
        await hf.incr_refresh_skip_counter()
        await hf.incr_wipe_suppressed_counter()
        counts = await hf.get_counters()
    assert counts["armed_total"] == 2
    assert counts["refresh_skip_total"] == 1
    assert counts["wipe_suppressed_total"] == 1


@pytest.mark.anyio
async def test_counters_redis_down_returns_none():
    from app.services import heartbeat_freshness as hf

    with patch("app.services.redis_shared.get_client", return_value=None):
        counts = await hf.get_counters()
    assert counts == {"armed_total": None, "refresh_skip_total": None, "wipe_suppressed_total": None}
