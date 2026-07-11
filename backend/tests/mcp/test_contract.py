"""S3-6: 시스템 콜 계약 검증 — 93개 도구 등록 + 스키마 무결성 (Phase 3 완료).

E-SECURITY SEC-S1(확장): delete_story/task/epic/doc 4종 제거(에이전트 hard-delete 차단) —
98개 → story만 제거해 97 → task/epic/doc 3종 추가 제거해 94. E-SECURITY SEC-S8(확장):
delete_sprint 제거 — 94 → 93. (prod 선택승격: E-CANVAS create_artifact/get_artifact 미포함이라
develop의 95와 다름 — 이 브랜치 스코프 기준 정확한 카운트.)"""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
os.environ.setdefault("AGENT_API_KEY", "sk_test")

from sprintable_mcp.server import mcp  # noqa: E402

_TOOLS: dict = mcp._tool_manager._tools

EXPECTED_TOOLS = {
    # stories (7) — E-SECURITY SEC-S1: delete_story 의도적 제거(에이전트 hard-delete 차단)
    "sprintable_list_stories", "sprintable_list_backlog", "sprintable_add_story",
    "sprintable_update_story",
    "sprintable_assign_story_to_sprint", "sprintable_unassign_story_from_sprint",
    "sprintable_update_story_status",
    # tasks (6) — E-SECURITY SEC-S1(확장): delete_task 의도적 제거(에이전트 hard-delete 차단)
    "sprintable_list_tasks", "sprintable_list_my_tasks", "sprintable_get_task",
    "sprintable_add_task", "sprintable_update_task", "sprintable_update_task_status",
    # epics (3) — E-SECURITY SEC-S1(확장): delete_epic 의도적 제거(에이전트 hard-delete 차단)
    "sprintable_list_epics", "sprintable_add_epic", "sprintable_update_epic",
    # hypotheses (6) — E1-S5
    "sprintable_list_hypotheses", "sprintable_get_hypothesis", "sprintable_create_hypothesis",
    "sprintable_update_hypothesis", "sprintable_link_hypothesis", "sprintable_confirm_hypothesis",
    # sprints (7) — E-SECURITY SEC-S8(확장): delete_sprint 의도적 제거(에이전트 hard-delete 차단)
    "sprintable_list_sprints", "sprintable_sprint_summary", "sprintable_activate_sprint",
    "sprintable_close_sprint", "sprintable_get_velocity", "sprintable_create_sprint",
    "sprintable_update_sprint",
    # docs (5) — E-SECURITY SEC-S1(확장): delete_doc 의도적 제거(에이전트 삭제 차단)
    "sprintable_list_docs", "sprintable_get_doc", "sprintable_search_docs",
    "sprintable_create_doc", "sprintable_update_doc",
    # analytics (11)
    "sprintable_get_project_overview", "sprintable_get_member_workload",
    "sprintable_get_sprint_velocity_history", "sprintable_search_stories",
    "sprintable_get_blocked_stories", "sprintable_get_unassigned_stories",
    "sprintable_get_overdue_tasks", "sprintable_get_recent_activity",
    "sprintable_get_epic_progress", "sprintable_get_agent_stats",
    "sprintable_get_project_health",
    # core (2)
    "sprintable_list_team_members", "sprintable_my_dashboard",
    # chat (3)
    "sprintable_send_chat_message", "sprintable_create_conversation", "sprintable_list_chat_messages",
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
    # stories extended (2)
    "sprintable_claim_story", "sprintable_unclaim_story",
    # webhooks (3)
    "sprintable_list_webhook_configs", "sprintable_upsert_webhook_config", "sprintable_delete_webhook_config",
    # workflow (1)
    "sprintable_get_workflow_guide",
    # loops (1) — E-LOOP-LEDGER P1-S12
    "sprintable_get_loop_context",
    # file locks (2)
    "sprintable_lock_files", "sprintable_unlock_files",
    # a2a HITL writer (1) — E-A2A-완성 S-A3
    "sprintable_link_gate_to_task",
    # evidence (1) — E-VERIFY V0-S1
    "sprintable_add_evidence",
    # smoke
    "ping",
}


def test_total_tool_count():
    assert len(_TOOLS) == 93


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
    "sprintable_list_meetings",
    "sprintable_list_retro_sessions",
])
def test_org_id_not_in_schema_project_id_optional(tool_name: str):
    """org_id는 context 자동 주입 — 스키마 비노출. project_id는 85429ee0 후 **선택적 per-call override**
    로 스키마에 노출(org-agent 멀티프로젝트 grant 타겟팅·미지정 시 키 default·무회귀)."""
    schema = _TOOLS[tool_name].parameters
    schema_str = str(schema)
    assert "org_id" not in schema_str           # org 는 여전히 context 주입
    assert "project_id" in schema_str           # 85429ee0: per-call override 로 노출
    # required 아님(optional·미지정 시 default project)
    required = schema.get("required", []) if isinstance(schema, dict) else []
    assert "project_id" not in required


@pytest.mark.parametrize("tool_name,optional_field", [
    ("sprintable_list_stories", "sprint_id"),
    ("sprintable_list_stories", "epic_id"),
    ("sprintable_list_stories", "status"),
    ("sprintable_list_sprints", "status"),
    ("sprintable_add_story", "description"),
    ("sprintable_create_sprint", "start_date"),
    ("sprintable_create_doc", "content"),
    ("sprintable_list_meetings", "meeting_type"),
    ("sprintable_create_meeting", "date"),
    ("sprintable_check_notifications", "unread"),
    ("sprintable_emit_event", "model"),
    ("sprintable_emit_event", "story_id"),
    ("sprintable_get_leaderboard_v2", "period"),
])
def test_optional_fields_have_null_default(tool_name: str, optional_field: str):
    """Optional 필드는 required에 포함되지 않고 default=null을 가져야 한다.

    flat schema(top-level properties)와 $defs 래핑 스키마 양쪽 지원.
    """
    schema = _TOOLS[tool_name].parameters
    # flat schema: properties at top level
    flat_props = schema.get("properties", {})
    if optional_field in flat_props:
        field_schema = flat_props[optional_field]
        assert field_schema.get("default") is None, \
            f"{tool_name}.{optional_field} default should be None"
        required = schema.get("required", [])
        assert optional_field not in required, \
            f"{tool_name}.{optional_field} should not be in required"
        return
    # $defs-wrapped schema (legacy fallback)
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


@pytest.mark.parametrize("tool_name", [
    "sprintable_list_stories",
    "sprintable_list_tasks",
    "sprintable_list_sprints",
    "sprintable_check_notifications",
])
def test_flat_schema_no_args_wrapper(tool_name: str):
    """S4-2: 도구 스키마가 args 래핑 없이 top-level properties를 가져야 한다."""
    schema = _TOOLS[tool_name].parameters
    assert "args" not in schema.get("properties", {}), \
        f"{tool_name}: 'args' wrapper detected in schema — flat params required"
    assert schema.get("properties") is not None, \
        f"{tool_name}: schema has no top-level properties"
