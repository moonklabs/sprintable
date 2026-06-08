"""E-MCP S2: 키별 MCP toolset SSOT.

API Key의 scope(list[str])가 허용 toolset 그룹을 보유한다(별도 마이그 없이 기존 scope 재사용).
백엔드가 그룹 정의·허용 해소·매니페스트의 단일 진실원천(SSOT)이고, MCP 서버(및 다른 호출자)는
이 모듈/매니페스트로 call-time enforcement(목록 숨김 + 호출 차단)를 수행한다.

tool_name(`sprintable_<verb>_<domain>`) → group 은 명시 키워드 매핑으로 결정(파일 의존 X).
destructive(delete_*/give_reward/lock 등)는 그룹과 별개로 추가 게이팅한다.
"""
from __future__ import annotations

# ── toolset 그룹 키워드(tool 이름 부분일치, 위에서부터 우선) ──────────────────────
# 그룹: stories/tasks/sprints/epics/chat/docs/analytics/retro/standup/meetings/
#       notifications/webhooks/rewards/audit/agent_runs/admin/core
_GROUP_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("rewards", ("reward", "wallet", "leaderboard")),
    ("analytics", ("velocity", "health", "dashboard", "overview", "stats", "standup_missing",
                   "sprint_summary", "recent_activity", "agent_stats", "blocked_stories",
                   "unassigned_stories", "member_workload", "overdue", "epic_progress")),
    ("agent_runs", ("agent_run", "run_status", "update_run")),
    ("audit", ("audit",)),
    ("webhooks", ("webhook",)),
    ("notifications", ("notification",)),
    ("meetings", ("meeting",)),
    ("retro", ("retro",)),
    ("standup", ("standup",)),
    ("docs", ("doc", "search_docs")),
    ("chat", ("chat", "message", "conversation")),
    ("sprints", ("sprint",)),
    ("epics", ("epic",)),
    ("tasks", ("task",)),
    ("stories", ("story", "stories", "backlog", "claim", "checkin")),
    ("admin", ("lock", "unlock", "give_reward", "emit_event", "trigger_ai", "activate_sprint",
               "close_sprint", "delete_sprint", "create_sprint", "upsert_webhook", "delete_webhook")),
]

_CORE = "core"  # ping/notifications-check 등 기본 — 항상 허용

# 명시 비-그룹 핵심 도구(항상 허용 = picker 의 core 잠금 그룹).
# 2da32fbf(toolset-catalog): 키워드 미매칭으로 tool_group()=='core' 로 떨어지는 read-only 유틸
# (workflow_guide·team_members·poll_events)을 여기 포함 — picker 가 core(always-on)로 표시하는데
# enforcement 가 explicit scope 에서 거부하던 비정합 해소. 모두 비파괴 read 라 always-allow 안전.
_ALWAYS_ALLOWED: frozenset[str] = frozenset({
    "ping", "sprintable_ping", "sprintable_my_dashboard", "sprintable_check_notifications",
    "sprintable_get_workflow_guide", "sprintable_list_team_members", "sprintable_poll_events",
})

# scope 토큰: 그룹명 외에 read/write(레거시·전체 비파괴 의미), admin/destructive(파괴적 허용)
_LEGACY_SCOPES: frozenset[str] = frozenset({"read", "write"})
_DESTRUCTIVE_SCOPES: frozenset[str] = frozenset({"admin", "destructive"})

ALL_GROUPS: tuple[str, ...] = tuple(g for g, _ in _GROUP_KEYWORDS if g != "admin") + (_CORE,)


def tool_group(tool_name: str) -> str:
    """tool 이름 → 그룹. 매칭 없으면 'core'.

    ⚠️ 모든 도구명이 'sprintable_' 접두사를 가지며 이는 'sprint'를 포함하므로, 반드시 접두사를
    제거한 뒤 키워드 매칭한다(안 그러면 전 도구가 sprints 그룹으로 오분류).
    """
    n = tool_name.lower()
    if n.startswith("sprintable_"):
        n = n[len("sprintable_"):]
    for group, keywords in _GROUP_KEYWORDS:
        if any(k in n for k in keywords):
            return group
    return _CORE


def is_destructive(tool_name: str) -> bool:
    """파괴적/민감 도구 — 그룹과 별개로 추가 게이팅."""
    n = tool_name.lower()
    return (
        "delete" in n
        or "give_reward" in n
        or n.endswith("lock_files")
        or "unlock" in n
        or "_delete_" in n
        or n.startswith("sprintable_delete")
        or "close_sprint" in n
    )


def is_tool_allowed(tool_name: str, scope: list[str] | None) -> bool:
    """key의 scope로 tool 호출 허용 여부 판정 (call-time enforcement·매니페스트 공통).

    규칙:
    - 항상 허용 도구(_ALWAYS_ALLOWED)는 무조건 True.
    - scope 미지정/레거시(read/write만) → **모든 비파괴 그룹 허용**(back-compat), destructive는 차단.
    - scope에 그룹명 명시 → 해당 그룹만. 'admin'/'destructive' 있으면 파괴적 도구도 허용.
    """
    if tool_name in _ALWAYS_ALLOWED:
        return True

    tokens = {s.strip().lower() for s in (scope or []) if s and s.strip()}
    group = tool_group(tool_name)
    destructive = is_destructive(tool_name)

    explicit_groups = tokens & set(ALL_GROUPS) | (tokens & {"admin"})
    has_destructive_grant = bool(tokens & _DESTRUCTIVE_SCOPES)

    # 그룹 허용 판정
    if not explicit_groups:
        # 명시 그룹 없음 → 레거시(read/write) 또는 빈 scope = 전체 비파괴 허용
        group_ok = True
    else:
        group_ok = group in tokens or (group == "admin" and "admin" in tokens)

    if not group_ok:
        return False

    # destructive 추가 게이팅
    if destructive and not has_destructive_grant:
        return False
    return True


def resolve_policy(scope: list[str] | None) -> dict:
    """key scope → 정책 매니페스트(그룹 단위). 전체 tool 목록 불필요 — MCP 서버가 is_tool_allowed로
    per-tool 적용. 백엔드는 key→scope(SSOT)와 정책만 서빙."""
    tokens = {s.strip().lower() for s in (scope or []) if s and s.strip()}
    explicit = tokens & set(ALL_GROUPS)
    allowed_groups = sorted(explicit) if explicit else sorted(ALL_GROUPS)  # legacy/빈 scope = 전체 비파괴
    return {
        "scope": sorted(tokens),
        "allowed_groups": allowed_groups,
        "destructive_allowed": bool(tokens & _DESTRUCTIVE_SCOPES),
        "all_groups": sorted(ALL_GROUPS),
    }


def resolve_manifest(scope: list[str] | None, all_tool_names: list[str]) -> dict:
    """key scope + 전체 tool 목록 → 매니페스트(allowed/denied/groups/destructive)."""
    allowed = [t for t in all_tool_names if is_tool_allowed(t, scope)]
    denied = [t for t in all_tool_names if not is_tool_allowed(t, scope)]
    allowed_groups = sorted({tool_group(t) for t in allowed})
    tokens = {s.strip().lower() for s in (scope or []) if s and s.strip()}
    return {
        "allowed_tools": sorted(allowed),
        "denied_tools": sorted(denied),
        "allowed_groups": allowed_groups,
        "destructive_allowed": bool(tokens & _DESTRUCTIVE_SCOPES),
        "scope": sorted(tokens),
    }


# ── E-MCP-RIGHT S1 (2da32fbf): toolset 카탈로그 (picker 데이터 SSOT) ───────────────
# 전체 MCP 도구 이름 — sprintable_mcp `_TOOL_DEFS`(@mcp.tool 등록분)와 정합 유지.
# ⚠️ backend 는 sprintable_mcp 를 import 하지 않으므로(디탱글) 이 목록이 backend-owned SSOT.
#    도구 추가/삭제 시 여기 동기화(테스트가 그룹 커버리지·core/admin 정합 검증).
ALL_TOOL_NAMES: tuple[str, ...] = (
    "sprintable_ping",
    "sprintable_activate_sprint", "sprintable_add_epic", "sprintable_add_retro_action",
    "sprintable_add_retro_item", "sprintable_add_story", "sprintable_add_task",
    "sprintable_assign_story_to_sprint", "sprintable_change_retro_phase",
    "sprintable_check_notifications", "sprintable_checkin_sprint", "sprintable_claim_story",
    "sprintable_close_sprint", "sprintable_create_conversation", "sprintable_create_doc",
    "sprintable_create_meeting", "sprintable_create_retro_session", "sprintable_create_sprint",
    "sprintable_delete_doc", "sprintable_delete_epic", "sprintable_delete_meeting",
    "sprintable_delete_sprint", "sprintable_delete_story", "sprintable_delete_task",
    "sprintable_delete_webhook_config", "sprintable_emit_event", "sprintable_export_retro",
    "sprintable_get_agent_stats", "sprintable_get_blocked_stories", "sprintable_get_doc",
    "sprintable_get_epic_progress", "sprintable_get_leaderboard_v2", "sprintable_get_meeting",
    "sprintable_get_member_workload", "sprintable_get_overdue_tasks", "sprintable_get_project_health",
    "sprintable_get_project_overview", "sprintable_get_recent_activity",
    "sprintable_get_retro_session_by_sprint", "sprintable_get_sprint_velocity_history",
    "sprintable_get_standup", "sprintable_get_task", "sprintable_get_unassigned_stories",
    "sprintable_get_velocity", "sprintable_get_wallet", "sprintable_get_workflow_guide",
    "sprintable_give_reward", "sprintable_list_audit_logs", "sprintable_list_backlog",
    "sprintable_list_chat_messages", "sprintable_list_docs", "sprintable_list_epics",
    "sprintable_list_meetings", "sprintable_list_my_tasks", "sprintable_list_retro_sessions",
    "sprintable_list_sprints", "sprintable_list_standup_entries", "sprintable_list_stories",
    "sprintable_list_tasks", "sprintable_list_team_members", "sprintable_list_webhook_configs",
    "sprintable_lock_files", "sprintable_mark_all_notifications_read",
    "sprintable_mark_notification_read", "sprintable_my_dashboard", "sprintable_poll_events",
    "sprintable_save_standup", "sprintable_search_docs", "sprintable_search_stories",
    "sprintable_send_chat_message", "sprintable_sprint_summary", "sprintable_standup_history",
    "sprintable_standup_missing", "sprintable_trigger_ai_summary",
    "sprintable_unassign_story_from_sprint", "sprintable_unclaim_story", "sprintable_unlock_files",
    "sprintable_update_doc", "sprintable_update_epic", "sprintable_update_meeting",
    "sprintable_update_retro_action_status", "sprintable_update_run_status",
    "sprintable_update_sprint", "sprintable_update_story", "sprintable_update_story_status",
    "sprintable_update_task", "sprintable_update_task_status", "sprintable_upsert_webhook_config",
    "sprintable_vote_retro_item",
)

# picker 표시 순서(비파괴 먼저). order 필드 힌트 + 배열 순서 둘 다 이 순서.
_CATALOG_DISPLAY_ORDER: tuple[str, ...] = (
    "stories", "tasks", "sprints", "epics", "chat", "docs", "analytics", "retro",
    "standup", "meetings", "notifications", "webhooks", "rewards", "audit", "agent_runs",
)


def build_toolset_catalog() -> dict:
    """toolset-catalog 응답(picker SSOT). 그룹별 멤버 툴 + core/destructive 플래그 + order.

    계약(FE `lib/toolset-catalog.ts`): {groups: [{key, tools[], is_core, is_destructive, order}]}.
    - key = enforcement 그룹 토큰(scope 저장값·불변). label/description 은 FE i18n(BE 미제공).
    - tools = tool_group() SSOT 매핑(항상허용=core 로 통합, 그룹별서 제외).
    - is_core = core(항상허용 잠금 그룹). is_destructive = admin(위험 작업 격리·opt-in).
    - 순서: core → 비파괴 15그룹(_CATALOG_DISPLAY_ORDER) → admin(파괴적) 마지막.
    """
    always = {t for t in _ALWAYS_ALLOWED if t.startswith("sprintable_")}
    buckets: dict[str, list[str]] = {}
    for t in ALL_TOOL_NAMES:
        if t in always:
            continue
        buckets.setdefault(tool_group(t), []).append(t)

    groups: list[dict] = [{
        "key": _CORE, "tools": sorted(always),
        "is_core": True, "is_destructive": False, "order": 0,
    }]
    for i, g in enumerate(_CATALOG_DISPLAY_ORDER, start=1):
        groups.append({
            "key": g, "tools": sorted(buckets.get(g, [])),
            "is_core": False, "is_destructive": False, "order": i,
        })
    groups.append({
        "key": "admin", "tools": sorted(buckets.get("admin", [])),
        "is_core": False, "is_destructive": True, "order": len(_CATALOG_DISPLAY_ORDER) + 1,
    })
    return {"groups": groups}
