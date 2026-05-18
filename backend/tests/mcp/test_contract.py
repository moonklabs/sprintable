"""S3-6: 시스템 콜 계약 검증 — 88개 도구 등록 + 스키마 무결성 (Phase 3 완료)."""
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
    # analytics (11)
    "sprintable_get_project_overview", "sprintable_get_member_workload",
    "sprintable_get_sprint_velocity_history", "sprintable_search_stories",
    "sprintable_get_blocked_stories", "sprintable_get_unassigned_stories",
    "sprintable_get_overdue_tasks", "sprintable_get_recent_activity",
    "sprintable_get_epic_progress", "sprintable_get_agent_stats",
    "sprintable_get_project_health",
    # core (2)
    "sprintable_list_team_members", "sprintable_my_dashboard",
    # memos + chat (10)
    "sprintable_list_memos", "sprintable_create_memo", "sprintable_send_memo",
    "sprintable_list_my_memos", "sprintable_read_memo", "sprintable_reply_memo",
    "sprintable_resolve_memo", "sprintable_send_chat_message",
    "sprintable_create_conversation", "sprintable_list_chat_messages",
    # meetings (6)
    "sprintable_list_meetings", "sprintable_get_meeting", "sprintable_create_meeting",
    "sprintable_update_meeting", "sprintable_delete_meeting", "sprintable_trigger_ai_summary",
    # standup (8)
    "sprintable_standup_missing", "sprintable_standup_history", "sprintable_get_standup",
    "sprintable_save_standup", "sprintable_list_standup_entries",
    "sprintable_get_retro_session_by_sprint", "sprintable_update_retro_action_status",
    "sprintable_checkin_sprint",
    # retro (7)
    "sprintable_list_retro_sessions", "sprintable_create_retro_session",
    "sprintable_vote_retro_item", "sprintable_add_retro_action",
    "sprintable_change_retro_phase", "sprintable_add_retro_item", "sprintable_export_retro",
    # rewards (3)
    "sprintable_get_wallet", "sprintable_give_reward", "sprintable_get_leaderboard_v2",
    # notifications (3)
    "sprintable_check_notifications", "sprintable_mark_notification_read",
    "sprintable_mark_all_notifications_read",
    # audit (1)
    "sprintable_list_audit_logs",
    # agent_runs (3)
    "sprintable_emit_event", "sprintable_update_run_status", "sprintable_poll_events",
    # smoke
    "ping",
}


def test_total_tool_count():
    assert len(_TOOLS) == 88


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
    "sprintable_list_memos",
    "sprintable_list_meetings",
    "sprintable_list_retro_sessions",
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
    ("sprintable_list_memos", "assigned_to"),
    ("sprintable_list_memos", "status"),
    ("sprintable_list_meetings", "meeting_type"),
    ("sprintable_create_meeting", "date"),
    ("sprintable_check_notifications", "unread"),
    ("sprintable_emit_event", "model"),
    ("sprintable_emit_event", "story_id"),
    ("sprintable_get_leaderboard_v2", "period"),
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
