"""story #2582: 비정상 종료(kill -9 등)로 SSE 연결이 orphan lease로 남으면 같은 키의 재접속이
429로 거부되는데, 기존 Retry-After는 flat `_AGENT_STREAM_RETRY_AFTER`(기본 5s)로 sse_lease의
실제 TTL 자가회수 시한(`_TTL_SEC`, 기본 90s)과 무관했다 — 정직히 못한 신호를 믿고 재시도하는
클라는 실제 해소보다 훨씬 일찍·반복적으로 429를 다시 맞아 "lockout"처럼 체감된다(customer-zero
QA 실측: hermes-test 직접 프로브가 429를 즉시 재현).

이 파일은 Redis lease 경로(fakeredis)로 (1) orphan 3건(kill -9 — 명시 release 없이 acquire만
한 상태)이 실제로 다음 연결을 429로 막는 것, (2) 그 429의 Retry-After가 flat default가 아니라
실측 가장-이른-만료시각 기반으로 정확한 것, (3) 그 시각이 지나면(TTL 자가회수) 같은 키가 재접속
성공한다는 것 — 즉 «영구 lockout이 아니라 정직하게 통보된 bounded self-heal»임을 재현한다.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from app.dependencies.auth import AuthContext
from app.routers import agent_gateway as ag
from app.services import sse_lease


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def _flag_on_fakeredis():
    aioredis = pytest.importorskip("fakeredis.aioredis")
    pytest.importorskip("lupa")
    server = aioredis.FakeServer()
    client = aioredis.FakeRedis(server=server, decode_responses=True)
    with patch.object(sse_lease.settings, "sse_lease_redis_enabled", True), \
         patch.object(sse_lease.settings, "redis_url", "redis://fake"), \
         patch("app.services.redis_shared.get_client", return_value=client):
        yield client


def _patch_route(monkeypatch, agent_id, org_plan="free"):
    db = AsyncMock(); db.add = MagicMock(); db.commit = AsyncMock()
    tm = MagicMock(); tm.org_id = uuid.uuid4()
    res_agent = MagicMock(); res_agent.scalar_one_or_none.return_value = tm
    res_plan = MagicMock(); res_plan.scalar_one_or_none.return_value = org_plan
    res_cursor = MagicMock(); res_cursor.scalar_one_or_none.return_value = None
    db.execute = AsyncMock(side_effect=[res_agent, res_plan, res_cursor])

    class _Ctx:
        async def __aenter__(self):
            return db
        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(ag, "async_session_factory", lambda: _Ctx())
    monkeypatch.setattr(ag, "_agent_sse_connection_count", 0)  # global cap 여유
    req = MagicMock(); req.headers = {}
    auth = AuthContext(user_id=str(agent_id), email=None,
                       claims={"app_metadata": {"api_key_id": "k"}}, org_id=None)
    return req, auth, str(agent_id)


async def _leave_orphans(scope: str, n: int) -> None:
    """kill -9 모사 — acquire만 하고 release는 절대 안 부른다(finally가 안 돈 것과 동형)."""
    for i in range(n):
        assert await sse_lease.acquire(scope, n, f"orphan-{i}") is True


@pytest.mark.anyio
async def test_orphan_leases_block_reconnect_with_429(monkeypatch, _flag_on_fakeredis):
    aid = uuid.uuid4()
    req, auth, aid_str = _patch_route(monkeypatch, aid, org_plan="free")
    limit = ag._AGENT_STREAM_TIER_LIMITS["free"]
    await _leave_orphans(f"perkey:{aid_str}", limit)  # 한도만큼 orphan(kill -9)
    try:
        with pytest.raises(HTTPException) as exc:
            await ag.agent_stream(req, auth=auth)
        assert exc.value.status_code == 429
    finally:
        ag._agent_connections.pop(aid_str, None)


@pytest.mark.anyio
async def test_retry_after_reflects_actual_earliest_expiry_not_flat_default(monkeypatch, _flag_on_fakeredis):
    """핵심 회귀가드 — Retry-After가 flat _AGENT_STREAM_RETRY_AFTER(5s)가 아니라 그 scope의
    실제 가장-이른 만료시각 기반이어야 한다. orphan lease의 score를 60s 뒤로 직접 세팅해
    5s와 명백히 다른 값을 기대한다."""
    aid = uuid.uuid4()
    req, auth, aid_str = _patch_route(monkeypatch, aid, org_plan="free")
    limit = ag._AGENT_STREAM_TIER_LIMITS["free"]
    scope = f"perkey:{aid_str}"
    await _leave_orphans(scope, limit)
    # 실측처럼 orphan들이 서로 다른 시점에 죽었다고 가정 — 가장 이른 것을 60s 뒤로 고정.
    key = sse_lease._key(scope)
    await _flag_on_fakeredis.zadd(key, {
        "orphan-0": time.time() + 60, "orphan-1": time.time() + 61, "orphan-2": time.time() + 62,
    })
    try:
        with pytest.raises(HTTPException) as exc:
            await ag.agent_stream(req, auth=auth)
        assert exc.value.status_code == 429
        retry_after = int(exc.value.headers["Retry-After"])
        assert retry_after != ag._AGENT_STREAM_RETRY_AFTER  # flat default(5)가 아니다
        assert 55 <= retry_after <= 62  # ~60s(가장 이른 orphan의 만료)에 근접
        assert exc.value.detail["retry_after"] == retry_after
    finally:
        ag._agent_connections.pop(aid_str, None)


@pytest.mark.anyio
async def test_reconnect_succeeds_after_orphan_leases_expire(monkeypatch, _flag_on_fakeredis):
    """AC1 재현 — 영구 lockout이 아니라 TTL 지나면(비정상 종료 orphan 자가회수) 같은 키가
    재접속 성공한다. real-time sleep 대신 score를 과거로 밀어 TTL 경과를 흉내(lupa Lua eval이
    실제 시각을 쓰므로 score만 조작하면 다음 acquire 호출에서 ZREMRANGEBYSCORE로 정확히 evict)."""
    aid = uuid.uuid4()
    req, auth, aid_str = _patch_route(monkeypatch, aid, org_plan="free")
    limit = ag._AGENT_STREAM_TIER_LIMITS["free"]
    scope = f"perkey:{aid_str}"
    await _leave_orphans(scope, limit)
    with pytest.raises(HTTPException):
        await ag.agent_stream(req, auth=auth)  # 아직 orphan이 안 죽어서 429

    # TTL 경과 흉내 — 모든 orphan score를 과거로.
    key = sse_lease._key(scope)
    await _flag_on_fakeredis.zadd(key, {
        f"orphan-{i}": time.time() - 1 for i in range(limit)
    })
    # per-key 라우트 재진입은 db.execute side_effect 큐를 다시 채워야 함(1콜당 3회 소비).
    req2, auth2, _ = _patch_route(monkeypatch, aid, org_plan="free")
    try:
        resp = await ag.agent_stream(req2, auth=auth2)
        assert isinstance(resp, StreamingResponse)  # 자가회수 후 재접속 성공 — 영구 lockout 아님
    finally:
        ag._agent_connections.pop(aid_str, None)
