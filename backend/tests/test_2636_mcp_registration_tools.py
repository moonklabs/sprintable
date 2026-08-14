"""story #2636(P1b) — MCP sprintable_register_event_definition/sprintable_update_event_definition.

배선(순수 배선, 신규 백엔드 로직 없음): register → POST /api/v2/events/definitions,
update → PATCH /api/v2/events/definitions/{id}. 여기선 MCP 레이어(입력 스키마·client 호출
배선·admin 그룹 분류·미선언 인자 거부)만 검증 — 백엔드 축(gate 3종 소비·soft delete·version
범프)은 test_2636_custom_event_registration.py가 실DB로 이미 검증했다.
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_register_event_definition_posts_to_definitions_endpoint():
    from sprintable_mcp.tools.events import RegisterEventDefinitionInput, register_event_definition

    calls: list[tuple[str, dict | None]] = []

    async def fake_post(path, json=None):
        calls.append((path, json))
        return {"id": "d1", "key": "org.acme.widget.made"}

    with patch("sprintable_mcp.tools.events.client") as mock_client:
        mock_client.post = AsyncMock(side_effect=fake_post)
        out = await register_event_definition(RegisterEventDefinitionInput(
            key="org.acme.widget.made",
            payload_schema={"type": "object", "additionalProperties": False},
            routing={
                "escalation": {"kind": "server_derived", "target": "none"},
                "broadcast": {"kind": "server_derived", "target": "none"},
            },
        ))

    assert calls[0][0] == "/api/v2/events/definitions"
    assert calls[0][1]["key"] == "org.acme.widget.made"
    parsed = json.loads(out[0].text)
    assert parsed["id"] == "d1"


@pytest.mark.anyio
async def test_register_event_definition_error_surfaces():
    from sprintable_mcp.tools.events import RegisterEventDefinitionInput, register_event_definition

    with patch("sprintable_mcp.tools.events.client") as mock_client:
        mock_client.post = AsyncMock(side_effect=Exception("invalid_definition: bad key"))
        out = await register_event_definition(RegisterEventDefinitionInput(
            key="bad", payload_schema={}, routing={},
        ))
    assert "error" in out[0].text.lower()


@pytest.mark.anyio
async def test_update_event_definition_patches_by_id_only_provided_fields():
    from sprintable_mcp.tools.events import UpdateEventDefinitionInput, update_event_definition

    calls: list[tuple[str, dict | None]] = []

    async def fake_patch(path, json=None):
        calls.append((path, json))
        return {"id": "d1", "enabled": False}

    with patch("sprintable_mcp.tools.events.client") as mock_client:
        mock_client.patch = AsyncMock(side_effect=fake_patch)
        await update_event_definition(UpdateEventDefinitionInput(definition_id="d1", enabled=False))

    assert calls[0][0] == "/api/v2/events/definitions/d1"
    assert calls[0][1] == {"enabled": False}


@pytest.mark.anyio
async def test_update_event_definition_error_surfaces():
    from sprintable_mcp.tools.events import UpdateEventDefinitionInput, update_event_definition

    with patch("sprintable_mcp.tools.events.client") as mock_client:
        mock_client.patch = AsyncMock(side_effect=Exception("404 not found"))
        out = await update_event_definition(UpdateEventDefinitionInput(definition_id="ghost"))
    assert "error" in out[0].text.lower()


# ─── SprintableInput 계약(defense-in-depth) ─────────────────────────────────

def test_register_input_rejects_unknown_field_direct_construction():
    from pydantic import ValidationError
    from sprintable_mcp.tools.events import RegisterEventDefinitionInput

    with pytest.raises(ValidationError):
        RegisterEventDefinitionInput(key="k", payload_schema={}, routing={}, totally_bogus_arg=1)


def test_update_input_rejects_unknown_field_direct_construction():
    from pydantic import ValidationError
    from sprintable_mcp.tools.events import UpdateEventDefinitionInput

    with pytest.raises(ValidationError):
        UpdateEventDefinitionInput(definition_id="d1", totally_bogus_arg=1)


# ─── 미선언 인자 거부 — 실제 MCP 호출 경로(Tool.run()) ──────────────────────────

@pytest.mark.anyio
async def test_registered_register_tool_rejects_unknown_arg():
    from mcp.server.fastmcp.exceptions import ToolError
    from sprintable_mcp import server as srv

    tool = srv.mcp._tool_manager.get_tool("sprintable_register_event_definition")
    with pytest.raises(ToolError) as ei:
        await tool.run({"key": "k", "payload_schema": {}, "routing": {}, "totally_bogus_arg": 1})
    assert "totally_bogus_arg" in str(ei.value)


@pytest.mark.anyio
async def test_registered_update_tool_rejects_unknown_arg():
    from mcp.server.fastmcp.exceptions import ToolError
    from sprintable_mcp import server as srv

    tool = srv.mcp._tool_manager.get_tool("sprintable_update_event_definition")
    with pytest.raises(ToolError) as ei:
        await tool.run({"definition_id": "d1", "totally_bogus_arg": 1})
    assert "totally_bogus_arg" in str(ei.value)


# ─── 등록 + admin 그룹 분류 + 양쪽 SSOT 동기화 ────────────────────────────────

def test_both_tools_registered_in_mcp_server():
    from sprintable_mcp.server import _TOOL_DEFS

    names = {name for name, *_ in _TOOL_DEFS}
    assert "sprintable_register_event_definition" in names
    assert "sprintable_update_event_definition" in names


def test_tools_classified_into_admin_group_not_events():
    """등록/수정은 admin 그룹(§범위5) — 발행/조회(events 그룹)와 분리."""
    from app.services.mcp_toolset import tool_group as backend_tool_group
    from sprintable_mcp.toolset import tool_group as vendored_tool_group

    for name in ("sprintable_register_event_definition", "sprintable_update_event_definition"):
        assert backend_tool_group(name) == "admin"
        assert vendored_tool_group(name) == "admin"


def test_publish_and_list_still_classified_into_events_group():
    """admin 튜플에 새 키워드를 추가해도 publish/list(events 그룹) 분류가 안 깨지는지 —
    순서 의존 회귀 가드(register/update 키워드가 emit_event 처럼 events 매치를 가로채면
    안 된다는 원칙과 동형, 이번엔 반대 방향: events 매치가 register/update를 가로채면 안
    된다는 것도 이미 위 test로 확認됐고, 여기선 그 역방향 무회귀)."""
    from app.services.mcp_toolset import tool_group as backend_tool_group
    from sprintable_mcp.toolset import tool_group as vendored_tool_group

    for name in ("sprintable_publish_event", "sprintable_list_event_definitions"):
        assert backend_tool_group(name) == "events"
        assert vendored_tool_group(name) == "events"


def test_emit_event_group_unaffected():
    from app.services.mcp_toolset import tool_group as backend_tool_group
    from sprintable_mcp.toolset import tool_group as vendored_tool_group

    assert backend_tool_group("sprintable_emit_event") == "admin"
    assert vendored_tool_group("sprintable_emit_event") == "admin"


def test_registration_tools_require_admin_scope():
    from app.services.mcp_toolset import is_tool_allowed

    assert is_tool_allowed("sprintable_register_event_definition", ["events"]) is False
    assert is_tool_allowed("sprintable_register_event_definition", ["admin"]) is True
    assert is_tool_allowed("sprintable_update_event_definition", ["events"]) is False
    assert is_tool_allowed("sprintable_update_event_definition", ["admin"]) is True


def test_all_tool_names_includes_registration_tools():
    from app.services.mcp_toolset import ALL_TOOL_NAMES

    assert "sprintable_register_event_definition" in ALL_TOOL_NAMES
    assert "sprintable_update_event_definition" in ALL_TOOL_NAMES
