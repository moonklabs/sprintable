"""광역 sweep 회귀 — team_members projection VIEW 다중행(org-agent 멀티프로젝트 grant)에서
TeamMember.id == X scalar_one_or_none 이 MultipleResultsFound 로 안 깨지게 .limit(1) 가드.

Ⓐ 분류(identity/type/org_id 동형 소비 → .limit(1) 안전·아무 projection 행 OK):
  - channel._resolve_agent          (.org_id 소비)
  - agent_gateway.agent_stream      (.org_id 소비·agent CONNECT 경로)
  - agent_runs.create_agent_run     (select org_id)
  - ws_chat._authenticate           (auth identity)

#1579(channel_router.route_message sender_type)와 동일 패턴의 잔여 site 봉쇄.
project_id 를 소비하는 Ⓑ(agent_inbox/ws_chat room init)는 컨텍스트-derive 가 정답이라 별도 처리.
"""
from __future__ import annotations

import inspect
import uuid
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── Ⓐ 4 site 소스 가드: TeamMember.id 쿼리에 .limit(1) 유지 ──────────────────────
def _get_func():
    from app.routers import agent_gateway, agent_runs, channel, ws_chat

    return {
        "channel._resolve_agent": channel._resolve_agent,
        "agent_gateway.agent_stream": agent_gateway.agent_stream,
        "agent_runs.create_agent_run": agent_runs.create_agent_run,
        "ws_chat._authenticate": ws_chat._authenticate,
    }


@pytest.mark.parametrize("name", [
    "channel._resolve_agent",
    "agent_gateway.agent_stream",
    "agent_runs.create_agent_run",
    "ws_chat._authenticate",
])
def test_teammember_query_has_limit_guard(name: str):
    """각 Ⓐ 함수 소스에 TeamMember 쿼리 + .limit(1) 동시 존재(가드 제거 회귀 방지)."""
    fn = _get_func()[name]
    src = inspect.getsource(fn)
    assert "TeamMember" in src, f"{name}: TeamMember 쿼리 사라짐(테스트 갱신 필요)"
    assert ".limit(1)" in src, f"{name}: .limit(1) 가드 누락 — 멀티프로젝트 agent 크래시 회귀"


# ── 행동 테스트: 멀티프로젝트 agent(뷰 N행)도 _resolve_agent 가 크래시 없이 해소 ──────
@pytest.mark.anyio
async def test_resolve_agent_multiproject_no_crash():
    """멀티프로젝트 agent → .limit(1) 로 단일 행 → org 검증 통과(MultipleResultsFound 0)."""
    from app.routers import channel

    agent = MagicMock()
    agent.org_id = "ORG"
    agent.type = "agent"
    caller = MagicMock()
    caller.org_id = "ORG"

    class _Result:
        def scalar_one_or_none(self):
            return agent  # .limit(1) 결과(뷰 N행이어도 1행)

    class _DB:
        async def execute(self, *a, **k):
            return _Result()

    class _Factory:
        async def __aenter__(self):
            return _DB()

        async def __aexit__(self, *a):
            return False

    with patch.object(channel, "async_session_factory", lambda: _Factory()):
        result = await channel._resolve_agent(uuid.uuid4(), caller)

    assert result is agent  # 해소 성공·org 동형 검증 통과
