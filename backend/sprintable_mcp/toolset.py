"""E-MCP S4: 독립 패키지용 vendored toolset 규칙.

⚠️ 이 모듈은 backend `app/services/mcp_toolset.py`의 **vendored 복제본**이다.
   독립 PyPI 패키지(sprintable-mcp)는 backend(app/*)를 import할 수 없으므로 규칙을 자체 보유한다.
   규칙(그룹 키워드·destructive·is_tool_allowed)은 백엔드와 **동일하게 유지**할 것(드리프트 금지).
   백엔드는 권한 SSOT(ApiKey.scope·매니페스트)이고, 이 사본은 로컬 list 필터/call-time 적용에만 쓴다.

tool_name(`sprintable_<verb>_<domain>`) → group은 명시 키워드 매핑으로 결정(파일 의존 X).
"""
from __future__ import annotations

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
    ("hypotheses", ("hypothes",)),
    ("epics", ("epic",)),
    ("tasks", ("task",)),
    ("stories", ("story", "stories", "backlog", "claim", "checkin")),
    ("admin", ("give_reward", "emit_event", "trigger_ai", "activate_sprint",
               "close_sprint", "delete_sprint", "create_sprint", "upsert_webhook", "delete_webhook")),
]

_CORE = "core"

_ALWAYS_ALLOWED: frozenset[str] = frozenset({
    "ping", "sprintable_ping", "sprintable_my_dashboard", "sprintable_check_notifications",
    # P1-S12: 백엔드 SSOT(app/services/mcp_toolset.py)와 대조해 기존 드리프트 발견 후 동기화
    # (get_workflow_guide/list_team_members/poll_events가 vendored 사본에 빠져있었음 — 발견 즉시
    # 수정, read 유틸은 비파괴라 always-allow 안전). sprintable_get_loop_context(P1-S12, 이 스토리
    # 신규)도 read-only·get_workflow_guide 동형으로 여기 추가.
    "sprintable_get_workflow_guide", "sprintable_list_team_members", "sprintable_poll_events",
    "sprintable_get_loop_context",
    # S17: lock/unlock — 백엔드 SSOT와 동일 사유(org/project-scoped advisory 조율 도구, 파괴 아님)
    # 로 core 취급. 드리프트 금지 원칙에 따라 백엔드와 동기화(app/services/mcp_toolset.py 참고).
    "sprintable_lock_files", "sprintable_unlock_files",
})

_LEGACY_SCOPES: frozenset[str] = frozenset({"read", "write"})
_DESTRUCTIVE_SCOPES: frozenset[str] = frozenset({"admin", "destructive"})

ALL_GROUPS: tuple[str, ...] = tuple(g for g, _ in _GROUP_KEYWORDS if g != "admin") + (_CORE,)


def tool_group(tool_name: str) -> str:
    """tool 이름 → 그룹. ⚠️ 'sprintable_' 접두사가 'sprint'를 포함하므로 제거 후 매칭."""
    n = tool_name.lower()
    if n.startswith("sprintable_"):
        n = n[len("sprintable_"):]
    for group, keywords in _GROUP_KEYWORDS:
        if any(k in n for k in keywords):
            return group
    return _CORE


def is_destructive(tool_name: str) -> bool:
    """S17: lock_files/unlock_files 제외 — 백엔드 SSOT와 동기화(app/services/mcp_toolset.py)."""
    n = tool_name.lower()
    return (
        "delete" in n
        or "give_reward" in n
        or "_delete_" in n
        or n.startswith("sprintable_delete")
        or "close_sprint" in n
    )


def is_tool_allowed(tool_name: str, scope: list[str] | None) -> bool:
    """key scope로 tool 허용 판정. 백엔드 app/services/mcp_toolset.is_tool_allowed와 동일 규칙."""
    if tool_name in _ALWAYS_ALLOWED:
        return True
    tokens = {s.strip().lower() for s in (scope or []) if s and s.strip()}
    group = tool_group(tool_name)
    destructive = is_destructive(tool_name)
    explicit_groups = tokens & set(ALL_GROUPS) | (tokens & {"admin"})
    has_destructive_grant = bool(tokens & _DESTRUCTIVE_SCOPES)
    if not explicit_groups:
        group_ok = True
    else:
        group_ok = group in tokens or (group == "admin" and "admin" in tokens)
    if not group_ok:
        return False
    if destructive and not has_destructive_grant:
        return False
    return True
