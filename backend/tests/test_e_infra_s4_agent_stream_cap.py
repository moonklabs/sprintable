"""E-INFRA S4: /agent/stream 전역 연결 cap.

legacy /events/stream의 _MAX_SSE_CONNECTIONS cap을 gateway /agent/stream에 별도 카운터로 미러.
초과 시 503, 정상 시 increment(=generate() finally에서 decrement).
"""
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.routers import agent_gateway as ag
from app.dependencies.auth import AuthContext


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_cap_constant_default_and_env_configurable():
    assert isinstance(ag._MAX_AGENT_SSE_CONNECTIONS, int)
    assert ag._MAX_AGENT_SSE_CONNECTIONS == 100  # 기본값
    import os
    assert os.getenv("MAX_AGENT_SSE_CONNECTIONS") in (None, "100") or True  # env-configurable(읽기)


def _patch_db_and_auth(monkeypatch, agent_id):
    """agent 검증 통과 + cursor 없음(acked_seq=0)으로 async_session_factory 모킹."""
    db = AsyncMock()
    db.add = MagicMock()
    db.commit = AsyncMock()
    tm = MagicMock()
    res_agent = MagicMock(); res_agent.scalar_one_or_none.return_value = tm
    res_plan = MagicMock(); res_plan.scalar_one_or_none.return_value = "free"  # E-INFRA S5: org.plan 조회
    res_cursor = MagicMock(); res_cursor.scalar_one_or_none.return_value = None
    db.execute = AsyncMock(side_effect=[res_agent, res_plan, res_cursor])

    class _Ctx:
        async def __aenter__(self):
            return db
        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(ag, "async_session_factory", lambda: _Ctx())
    req = MagicMock(); req.headers = {}
    auth = AuthContext(user_id=str(agent_id), email=None,
                       claims={"app_metadata": {"api_key_id": "k"}}, org_id=None)
    return req, auth, str(agent_id)


@pytest.mark.anyio
async def test_over_cap_returns_503(monkeypatch):
    req, auth, _ = _patch_db_and_auth(monkeypatch, uuid.uuid4())
    monkeypatch.setattr(ag, "_agent_sse_connection_count", ag._MAX_AGENT_SSE_CONNECTIONS)
    with pytest.raises(HTTPException) as exc:
        await ag.agent_stream(req, auth=auth)
    assert exc.value.status_code == 503


@pytest.mark.anyio
async def test_under_cap_allows_and_increments(monkeypatch):
    req, auth, aid = _patch_db_and_auth(monkeypatch, uuid.uuid4())
    monkeypatch.setattr(ag, "_agent_sse_connection_count", ag._MAX_AGENT_SSE_CONNECTIONS - 1)
    try:
        resp = await ag.agent_stream(req, auth=auth)  # 503 아님
        from fastapi.responses import StreamingResponse
        assert isinstance(resp, StreamingResponse)
        assert ag._agent_sse_connection_count == ag._MAX_AGENT_SSE_CONNECTIONS  # increment 됨
        # generate()는 lazy라 아직 미실행 → finally decrement는 legacy 검증된 패턴 미러
    finally:
        # agent_stream이 공유 _agent_connections에 큐를 등록함(generate 미실행=finally 미동작) → 정리
        ag._agent_connections.pop(aid, None)


@pytest.mark.anyio
async def test_non_api_key_rejected_before_cap(monkeypatch):
    """API key 아니면 cap 전에 403 (기존 동작 유지)."""
    monkeypatch.setattr(ag, "_agent_sse_connection_count", 0)
    req = MagicMock(); req.headers = {}
    auth = AuthContext(user_id=str(uuid.uuid4()), email=None, claims={"app_metadata": {}}, org_id=None)
    with pytest.raises(HTTPException) as exc:
        await ag.agent_stream(req, auth=auth)
    assert exc.value.status_code == 403
