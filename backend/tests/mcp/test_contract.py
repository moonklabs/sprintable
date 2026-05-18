"""S2-5: 시스템 콜 계약 검증 — 34개 도구 등록 + 스키마 무결성."""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
os.environ.setdefault("AGENT_API_KEY", "sk_test")

from sprintable_mcp.server import mcp  # noqa: E402

_TOOLS: dict = mcp._tool_manager._tools

EXPECTED_TOOLS = {
    # stories (8)
    "sprintable_list_stories", "sprintable_list_backlog", "sprintable_add_story",
    "sprintable_update_story", "sprintable_delete_story",
    "sprintable_assign_story_to_sprint", "sprintable_unassign_story_from_sprint",
    "sprintable_update_story_status",
    # tasks (7)
    "sprintable_list_tasks", "sprintable_list_my_tasks", "sprintable_get_task",
    "sprintable_add_task", "sprintable_update_task", "sprintable_update_task_status",
    "sprintable_delete_task",
    # epics (4)
    "sprintable_list_epics", "sprintable_add_epic", "sprintable_update_epic",
    "sprintable_delete_epic",
    # sprints (8)
    "sprintable_list_sprints", "sprintable_sprint_summary", "sprintable_activate_sprint",
    "sprintable_close_sprint", "sprintable_get_velocity", "sprintable_create_sprint",
    "sprintable_update_sprint", "sprintable_delete_sprint",
    # docs (6)
    "sprintable_list_docs", "sprintable_get_doc", "sprintable_search_docs",
    "sprintable_create_doc", "sprintable_update_doc", "sprintable_delete_doc",
    # smoke
    "ping",
}


def test_total_tool_count():
    assert len(_TOOLS) == 34


def test_all_expected_tools_registered():
    registered = set(_TOOLS.keys())
    missing = EXPECTED_TOOLS - registered
    assert not missing, f"미등록 도구: {missing}"


@pytest.mark.parametrize("tool_name", [
    "sprintable_list_stories",
    "sprintable_list_tasks",
    "sprintable_list_epics",
    "sprintable_list_sprints",
    "sprintable_list_docs",
])
def test_project_id_not_in_schema(tool_name: str):
    """project_id/org_id는 context 자동 주입 — 스키마에 노출 금지."""
    schema = _TOOLS[tool_name].parameters
    schema_str = str(schema)
    assert "project_id" not in schema_str
    assert "org_id" not in schema_str


@pytest.mark.parametrize("tool_name,optional_field", [
    ("sprintable_list_stories", "sprint_id"),
    ("sprintable_list_stories", "epic_id"),
    ("sprintable_list_stories", "status"),
    ("sprintable_list_sprints", "status"),
    ("sprintable_add_story", "description"),
    ("sprintable_create_sprint", "start_date"),
    ("sprintable_create_doc", "content"),
])
def test_optional_fields_have_null_default(tool_name: str, optional_field: str):
    """Optional 필드는 required에 포함되지 않고 default=null을 가져야 한다."""
    schema = _TOOLS[tool_name].parameters
    defs = schema.get("$defs", {})
    for model_schema in defs.values():
        props = model_schema.get("properties", {})
        if optional_field in props:
            field_schema = props[optional_field]
            assert field_schema.get("default") is None, \
                f"{tool_name}.{optional_field} default should be None"
            required = model_schema.get("required", [])
            assert optional_field not in required, \
                f"{tool_name}.{optional_field} should not be in required"
            return
    pytest.fail(f"{optional_field} not found in {tool_name} schema")


def test_ping_tool_exists():
    assert "ping" in _TOOLS
