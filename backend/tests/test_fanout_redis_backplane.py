"""#2122: fanout Redis 백플레인(wake_agent → event_broker.publish) + cutover resolver 유닛.

⭐핵심 = __wake__ 마커가 **전 구간**(producer data → 브리지 → 큐 → consumer 감지) 보존되는지 못박기.
크로스노드 wake 파손의 근본은 마커가 event_type 에만 있어 브리지(_push_to_agent=data만 큐잉)서 유실된 것.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from unittest.mock import patch

import pytest

from app.core.config import settings as _cfg_settings  # 싱글턴 — event_broker 는 settings 를 함수-로컬 import
from app.services import event_broker  # noqa: F401 (resolve_backplane 소속 모듈)
from app.services.event_broker import resolve_backplane


# ── cutover resolver (redis 우선 + 셀렉터) ──────────────────────────────────────
def test_resolve_explicit_selector_wins():
    with patch.object(_cfg_settings, "realtime_backplane", "redis"):
        assert resolve_backplane() == "redis"
    with patch.object(_cfg_settings, "realtime_backplane", "pg"):
        assert resolve_backplane() == "pg"


def test_resolve_derives_redis_when_only_redis():
    with patch.object(_cfg_settings, "realtime_backplane", ""), \
         patch.object(_cfg_settings, "pg_listen_enabled", False), \
         patch.object(_cfg_settings, "event_broker_redis_dual_publish_enabled", True), \
         patch.object(_cfg_settings, "event_broker_redis_consume_enabled", True), \
         patch.object(_cfg_settings, "event_broker_redis_dispatch_enabled", True):
        assert resolve_backplane() == "redis"


def test_resolve_pg_when_only_pg():
    with patch.object(_cfg_settings, "realtime_backplane", ""), \
         patch.object(_cfg_settings, "pg_listen_enabled", True), \
         patch.object(_cfg_settings, "event_broker_redis_dispatch_enabled", False):
        assert resolve_backplane() == "pg"


def test_resolve_conflict_redis_wins_startup_logs(caplog):
    """PG_LISTEN + Redis dispatch 동시 활성(미설정) → redis 우선. startup(log_conflict=True)만 ERROR 로그."""
    with patch.object(_cfg_settings, "realtime_backplane", ""), \
         patch.object(_cfg_settings, "pg_listen_enabled", True), \
         patch.object(_cfg_settings, "event_broker_redis_dispatch_enabled", True):
        with caplog.at_level(logging.ERROR):
            assert resolve_backplane(log_conflict=True) == "redis"   # startup 경로 → 로그
        assert any("REALTIME_BACKPLANE" in r.message for r in caplog.records)


def test_resolve_conflict_loop_path_no_log_spam(caplog):
    """dispatch 루프 경로(log_conflict 기본 False)는 redis 우선이되 매-메시지 로그 스팸 안 함."""
    with patch.object(_cfg_settings, "realtime_backplane", ""), \
         patch.object(_cfg_settings, "pg_listen_enabled", True), \
         patch.object(_cfg_settings, "event_broker_redis_dispatch_enabled", True):
        with caplog.at_level(logging.ERROR):
            assert resolve_backplane() == "redis"
        assert not any("REALTIME_BACKPLANE" in r.message for r in caplog.records)  # 로그 억제 확認


# ── ⭐ __wake__ 전구간(마커 보존) ─────────────────────────────────────────────
@pytest.mark.anyio
async def test_wake_marker_survives_bridge_to_queue():
    """PO 필수: __wake__ 를 **data 에** 실은 envelope 가 브리지(_dispatch_received)→_push_to_agent→큐에
    마커 보존된 채 도착 → consumer 의 signal.get('__wake__') 감지 성립. (#2122 fix 가 확립하는 패리티.)"""
    from app.routers import events as events_mod
    from app.services import pg_pubsub

    agent_id = str(uuid.uuid4())
    q: asyncio.Queue = asyncio.Queue(maxsize=200)
    events_mod._agent_connections[agent_id].add(q)
    try:
        # wake_agent(flag on) 가 발행하는 것과 동형인, 타노드에서 수신되는 envelope
        envelope = json.dumps({
            "instance_id": "OTHER_NODE", "target": "agent", "target_id": agent_id,
            "event_type": "__wake__", "data": {"__wake__": True, "seq": 7},
        })
        await pg_pubsub._dispatch_received(envelope)
        assert not q.empty()
        signal = q.get_nowait()
        assert signal.get("__wake__") is True   # ⭐ 마커 보존 = agent_gateway generate 의 wake 분기 성립
        assert signal.get("seq") == 7
    finally:
        events_mod._agent_connections[agent_id].discard(q)
        events_mod._agent_connections.pop(agent_id, None)


def test_wake_agent_flag_on_puts_marker_in_data():
    """producer 측(전구간 시작점): flag on → wake_agent 가 event_broker.publish 로 __wake__ 를 **data 에** 실어
    발행(Redis 백플레인 경유). flag off 는 기존 pg_notify(마커 event_type-only) 유지 = 무회귀."""
    from unittest.mock import AsyncMock, MagicMock
    from app.routers import agent_gateway

    def _swallow(coro):
        try:
            coro.close()
        except Exception:
            pass

    with patch.object(_cfg_settings, "fanout_wake_redis_enabled", True), \
         patch("app.services.event_broker.event_broker.publish", new=AsyncMock()) as mock_pub, \
         patch("app.services.pg_pubsub.fire_and_forget", new=MagicMock(side_effect=_swallow)):
        agent_gateway.wake_agent(str(uuid.uuid4()), 5)

    mock_pub.assert_called_once()
    a = mock_pub.call_args.args
    assert a[0] == "agent" and a[2] == "__wake__"
    assert a[3] == {"__wake__": True, "seq": 5}   # ⭐ 마커가 data 에(event_type-only 아님)


@pytest.mark.anyio
async def test_wake_marker_lost_when_only_in_event_type():
    """회귀방지 대조: 마커가 event_type 에만 있고 data 에 없으면 브리지서 유실 → consumer 미감지.
    = 크로스노드 wake 파손의 근본 재현(fix 前 legacy pg_notify {"seq":seq} 동형)."""
    from app.routers import events as events_mod
    from app.services import pg_pubsub

    agent_id = str(uuid.uuid4())
    q: asyncio.Queue = asyncio.Queue(maxsize=200)
    events_mod._agent_connections[agent_id].add(q)
    try:
        envelope = json.dumps({
            "instance_id": "OTHER_NODE", "target": "agent", "target_id": agent_id,
            "event_type": "__wake__", "data": {"seq": 7},   # data 에 마커 없음(기존 파손)
        })
        await pg_pubsub._dispatch_received(envelope)
        signal = q.get_nowait()
        assert signal.get("__wake__") is None   # ⭐ 유실 — wake 미감지("message"로 오인됐던 근본
    finally:
        events_mod._agent_connections[agent_id].discard(q)
        events_mod._agent_connections.pop(agent_id, None)
