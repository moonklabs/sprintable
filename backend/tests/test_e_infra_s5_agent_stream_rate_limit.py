"""E-INFRA S5: /agent/stream per-API-key(=agent) 동시 스트림 제한 (tier-aware).

한 키가 무제한 스트림을 열어 메모리/큐 독점하는 abuse 방지. per-key 카운트 = _agent_connections[agent_id].
tier(=org.plan) free < paid. 초과 → 429 + Retry-After. 다른 키는 무관.
"""
import asyncio
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from app.routers import agent_gateway as ag
from app.dependencies.auth import AuthContext


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _patch(monkeypatch, agent_id, org_plan="free"):
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


def _fill(agent_id_str, n):
    for _ in range(n):
        ag._agent_connections[agent_id_str].add(asyncio.Queue())


def test_tier_limits_free_lower_than_paid():
    assert ag._AGENT_STREAM_TIER_LIMITS["free"] < ag._AGENT_STREAM_TIER_LIMITS["team"]
    assert ag._AGENT_STREAM_TIER_LIMITS["free"] < ag._AGENT_STREAM_TIER_LIMITS["pro"]


@pytest.mark.anyio
async def test_same_key_over_limit_returns_429(monkeypatch):
    aid = uuid.uuid4()
    req, auth, aid_str = _patch(monkeypatch, aid, org_plan="free")
    limit = ag._AGENT_STREAM_TIER_LIMITS["free"]
    _fill(aid_str, limit)  # 한도만큼 기존 스트림 → 다음 연결은 초과
    try:
        with pytest.raises(HTTPException) as exc:
            await ag.agent_stream(req, auth=auth)
        assert exc.value.status_code == 429
        assert exc.value.headers.get("Retry-After") is not None
    finally:
        ag._agent_connections.pop(aid_str, None)


@pytest.mark.anyio
async def test_different_key_independent(monkeypatch):
    a_str = str(uuid.uuid4())
    _fill(a_str, ag._AGENT_STREAM_TIER_LIMITS["free"])  # agent A 한도 도달
    b = uuid.uuid4()
    req, auth, b_str = _patch(monkeypatch, b, org_plan="free")  # agent B는 빈 상태
    try:
        resp = await ag.agent_stream(req, auth=auth)
        assert isinstance(resp, StreamingResponse)  # B는 A와 무관하게 허용
    finally:
        ag._agent_connections.pop(a_str, None)
        ag._agent_connections.pop(b_str, None)


@pytest.mark.anyio
async def test_tier_aware_paid_allows_more(monkeypatch):
    aid = uuid.uuid4()
    req, auth, aid_str = _patch(monkeypatch, aid, org_plan="pro")
    _fill(aid_str, ag._AGENT_STREAM_TIER_LIMITS["free"])  # free 한도(3)만큼 — pro는 한도 더 높음
    try:
        resp = await ag.agent_stream(req, auth=auth)  # pro라 허용(free였으면 429)
        assert isinstance(resp, StreamingResponse)
    finally:
        ag._agent_connections.pop(aid_str, None)


@pytest.mark.anyio
async def test_global_cap_rejection_does_not_leak_per_key_dict_entry(monkeypatch):
    """story #2602 ⓑ: `_agent_connections`는 defaultdict(set) — per-key 한도 체크의
    `_agent_connections[agent_id_str]` 서브스크립트는 **조회만으로도** 빈 set 항목을 만든다.
    이 agent는 기존 연결이 0개라 per-key 체크는 통과하지만(0 < limit), 뒤이은 전역 cap(503)에서
    거부된다 — 이 요청이 실제 연결을 하나도 등록 못 했는데도(`.add(queue)`엔 도달 못 함) dict에
    영구 흔적을 남기면 안 된다("거부가 자원을 만드는" 결함, 실제 slot 카운트엔 무해하지만
    agent_id마다 무한정 쌓이는 dict key 누수)."""
    aid = uuid.uuid4()
    req, auth, aid_str = _patch(monkeypatch, aid, org_plan="free")
    assert aid_str not in ag._agent_connections  # 사전조건 — 이 agent는 한 번도 등록된 적 없음
    monkeypatch.setattr(ag, "_agent_sse_connection_count", ag._MAX_AGENT_SSE_CONNECTIONS)  # 전역 cap 초과
    try:
        with pytest.raises(HTTPException) as exc:
            await ag.agent_stream(req, auth=auth)
        assert exc.value.status_code == 503
        assert aid_str not in ag._agent_connections, (
            "전역 cap에 거부된 요청이 per-key dict에 빈 항목을 남김(#2602 ⓑ 재발)"
        )
    finally:
        ag._agent_connections.pop(aid_str, None)
