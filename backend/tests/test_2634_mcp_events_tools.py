"""story #2634 — MCP `sprintable_publish_event`/`sprintable_list_event_definitions`.

배선(순수 배선, 신규 백엔드 로직 없음): publish_event → POST /api/v2/events/publish(#2633),
list_event_definitions → GET /api/v2/events/definitions(#2634 백엔드 축, test_2634_event_
definitions_list.py가 실DB로 이미 검증). 여기선 MCP 레이어(입력 스키마·client 호출 배선·
에러 노출·toolset 그룹 분류·양쪽 SSOT 동기화·미선언 인자 거부)만 검증한다.

⚠️sprintable_emit_event(에이전트 런 텔레메트리, POST /api/v2/agent-runs)와는 별개 도구 —
이름에 "event"가 겹쳐도 두 도구는 서로 다른 API를 친다(test_no_naming_confusion_with_emit_event
가 이 사실 자체를 회귀 고정).
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── 배선(client 호출) ──────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_publish_event_posts_to_publish_endpoint():
    from sprintable_mcp.tools.events import PublishEventInput, publish_event

    calls: list[tuple[str, dict | None]] = []

    async def fake_post(path, json=None):
        calls.append((path, json))
        return {"conversation_id": "c1", "message_id": "m1"}

    with patch("sprintable_mcp.tools.events.client") as mock_client:
        mock_client.post = AsyncMock(side_effect=fake_post)
        out = await publish_event(PublishEventInput(
            definition_key="preset.work.assigned", payload={"work_item_type": "story"},
        ))

    assert calls == [("/api/v2/events/publish", {
        "definition_key": "preset.work.assigned", "payload": {"work_item_type": "story"},
    })]
    parsed = json.loads(out[0].text)
    assert parsed == {"conversation_id": "c1", "message_id": "m1"}


@pytest.mark.anyio
async def test_publish_event_includes_extra_broadcast_ids_when_given():
    from sprintable_mcp.tools.events import PublishEventInput, publish_event

    calls: list[tuple[str, dict | None]] = []

    async def fake_post(path, json=None):
        calls.append((path, json))
        return {}

    with patch("sprintable_mcp.tools.events.client") as mock_client:
        mock_client.post = AsyncMock(side_effect=fake_post)
        await publish_event(PublishEventInput(
            definition_key="preset.goal.measured", payload={"goal_id": "g1"},
            extra_broadcast_member_ids=["m1", "m2"],
        ))

    assert calls[0][1]["extra_broadcast_member_ids"] == ["m1", "m2"]


@pytest.mark.anyio
async def test_publish_event_omits_extra_broadcast_key_when_not_given():
    from sprintable_mcp.tools.events import PublishEventInput, publish_event

    calls: list[tuple[str, dict | None]] = []

    async def fake_post(path, json=None):
        calls.append((path, json))
        return {}

    with patch("sprintable_mcp.tools.events.client") as mock_client:
        mock_client.post = AsyncMock(side_effect=fake_post)
        await publish_event(PublishEventInput(definition_key="preset.gate.verdict", payload={}))

    assert "extra_broadcast_member_ids" not in calls[0][1]


@pytest.mark.anyio
async def test_publish_event_error_surfaces():
    from sprintable_mcp.tools.events import PublishEventInput, publish_event

    with patch("sprintable_mcp.tools.events.client") as mock_client:
        mock_client.post = AsyncMock(side_effect=Exception("invalid_payload: bad payload"))
        out = await publish_event(PublishEventInput(definition_key="preset.x", payload={}))

    assert "error" in out[0].text.lower()
    assert "invalid_payload" in out[0].text


@pytest.mark.anyio
async def test_list_event_definitions_calls_definitions_endpoint():
    from sprintable_mcp.tools.events import ListEventDefinitionsInput, list_event_definitions

    calls: list[str] = []

    async def fake_get(path, params=None):
        calls.append(path)
        return [{"key": "preset.work.assigned", "enabled": True}]

    with patch("sprintable_mcp.tools.events.client") as mock_client:
        mock_client.get = AsyncMock(side_effect=fake_get)
        out = await list_event_definitions(ListEventDefinitionsInput())

    assert calls == ["/api/v2/events/definitions"]
    parsed = json.loads(out[0].text)
    assert parsed == [{"key": "preset.work.assigned", "enabled": True}]


@pytest.mark.anyio
async def test_list_event_definitions_error_surfaces():
    from sprintable_mcp.tools.events import ListEventDefinitionsInput, list_event_definitions

    with patch("sprintable_mcp.tools.events.client") as mock_client:
        mock_client.get = AsyncMock(side_effect=Exception("401 Unauthorized"))
        out = await list_event_definitions(ListEventDefinitionsInput())

    assert "error" in out[0].text.lower()


# ─── SprintableInput 계약(defense-in-depth) ─────────────────────────────────

def test_publish_event_input_rejects_unknown_field_direct_construction():
    from pydantic import ValidationError
    from sprintable_mcp.tools.events import PublishEventInput

    with pytest.raises(ValidationError):
        PublishEventInput(definition_key="k", payload={}, totally_bogus_arg=1)


def test_list_event_definitions_input_rejects_unknown_field_direct_construction():
    from pydantic import ValidationError
    from sprintable_mcp.tools.events import ListEventDefinitionsInput

    with pytest.raises(ValidationError):
        ListEventDefinitionsInput(totally_bogus_arg=1)


# ─── 미선언 인자 거부 — 실제 MCP 호출 경로(Tool.run(), story #2412 AC2와 동형 계약) ──────

@pytest.mark.anyio
async def test_registered_publish_event_tool_rejects_unknown_arg():
    from mcp.server.fastmcp.exceptions import ToolError
    from sprintable_mcp import server as srv

    tool = srv.mcp._tool_manager.get_tool("sprintable_publish_event")
    with pytest.raises(ToolError) as ei:
        await tool.run({"definition_key": "k", "payload": {}, "totally_bogus_arg": 1})
    msg = str(ei.value)
    assert "totally_bogus_arg" in msg


@pytest.mark.anyio
async def test_registered_list_event_definitions_tool_rejects_unknown_arg():
    from mcp.server.fastmcp.exceptions import ToolError
    from sprintable_mcp import server as srv

    tool = srv.mcp._tool_manager.get_tool("sprintable_list_event_definitions")
    with pytest.raises(ToolError) as ei:
        await tool.run({"totally_bogus_arg": 1})
    msg = str(ei.value)
    assert "totally_bogus_arg" in msg


# ─── 등록 + 그룹 분류 + 양쪽 SSOT 동기화 ─────────────────────────────────────────

def test_both_tools_registered_in_mcp_server():
    from sprintable_mcp.server import _TOOL_DEFS

    names = {name for name, *_ in _TOOL_DEFS}
    assert "sprintable_publish_event" in names
    assert "sprintable_list_event_definitions" in names


def test_no_naming_confusion_with_emit_event():
    """sprintable_emit_event(agent_runs.py)는 POST /api/v2/agent-runs를 친다 — publish_event와
    무관한 개념임을 회귀 고정(둘 다 이름에 event가 있어 혼동하기 쉽다)."""
    from sprintable_mcp.tools.agent_runs import emit_event
    from sprintable_mcp.tools.events import publish_event

    assert emit_event is not publish_event


def test_tools_classified_into_events_group_not_admin():
    from app.services.mcp_toolset import tool_group as backend_tool_group
    from sprintable_mcp.toolset import tool_group as vendored_tool_group

    for name in ("sprintable_publish_event", "sprintable_list_event_definitions"):
        assert backend_tool_group(name) == "events"
        assert vendored_tool_group(name) == "events"


def test_emit_event_group_unaffected_by_new_events_group():
    """"events" 그룹 신설이 admin 키워드 "emit_event"의 기존 분류를 깨지 않는다는 것을
    직접 확認(순서 의존 버그 — events를 admin보다 앞에 두면 emit_event가 깨진다)."""
    from app.services.mcp_toolset import tool_group as backend_tool_group
    from sprintable_mcp.toolset import tool_group as vendored_tool_group

    assert backend_tool_group("sprintable_emit_event") == "admin"
    assert vendored_tool_group("sprintable_emit_event") == "admin"


def test_events_group_not_grantable_without_explicit_scope():
    from app.services.mcp_toolset import is_tool_allowed

    narrow_scope = ["stories", "tasks", "chat"]
    assert is_tool_allowed("sprintable_publish_event", narrow_scope) is False
    assert is_tool_allowed("sprintable_list_event_definitions", narrow_scope) is False


def test_events_group_allowed_with_explicit_scope():
    from app.services.mcp_toolset import is_tool_allowed

    assert is_tool_allowed("sprintable_publish_event", ["events"]) is True
    assert is_tool_allowed("sprintable_list_event_definitions", ["events"]) is True


def test_all_tool_names_includes_both_new_tools():
    """#2010/#1922 전례(ALL_TOOL_NAMES 등록 누락 → picker/치트시트 누락) 재발 방지 — 최초
    커밋부터 등록."""
    from app.services.mcp_toolset import ALL_TOOL_NAMES

    assert "sprintable_publish_event" in ALL_TOOL_NAMES
    assert "sprintable_list_event_definitions" in ALL_TOOL_NAMES
