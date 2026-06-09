"""Sprintable MCP 서버 — 91개 도구 등록 (flat schema)."""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
from typing import get_type_hints

logger = logging.getLogger(__name__)

from mcp.server.fastmcp import FastMCP
from mcp.types import TextContent
from pydantic import BaseModel
from pydantic.fields import PydanticUndefined

from .api_client import client
from .config import settings
from .response import ok
from .schemas import SprintableInput

# E-MCP S4: 독립 패키지 디탱글 — backend(app/*) import 제거. 규칙은 vendored .toolset 사용
# (백엔드 app/services/mcp_toolset.py와 동일 규칙 유지·SSOT는 백엔드 매니페스트).
from .toolset import is_tool_allowed
from .tools.agent_runs import (
    EmitEventInput, PollEventsInput, UpdateRunStatusInput,
    emit_event, poll_events, update_run_status,
)
from .tools.analytics import (
    ActivityInput, AgentStatsInput, EpicProgressInput, OverdueMemberInput,
    SearchStoriesInput, SprintFilterInput, WorkloadInput,
    get_agent_stats, get_blocked_stories, get_epic_progress,
    get_member_workload, get_overdue_tasks, get_project_health,
    get_project_overview, get_recent_activity, get_sprint_velocity_history,
    get_unassigned_stories, search_stories,
)
from .tools.audit import ListAuditLogsInput, list_audit_logs
from .tools.core import (
    ClaimStoryInput, DashboardInput, LockFilesInput, UnlockFilesInput,
    claim_story, get_workflow_guide, list_team_members, lock_files,
    my_dashboard, unclaim_story, unlock_files,
)
from .tools.docs import (
    CreateDocInput, DeleteDocInput, GetDocInput, ListDocsInput,
    SearchDocsInput, UpdateDocInput,
    create_doc, delete_doc, get_doc, list_docs, search_docs, update_doc,
)
from .tools.epics import (
    AddEpicInput, DeleteEpicInput, ListEpicsInput, UpdateEpicInput,
    add_epic, delete_epic, list_epics, update_epic,
)
from .tools.meetings import (
    CreateMeetingInput, ListMeetingsInput, MeetingIdInput, UpdateMeetingInput,
    create_meeting, delete_meeting, get_meeting, list_meetings,
    trigger_ai_summary, update_meeting,
)
from .tools.chat import (
    CreateConversationInput, ListChatMessagesInput, SendChatInput,
    create_conversation, list_chat_messages, send_chat_message,
)
from .tools.notifications import (
    CheckNotificationsInput, MarkAllNotificationsReadInput, MarkNotificationReadInput,
    check_notifications, mark_all_notifications_read, mark_notification_read,
)
from .tools.retro import (
    AddRetroActionInput, AddRetroItemInput, ChangeRetroPhaseInput,
    CreateRetroSessionInput, ExportRetroInput, ListRetroSessionsInput, VoteRetroItemInput,
    add_retro_action, add_retro_item, change_retro_phase, create_retro_session,
    export_retro, list_retro_sessions, vote_retro_item,
)
from .tools.rewards import (
    GetLeaderboardInput, GetWalletInput, GiveRewardInput,
    get_leaderboard_v2, get_wallet, give_reward,
)
from .tools.sprints import (
    CreateSprintInput, ListSprintsInput, SprintIdInput, UpdateSprintInput,
    activate_sprint, close_sprint, create_sprint, delete_sprint,
    get_velocity, list_sprints, sprint_summary, update_sprint,
)
from .tools.standup import (
    CheckinSprintInput, GetRetroSessionInput, GetStandupInput,
    ListStandupEntriesInput, SaveStandupInput, StandupDateInput, StandupHistoryInput,
    UpdateRetroActionStatusInput,
    checkin_sprint, get_retro_session, get_standup, list_standup_entries,
    save_standup, standup_history, standup_missing, update_retro_action_status,
)
from .tools.stories import (
    AddStoryInput, AssignStoryToSprintInput, DeleteStoryInput,
    ListStoriesInput, UnassignStoryFromSprintInput, UpdateStoryInput,
    UpdateStoryStatusInput,
    add_story, assign_story_to_sprint, delete_story,
    list_backlog, list_stories, unassign_story_from_sprint,
    update_story, update_story_status,
)
from .tools.tasks import (
    AddTaskInput, DeleteTaskInput, GetTaskInput, ListMyTasksInput,
    ListTasksInput, UpdateTaskInput, UpdateTaskStatusInput,
    add_task, delete_task, get_task, list_my_tasks, list_tasks,
    update_task, update_task_status,
)
from .tools.webhooks import (
    DeleteWebhookConfigInput, ListWebhookConfigsInput, UpsertWebhookConfigInput,
    delete_webhook_config, list_webhook_configs, upsert_webhook_config,
)


async def _heartbeat_fire_forget() -> None:
    """AC3/4: tool 호출 완료 후 fire-and-forget. 실패해도 tool 결과에 영향 없음."""
    try:
        if client.member_id:
            await client.patch(f"/api/v2/team-members/{client.member_id}/heartbeat")
    except Exception as exc:
        logger.warning("heartbeat failed (ignored): %s", exc)


# ── E-MCP S2: call-time toolset enforcement ──────────────────────────────────
# 키의 허용 toolset(scope)을 /api/v2/mcp/manifest에서 1회 로드(캐시) 후, 매 도구 호출 시
# is_tool_allowed로 차단(403-shape). 백엔드 ApiKey.scope가 진짜 SSOT, 여기선 defense-in-depth.
_key_scope: list[str] | None = None
_scope_loaded: bool = False


async def _load_scope() -> None:
    global _key_scope, _scope_loaded
    if _scope_loaded:
        return
    _scope_loaded = True
    try:
        manifest = await client.get("/api/v2/mcp/manifest")
        _key_scope = manifest.get("scope") or []
    except Exception:
        # 매니페스트 미가용 시 레거시 기본(비파괴 전체)로 fail-open — 백엔드가 최종 SSOT.
        _key_scope = None
        logger.warning("MCP toolset manifest load failed — falling back to legacy scope")


def _denied(name: str) -> list[TextContent]:
    return [TextContent(type="text", text=json.dumps(
        {"error": "forbidden", "code": 403,
         "message": f"tool '{name}' is not in this API key's allowed toolset"},
        ensure_ascii=False,
    ))]


def _flat(name: str, doc: str, input_cls: type[BaseModel], fn):
    """BaseModel → flat inspect.Signature so FastMCP emits top-level params."""
    try:
        resolved = get_type_hints(input_cls)
    except Exception:
        resolved = {}

    params = []
    for field_name, field_info in input_cls.model_fields.items():
        ann = resolved.get(field_name, inspect.Parameter.empty)
        default = (
            inspect.Parameter.empty
            if field_info.default is PydanticUndefined
            else field_info.default
        )
        params.append(
            inspect.Parameter(
                field_name,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
                default=default,
                annotation=ann,
            )
        )

    async def wrapper(**kwargs):
        # E-MCP S2: call-time enforcement — 키 허용 밖 도구는 호출 차단(403-shape).
        await _load_scope()
        if not is_tool_allowed(name, _key_scope):
            return _denied(name)
        result = await fn(input_cls(**kwargs))
        asyncio.create_task(_heartbeat_fire_forget())
        return result

    wrapper.__name__ = name
    wrapper.__qualname__ = name
    wrapper.__doc__ = doc
    wrapper.__signature__ = inspect.Signature(
        params, return_annotation=list[TextContent]
    )
    return wrapper


mcp = FastMCP(
    name="sprintable-mcp-python",
    instructions=(
        "Sprintable Python MCP server. "
        f"Backend: {settings.sprintable_api_url}"
    ),
)


@mcp.tool()
async def ping() -> list[TextContent]:
    """서버 생존 확인용 smoke tool."""
    asyncio.create_task(_heartbeat_fire_forget())
    return ok({"status": "pong"})


# ── 87개 도구 flat schema 등록 ─────────────────────────────────────────────────

_TOOL_DEFS: list[tuple] = [
    # Stories (8)
    ("sprintable_list_stories",
     "프로젝트 스토리 목록 조회. project_id/org_id context 자동 주입.",
     ListStoriesInput, list_stories),
    ("sprintable_list_backlog",
     "백로그 스토리 목록 (스프린트 미배정).",
     SprintableInput, list_backlog),
    ("sprintable_add_story",
     "스토리 생성.",
     AddStoryInput, add_story),
    ("sprintable_update_story",
     "스토리 수정.",
     UpdateStoryInput, update_story),
    ("sprintable_delete_story",
     "스토리 삭제.",
     DeleteStoryInput, delete_story),
    ("sprintable_assign_story_to_sprint",
     "스토리를 스프린트에 배정.",
     AssignStoryToSprintInput, assign_story_to_sprint),
    ("sprintable_unassign_story_from_sprint",
     "스토리를 스프린트에서 제거.",
     UnassignStoryFromSprintInput, unassign_story_from_sprint),
    ("sprintable_update_story_status",
     "스토리 상태 변경.",
     UpdateStoryStatusInput, update_story_status),
    # Tasks (7)
    ("sprintable_list_tasks",
     "태스크 목록 조회.",
     ListTasksInput, list_tasks),
    ("sprintable_list_my_tasks",
     "내 태스크 목록 조회.",
     ListMyTasksInput, list_my_tasks),
    ("sprintable_get_task",
     "태스크 단건 조회.",
     GetTaskInput, get_task),
    ("sprintable_add_task",
     "태스크 생성.",
     AddTaskInput, add_task),
    ("sprintable_update_task",
     "태스크 수정.",
     UpdateTaskInput, update_task),
    ("sprintable_update_task_status",
     "태스크 상태 변경.",
     UpdateTaskStatusInput, update_task_status),
    ("sprintable_delete_task",
     "태스크 삭제.",
     DeleteTaskInput, delete_task),
    # Epics (4)
    ("sprintable_list_epics",
     "에픽 목록 조회.",
     ListEpicsInput, list_epics),
    ("sprintable_add_epic",
     "에픽 생성.",
     AddEpicInput, add_epic),
    ("sprintable_update_epic",
     "에픽 수정.",
     UpdateEpicInput, update_epic),
    ("sprintable_delete_epic",
     "에픽 삭제.",
     DeleteEpicInput, delete_epic),
    # Sprints (8)
    ("sprintable_list_sprints",
     "스프린트 목록 조회.",
     ListSprintsInput, list_sprints),
    ("sprintable_sprint_summary",
     "스프린트 스토리 상태별 요약.",
     SprintIdInput, sprint_summary),
    ("sprintable_activate_sprint",
     "스프린트 활성화 (planning → active).",
     SprintIdInput, activate_sprint),
    ("sprintable_close_sprint",
     "스프린트 종료 (active → closed).",
     SprintIdInput, close_sprint),
    ("sprintable_get_velocity",
     "스프린트 벨로시티 조회.",
     SprintIdInput, get_velocity),
    ("sprintable_create_sprint",
     "스프린트 생성.",
     CreateSprintInput, create_sprint),
    ("sprintable_update_sprint",
     "스프린트 수정.",
     UpdateSprintInput, update_sprint),
    ("sprintable_delete_sprint",
     "스프린트 삭제.",
     SprintIdInput, delete_sprint),
    # Docs (6)
    ("sprintable_list_docs",
     "문서 목록 조회 (tree 또는 tag 필터).",
     ListDocsInput, list_docs),
    ("sprintable_get_doc",
     "slug로 문서 단건 조회.",
     GetDocInput, get_doc),
    ("sprintable_search_docs",
     "문서 제목/본문 검색.",
     SearchDocsInput, search_docs),
    ("sprintable_create_doc",
     "문서 생성.",
     CreateDocInput, create_doc),
    ("sprintable_update_doc",
     "문서 수정.",
     UpdateDocInput, update_doc),
    ("sprintable_delete_doc",
     "문서 소프트 삭제.",
     DeleteDocInput, delete_doc),
    # Analytics (11)
    ("sprintable_get_project_overview",
     "프로젝트 개요 통계 조회.",
     SprintableInput, get_project_overview),
    ("sprintable_get_member_workload",
     "팀원 워크로드 조회.",
     WorkloadInput, get_member_workload),
    ("sprintable_get_sprint_velocity_history",
     "스프린트 벨로시티 히스토리 조회.",
     SprintableInput, get_sprint_velocity_history),
    ("sprintable_search_stories",
     "스토리 제목 검색.",
     SearchStoriesInput, search_stories),
    ("sprintable_get_blocked_stories",
     "in-review 상태 스토리 목록 (블로킹 스토리).",
     SprintFilterInput, get_blocked_stories),
    ("sprintable_get_unassigned_stories",
     "담당자 미지정 스토리 목록.",
     SprintFilterInput, get_unassigned_stories),
    ("sprintable_get_overdue_tasks",
     "미완료 태스크 목록.",
     OverdueMemberInput, get_overdue_tasks),
    ("sprintable_get_recent_activity",
     "최근 프로젝트 활동 조회.",
     ActivityInput, get_recent_activity),
    ("sprintable_get_epic_progress",
     "에픽 진행 현황 조회.",
     EpicProgressInput, get_epic_progress),
    ("sprintable_get_agent_stats",
     "에이전트 성과 통계 조회.",
     AgentStatsInput, get_agent_stats),
    ("sprintable_get_project_health",
     "프로젝트 전체 건강도 조회.",
     SprintableInput, get_project_health),
    # Core (4)
    ("sprintable_list_team_members",
     "프로젝트 팀 멤버 목록 조회.",
     SprintableInput, list_team_members),
    ("sprintable_my_dashboard",
     "팀원 대시보드 요약 조회.",
     DashboardInput, my_dashboard),
    ("sprintable_claim_story",
     "현재 작업 중인 스토리를 claim — active_story_id 갱신, 중복 배정 방지.",
     ClaimStoryInput, claim_story),
    ("sprintable_unclaim_story",
     "작업 중인 스토리 claim 해제 — active_story_id = NULL.",
     SprintableInput, unclaim_story),
    ("sprintable_get_workflow_guide",
     "현재 프로젝트 워크플로우 가이드 텍스트 반환 — 에이전트 system prompt 주입용.",
     SprintableInput, get_workflow_guide),
    ("sprintable_lock_files",
     "파일 작업 시작 선언 — 동시 수정 충돌 경고 반환. 작업 완료 후 반드시 unlock_files 호출.",
     LockFilesInput, lock_files),
    ("sprintable_unlock_files",
     "파일 작업 완료 선언 — lock 해제.",
     UnlockFilesInput, unlock_files),
    # Chat (3)
    ("sprintable_send_chat_message",
     "conversation thread에 채팅 메시지 발송.",
     SendChatInput, send_chat_message),
    ("sprintable_create_conversation",
     "새 conversation thread 생성.",
     CreateConversationInput, create_conversation),
    ("sprintable_list_chat_messages",
     "conversation thread 메시지 목록 조회.",
     ListChatMessagesInput, list_chat_messages),
    # Meetings (6)
    ("sprintable_list_meetings",
     "프로젝트 미팅 목록 조회.",
     ListMeetingsInput, list_meetings),
    ("sprintable_get_meeting",
     "미팅 상세 조회.",
     MeetingIdInput, get_meeting),
    ("sprintable_create_meeting",
     "미팅 생성.",
     CreateMeetingInput, create_meeting),
    ("sprintable_update_meeting",
     "미팅 수정 (raw_transcript/ai_summary/decisions/action_items 포함).",
     UpdateMeetingInput, update_meeting),
    ("sprintable_delete_meeting",
     "미팅 소프트 삭제.",
     MeetingIdInput, delete_meeting),
    ("sprintable_trigger_ai_summary",
     "미팅 AI 요약 생성 트리거.",
     MeetingIdInput, trigger_ai_summary),
    # Standup (8)
    ("sprintable_standup_missing",
     "스탠드업 미제출 멤버 조회.",
     StandupDateInput, standup_missing),
    ("sprintable_standup_history",
     "최근 스탠드업 히스토리 조회.",
     StandupHistoryInput, standup_history),
    ("sprintable_get_standup",
     "멤버+날짜 기준 스탠드업 조회.",
     GetStandupInput, get_standup),
    ("sprintable_save_standup",
     "스탠드업 저장/업데이트.",
     SaveStandupInput, save_standup),
    ("sprintable_list_standup_entries",
     "날짜 기준 스탠드업 목록 조회.",
     ListStandupEntriesInput, list_standup_entries),
    ("sprintable_get_retro_session_by_sprint",
     "스프린트 레트로 세션 조회 (없으면 생성).",
     GetRetroSessionInput, get_retro_session),
    ("sprintable_update_retro_action_status",
     "레트로 액션 아이템 상태 변경.",
     UpdateRetroActionStatusInput, update_retro_action_status),
    ("sprintable_checkin_sprint",
     "스프린트 체크인 — 진행률 + 스탠드업 미제출 현황.",
     CheckinSprintInput, checkin_sprint),
    # Retro (7)
    ("sprintable_list_retro_sessions",
     "레트로 세션 목록 조회.",
     ListRetroSessionsInput, list_retro_sessions),
    ("sprintable_create_retro_session",
     "레트로 세션 생성.",
     CreateRetroSessionInput, create_retro_session),
    ("sprintable_vote_retro_item",
     "레트로 아이템 투표.",
     VoteRetroItemInput, vote_retro_item),
    ("sprintable_add_retro_action",
     "레트로 액션 아이템 추가.",
     AddRetroActionInput, add_retro_action),
    ("sprintable_change_retro_phase",
     "레트로 세션 단계 변경.",
     ChangeRetroPhaseInput, change_retro_phase),
    ("sprintable_add_retro_item",
     "레트로 아이템 추가 (good/bad/improve).",
     AddRetroItemInput, add_retro_item),
    ("sprintable_export_retro",
     "레트로 마크다운 내보내기.",
     ExportRetroInput, export_retro),
    # Rewards (3)
    ("sprintable_get_wallet",
     "팀원 보상 잔액 조회.",
     GetWalletInput, get_wallet),
    ("sprintable_give_reward",
     "팀원 보상/패널티 지급.",
     GiveRewardInput, give_reward),
    ("sprintable_get_leaderboard_v2",
     "보상 리더보드 조회.",
     GetLeaderboardInput, get_leaderboard_v2),
    # Notifications (3)
    ("sprintable_check_notifications",
     "알림 목록 조회.",
     CheckNotificationsInput, check_notifications),
    ("sprintable_mark_notification_read",
     "알림 읽음 처리.",
     MarkNotificationReadInput, mark_notification_read),
    ("sprintable_mark_all_notifications_read",
     "전체 알림 읽음 처리.",
     MarkAllNotificationsReadInput, mark_all_notifications_read),
    # Audit (1)
    ("sprintable_list_audit_logs",
     "권한 감사 로그 조회 (Admin/Owner 전용).",
     ListAuditLogsInput, list_audit_logs),
    # Agent Runs (3)
    ("sprintable_emit_event",
     "에이전트 런 이벤트 발행.",
     EmitEventInput, emit_event),
    ("sprintable_update_run_status",
     "에이전트 런 상태 업데이트.",
     UpdateRunStatusInput, update_run_status),
    ("sprintable_poll_events",
     "에이전트 수신 대기 이벤트 폴링.",
     PollEventsInput, poll_events),
    # Webhooks (3)
    ("sprintable_list_webhook_configs",
     "Webhook config 목록 조회.",
     ListWebhookConfigsInput, list_webhook_configs),
    ("sprintable_upsert_webhook_config",
     "Webhook config 생성/수정. secret 설정 시 HMAC 서명 활성화.",
     UpsertWebhookConfigInput, upsert_webhook_config),
    ("sprintable_delete_webhook_config",
     "Webhook config 삭제.",
     DeleteWebhookConfigInput, delete_webhook_config),
]

for _name, _doc, _cls, _fn in _TOOL_DEFS:
    mcp.tool()(_flat(_name, _doc, _cls, _fn))


# ── E-MCP S3: 부팅 시 허용 toolset만 노출 (schema/list 컨텍스트 절감) ─────────────
# S2의 call-time wrapper(호출 차단)는 그대로 유지 — S3는 list/schema에서 허용 밖 도구를 숨겨
# 컨텍스트를 절감하는 UX 레이어(defense-in-depth). 규칙은 동일하게 is_tool_allowed(SSOT) 공유.
def disallowed_tools(scope: list[str] | None) -> list[str]:
    """주어진 scope에서 허용되지 않는 등록 도구명 목록 (순수 — mcp 미변경)."""
    return [name for name, _doc, _cls, _fn in _TOOL_DEFS if not is_tool_allowed(name, scope)]


def filter_tools_by_scope(scope: list[str] | None) -> int:
    """허용 밖 도구를 MCP 레지스트리에서 제거(부팅 시 1회). 제거 수 반환.

    scope=None(매니페스트 fetch 실패/미바인딩) → 레거시 비파괴셋(destructive만 숨김)로 graceful degrade.
    _ALWAYS_ALLOWED(ping 등)는 is_tool_allowed가 항상 True라 보존.
    """
    removed = 0
    for name in disallowed_tools(scope):
        try:
            mcp.remove_tool(name)
            removed += 1
        except Exception:
            logger.debug("remove_tool skipped for %s (not registered)", name)
    return removed
