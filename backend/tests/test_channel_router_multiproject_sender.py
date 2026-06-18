"""채널 라우터 회귀 — org-agent 멀티프로젝트 sender 가 team_members VIEW 다중 행을 내도
route_message 가 MultipleResultsFound 로 안 깨지고 dispatch 되는지(sender_type 쿼리 .limit(1)).

배경: team_members 는 0088 이후 projection VIEW. org-agent 멀티프로젝트 grant(project_access)면
같은 member.id 가 프로젝트 수만큼 행 → sender_type 의 무필터 scalar_one_or_none 이 MultipleResultsFound
→ route_message 전체가 ChannelRouterError 로 깨져 chat→agent dispatch 정지. .limit(1) 로 봉합.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _scalar(val):
    r = MagicMock()
    r.scalar_one_or_none.return_value = val
    return r


def _scalars(items):
    r = MagicMock()
    r.scalars.return_value.all.return_value = items
    return r


def _all(rows):
    r = MagicMock()
    r.all.return_value = rows
    return r


@pytest.mark.anyio
async def test_multiproject_agent_sender_dispatches_without_crash():
    """멀티프로젝트 agent 발신 → sender_type .limit(1)='agent' → agent↔agent SSE dispatch(크래시 0)."""
    from app.services.channel_router import route_message

    sender = uuid.uuid4()       # 멀티프로젝트 agent(team_members 뷰 다중행)
    recipient = uuid.uuid4()    # agent 수신자
    conv = uuid.uuid4()
    proj = uuid.uuid4()

    msg = MagicMock()
    msg.id = uuid.uuid4()
    msg.sender_id = sender
    msg.conversation_id = conv
    msg.thread_id = None

    db = MagicMock()
    db.execute = AsyncMock(side_effect=[
        _scalar(msg),                       # 1 메시지
        _scalar("agent"),                   # 2 sender_type — .limit(1)로 단일 행(뷰 다중에도 안전)
        _scalars([sender, recipient]),      # 3 participants(발신자 포함)
        _all([(recipient, "agent")]),       # 4 수신자 type 배치
        _scalar(proj),                      # 5 conv project_id
        _scalars([]),                       # 6 preferences
    ])

    decisions = await route_message(msg.id, db)
    # 발신자 제외·agent↔agent 강제 SSE → 1 decision(크래시/ChannelRouterError 없이)
    assert len(decisions) == 1
    assert decisions[0].member_id == recipient
    assert decisions[0].channel == "sse"
    assert decisions[0].reason == "agent-to-agent forced sse"
