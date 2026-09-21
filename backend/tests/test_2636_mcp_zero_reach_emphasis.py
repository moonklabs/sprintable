"""story #2636(P1b) 갭 1호 처방 — MCP sprintable_publish_event가 zero_reach_warning을
사람이 읽는 문장으로 강조하는지(JSON 필드 하나로만 묻히지 않게)."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_zero_reach_warning_prepends_human_sentence():
    from sprintable_mcp.tools.events import PublishEventInput, publish_event

    response_data = {
        "conversation_id": "c1", "message_id": "m1",
        "escalation_member_ids": [], "broadcast_member_ids": [],
        "zero_reach_warning": True,
        "warning": "발행은 성공했으나 escalation·broadcast 대상이 모두 0명입니다.",
    }
    with patch("sprintable_mcp.tools.events.client") as mock_client:
        mock_client.post = AsyncMock(return_value=response_data)
        out = await publish_event(PublishEventInput(definition_key="preset.gate.verdict", payload={}))

    text = out[0].text
    assert text.startswith("[경고]")
    assert "대상이 모두 0명" in text
    # JSON 데이터 자체도 그대로 뒤에 실려야(구조화 데이터 유실 없음).
    json_part = text.split("\n\n", 1)[1]
    assert json.loads(json_part) == response_data


@pytest.mark.anyio
async def test_normal_reach_no_warning_prefix():
    from sprintable_mcp.tools.events import PublishEventInput, publish_event

    response_data = {
        "conversation_id": "c1", "message_id": "m1",
        "escalation_member_ids": ["u1"], "broadcast_member_ids": ["u1", "u2"],
        "zero_reach_warning": False,
    }
    with patch("sprintable_mcp.tools.events.client") as mock_client:
        mock_client.post = AsyncMock(return_value=response_data)
        out = await publish_event(PublishEventInput(definition_key="preset.gate.verdict", payload={}))

    text = out[0].text
    assert not text.startswith("[경고]")
    assert json.loads(text) == response_data


@pytest.mark.anyio
async def test_human_stage_notice_prepends_안내_not_경고():
    """story #4092(§c) — 사람 역할 stage 발행은 zero_reach_warning=False + notice가 온다.
    경고와 다른 접두("[안내]")로 강조돼 에이전트가 "이건 경고가 아니다"를 즉시 구분한다."""
    from sprintable_mcp.tools.events import PublishEventInput, publish_event

    response_data = {
        "conversation_id": "c1", "message_id": "m1",
        "escalation_member_ids": [], "broadcast_member_ids": [],
        "zero_reach_warning": False,
        "notice": "이 단계는 사람이 판단해요 — 에이전트 바인딩이 필요 없어요.",
    }
    with patch("sprintable_mcp.tools.events.client") as mock_client:
        mock_client.post = AsyncMock(return_value=response_data)
        out = await publish_event(PublishEventInput(definition_key="org.acme.recipe", payload={}))

    text = out[0].text
    assert text.startswith("[안내]")
    assert not text.startswith("[경고]")
    assert "사람이 판단해요" in text
    json_part = text.split("\n\n", 1)[1]
    assert json.loads(json_part) == response_data
