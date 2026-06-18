"""회귀 — channel._persist_and_broadcast 가 ws_chat._get_or_create_conversation 을 올바른 4인자
(agent_id, caller_id, org_id, project_id)로 호출하는지.

배경: ws_chat._get_or_create_conversation 시그니처가 caller_id 추가로 4인자가 됐는데 channel 호출부가
3인자(agent_id, org_id, project_id)로 남아(한쪽만 전환) → caller_id 누락 + 인자 미스얼라인 →
/deliver·/upload 호출 시 TypeError. #1581 codex CRITICAL(pre-existing≠benign)로 적출.
"""
from __future__ import annotations

import inspect
import uuid
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_persist_passes_caller_id_to_get_or_create():
    """_persist_and_broadcast → _get_or_create_conversation(agent_id, caller.id, org_id, project_id)."""
    from app.routers import channel

    captured: dict = {}

    class _Stop(Exception):
        pass

    async def _fake_goc(*args):
        captured["args"] = args
        raise _Stop()  # 호출 직후 short-circuit — downstream(msg/broadcast) mock 불요

    agent = MagicMock()
    agent.org_id = "ORG"
    agent.project_id = "PROJ"
    caller = MagicMock()
    caller.id = "CALLER_ID"
    agent_id = uuid.uuid4()

    with patch.object(channel, "_get_or_create_conversation", _fake_goc):
        with pytest.raises(_Stop):
            await channel._persist_and_broadcast(agent_id, agent, caller, "hi")

    # 4인자·올바른 정렬: caller_id 자리에 caller.id(org_id 아님)·project_id 누락 0
    assert captured["args"] == (agent_id, "CALLER_ID", "ORG", "PROJ")


def test_call_arity_matches_callee():
    """callee 시그니처(4 위치인자)와 caller 인자수 일치 — 미스얼라인 회귀 방지."""
    from app.routers.ws_chat import _get_or_create_conversation

    params = list(inspect.signature(_get_or_create_conversation).parameters.values())
    positional = [p for p in params if p.default is inspect.Parameter.empty]
    assert len(positional) == 4, "callee 시그니처 변경 — channel 호출부도 동반 갱신 필요"


# ── is_active 정합: agent 해소 lookup 은 deactivated agent 비도달(crash 아닌 soft correctness 갭) ──
@pytest.mark.parametrize("name", [
    "ws_chat.ws_chat_hub",
    "channel._resolve_agent",
    "agent_runs.create_agent_run",
    "agent_gateway.agent_stream",
])
def test_agent_lookup_filters_is_active(name: str):
    """agent 해소 쿼리는 is_active.is_(True) 로 deactivated agent 를 배제(정합·ws_chat:46/agent_inbox 동형)."""
    from app.routers import agent_gateway, agent_runs, channel, ws_chat

    fns = {
        "ws_chat.ws_chat_hub": ws_chat.ws_chat_hub,
        "channel._resolve_agent": channel._resolve_agent,
        "agent_runs.create_agent_run": agent_runs.create_agent_run,
        "agent_gateway.agent_stream": agent_gateway.agent_stream,
    }
    src = inspect.getsource(fns[name])
    assert "is_active.is_(True)" in src, \
        f"{name}: is_active 필터 누락 — deactivated agent 도달 가능(정합 회귀)"
