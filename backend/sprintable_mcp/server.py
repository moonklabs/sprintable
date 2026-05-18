from mcp.server.fastmcp import FastMCP
from mcp.types import TextContent

from .config import settings
from .response import ok
from .tools.agent_runs import (
    EmitEventInput, PollEventsInput, UpdateRunStatusInput,
    emit_event, poll_events, update_run_status,
)
from .tools.audit import ListAuditLogsInput, list_audit_logs
from .tools.notifications import (
    CheckNotificationsInput, MarkAllNotificationsReadInput, MarkNotificationReadInput,
    check_notifications, mark_all_notifications_read, mark_notification_read,
)
from .tools.rewards import (
    GetLeaderboardInput, GetWalletInput, GiveRewardInput,
    get_leaderboard_v2, get_wallet, give_reward,
)
from .tools.retro import (
    AddRetroActionInput, AddRetroItemInput, ChangeRetroPhaseInput,
    CreateRetroSessionInput, ExportRetroInput, ListRetroSessionsInput, VoteRetroItemInput,
    add_retro_action, add_retro_item, change_retro_phase, create_retro_session,
    export_retro, list_retro_sessions, vote_retro_item,
)
from .tools.standup import (
    CheckinSprintInput, GetRetroSessionInput, GetStandupInput,
    ListStandupEntriesInput, SaveStandupInput, StandupDateInput, StandupHistoryInput,
    UpdateRetroActionStatusInput,
    checkin_sprint, get_retro_session, get_standup, list_standup_entries,
    save_standup, standup_history, standup_missing, update_retro_action_status,
)
from .tools.meetings import (
    CreateMeetingInput, ListMeetingsInput, MeetingIdInput, UpdateMeetingInput,
    create_meeting, delete_meeting, get_meeting, list_meetings,
    trigger_ai_summary, update_meeting,
)
from .tools.memos import (
    CreateConversationInput, CreateMemoInput, ListChatMessagesInput,
    ListMemosInput, ListMyMemosInput, MemoIdInput, ReplyMemoInput, SendChatInput,
    create_conversation, create_memo, list_chat_messages,
    list_memos, list_my_memos, read_memo, reply_memo, resolve_memo,
    send_chat_message, send_memo,
)
from .tools.analytics import (
    ActivityInput, AgentStatsInput, EpicProgressInput, OverdueMemberInput,
    SearchStoriesInput, SprintFilterInput, WorkloadInput,
    get_agent_stats, get_blocked_stories, get_epic_progress,
    get_member_workload, get_overdue_tasks, get_project_health,
    get_project_overview, get_recent_activity, get_sprint_velocity_history,
    get_unassigned_stories, search_stories,
)
from .tools.core import DashboardInput, list_team_members, my_dashboard
from .tools.epics import (
    AddEpicInput, DeleteEpicInput, ListEpicsInput, UpdateEpicInput,
    add_epic, delete_epic, list_epics, update_epic,
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
from .schemas import SprintableInput
from .tools.docs import (
    CreateDocInput, DeleteDocInput, GetDocInput, ListDocsInput,
    SearchDocsInput, UpdateDocInput,
    create_doc, delete_doc, get_doc, list_docs, search_docs, update_doc,
)
from .tools.sprints import (
    CreateSprintInput, ListSprintsInput, SprintIdInput, UpdateSprintInput,
    activate_sprint, close_sprint, create_sprint, delete_sprint,
    get_velocity, list_sprints, sprint_summary, update_sprint,
)

mcp = FastMCP(
    name="sprintable-mcp-python",
    instructions=(
        "Sprintable Python MCP server. "
        f"Backend: {settings.sprintable_api_url}"
    ),
)


@mcp.tool()
def ping() -> list[TextContent]:
    """서버 생존 확인용 smoke tool."""
    return ok({"status": "pong"})


# ── Stories (8개) ──────────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_list_stories(args: ListStoriesInput) -> list[TextContent]:
    """프로젝트 스토리 목록 조회. project_id/org_id context 자동 주입."""
    return await list_stories(args)


@mcp.tool()
async def sprintable_list_backlog(args: SprintableInput) -> list[TextContent]:
    """백로그 스토리 목록 (스프린트 미배정)."""
    return await list_backlog(args)


@mcp.tool()
async def sprintable_add_story(args: AddStoryInput) -> list[TextContent]:
    """스토리 생성."""
    return await add_story(args)


@mcp.tool()
async def sprintable_update_story(args: UpdateStoryInput) -> list[TextContent]:
    """스토리 수정."""
    return await update_story(args)


@mcp.tool()
async def sprintable_delete_story(args: DeleteStoryInput) -> list[TextContent]:
    """스토리 삭제."""
    return await delete_story(args)


@mcp.tool()
async def sprintable_assign_story_to_sprint(args: AssignStoryToSprintInput) -> list[TextContent]:
    """스토리를 스프린트에 배정."""
    return await assign_story_to_sprint(args)


@mcp.tool()
async def sprintable_unassign_story_from_sprint(args: UnassignStoryFromSprintInput) -> list[TextContent]:
    """스토리를 스프린트에서 제거."""
    return await unassign_story_from_sprint(args)


@mcp.tool()
async def sprintable_update_story_status(args: UpdateStoryStatusInput) -> list[TextContent]:
    """스토리 상태 변경."""
    return await update_story_status(args)


# ── Tasks (7개) ────────────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_list_tasks(args: ListTasksInput) -> list[TextContent]:
    """태스크 목록 조회."""
    return await list_tasks(args)


@mcp.tool()
async def sprintable_list_my_tasks(args: ListMyTasksInput) -> list[TextContent]:
    """내 태스크 목록 조회."""
    return await list_my_tasks(args)


@mcp.tool()
async def sprintable_get_task(args: GetTaskInput) -> list[TextContent]:
    """태스크 단건 조회."""
    return await get_task(args)


@mcp.tool()
async def sprintable_add_task(args: AddTaskInput) -> list[TextContent]:
    """태스크 생성."""
    return await add_task(args)


@mcp.tool()
async def sprintable_update_task(args: UpdateTaskInput) -> list[TextContent]:
    """태스크 수정."""
    return await update_task(args)


@mcp.tool()
async def sprintable_update_task_status(args: UpdateTaskStatusInput) -> list[TextContent]:
    """태스크 상태 변경."""
    return await update_task_status(args)


@mcp.tool()
async def sprintable_delete_task(args: DeleteTaskInput) -> list[TextContent]:
    """태스크 삭제."""
    return await delete_task(args)


# ── Epics (4개) ────────────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_list_epics(args: ListEpicsInput) -> list[TextContent]:
    """에픽 목록 조회."""
    return await list_epics(args)


@mcp.tool()
async def sprintable_add_epic(args: AddEpicInput) -> list[TextContent]:
    """에픽 생성."""
    return await add_epic(args)


@mcp.tool()
async def sprintable_update_epic(args: UpdateEpicInput) -> list[TextContent]:
    """에픽 수정."""
    return await update_epic(args)


@mcp.tool()
async def sprintable_delete_epic(args: DeleteEpicInput) -> list[TextContent]:
    """에픽 삭제."""
    return await delete_epic(args)


# ── Sprints (8개) ──────────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_list_sprints(args: ListSprintsInput) -> list[TextContent]:
    """스프린트 목록 조회."""
    return await list_sprints(args)


@mcp.tool()
async def sprintable_sprint_summary(args: SprintIdInput) -> list[TextContent]:
    """스프린트 스토리 상태별 요약."""
    return await sprint_summary(args)


@mcp.tool()
async def sprintable_activate_sprint(args: SprintIdInput) -> list[TextContent]:
    """스프린트 활성화 (planning → active)."""
    return await activate_sprint(args)


@mcp.tool()
async def sprintable_close_sprint(args: SprintIdInput) -> list[TextContent]:
    """스프린트 종료 (active → closed)."""
    return await close_sprint(args)


@mcp.tool()
async def sprintable_get_velocity(args: SprintIdInput) -> list[TextContent]:
    """스프린트 벨로시티 조회."""
    return await get_velocity(args)


@mcp.tool()
async def sprintable_create_sprint(args: CreateSprintInput) -> list[TextContent]:
    """스프린트 생성."""
    return await create_sprint(args)


@mcp.tool()
async def sprintable_update_sprint(args: UpdateSprintInput) -> list[TextContent]:
    """스프린트 수정."""
    return await update_sprint(args)


@mcp.tool()
async def sprintable_delete_sprint(args: SprintIdInput) -> list[TextContent]:
    """스프린트 삭제."""
    return await delete_sprint(args)


# ── Docs (6개) ─────────────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_list_docs(args: ListDocsInput) -> list[TextContent]:
    """문서 목록 조회 (tree 또는 tag 필터)."""
    return await list_docs(args)


@mcp.tool()
async def sprintable_get_doc(args: GetDocInput) -> list[TextContent]:
    """slug로 문서 단건 조회."""
    return await get_doc(args)


@mcp.tool()
async def sprintable_search_docs(args: SearchDocsInput) -> list[TextContent]:
    """문서 제목/본문 검색."""
    return await search_docs(args)


@mcp.tool()
async def sprintable_create_doc(args: CreateDocInput) -> list[TextContent]:
    """문서 생성."""
    return await create_doc(args)


@mcp.tool()
async def sprintable_update_doc(args: UpdateDocInput) -> list[TextContent]:
    """문서 수정."""
    return await update_doc(args)


@mcp.tool()
async def sprintable_delete_doc(args: DeleteDocInput) -> list[TextContent]:
    """문서 소프트 삭제."""
    return await delete_doc(args)


# ── Analytics (11개) ───────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_get_project_overview(args: SprintableInput) -> list[TextContent]:
    """프로젝트 개요 통계 조회."""
    return await get_project_overview(args)


@mcp.tool()
async def sprintable_get_member_workload(args: WorkloadInput) -> list[TextContent]:
    """팀원 워크로드 조회."""
    return await get_member_workload(args)


@mcp.tool()
async def sprintable_get_sprint_velocity_history(args: SprintableInput) -> list[TextContent]:
    """스프린트 벨로시티 히스토리 조회."""
    return await get_sprint_velocity_history(args)


@mcp.tool()
async def sprintable_search_stories(args: SearchStoriesInput) -> list[TextContent]:
    """스토리 제목 검색."""
    return await search_stories(args)


@mcp.tool()
async def sprintable_get_blocked_stories(args: SprintFilterInput) -> list[TextContent]:
    """in-review 상태 스토리 목록 (블로킹 스토리)."""
    return await get_blocked_stories(args)


@mcp.tool()
async def sprintable_get_unassigned_stories(args: SprintFilterInput) -> list[TextContent]:
    """담당자 미지정 스토리 목록."""
    return await get_unassigned_stories(args)


@mcp.tool()
async def sprintable_get_overdue_tasks(args: OverdueMemberInput) -> list[TextContent]:
    """미완료 태스크 목록."""
    return await get_overdue_tasks(args)


@mcp.tool()
async def sprintable_get_recent_activity(args: ActivityInput) -> list[TextContent]:
    """최근 프로젝트 활동 조회."""
    return await get_recent_activity(args)


@mcp.tool()
async def sprintable_get_epic_progress(args: EpicProgressInput) -> list[TextContent]:
    """에픽 진행 현황 조회."""
    return await get_epic_progress(args)


@mcp.tool()
async def sprintable_get_agent_stats(args: AgentStatsInput) -> list[TextContent]:
    """에이전트 성과 통계 조회."""
    return await get_agent_stats(args)


@mcp.tool()
async def sprintable_get_project_health(args: SprintableInput) -> list[TextContent]:
    """프로젝트 전체 건강도 조회."""
    return await get_project_health(args)


# ── Core (2개) ─────────────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_list_team_members(args: SprintableInput) -> list[TextContent]:
    """프로젝트 팀 멤버 목록 조회."""
    return await list_team_members(args)


@mcp.tool()
async def sprintable_my_dashboard(args: DashboardInput) -> list[TextContent]:
    """팀원 대시보드 요약 조회."""
    return await my_dashboard(args)


# ── Memos + Chat (10개) ────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_list_memos(args: ListMemosInput) -> list[TextContent]:
    """메모 목록 조회."""
    return await list_memos(args)


@mcp.tool()
async def sprintable_create_memo(args: CreateMemoInput) -> list[TextContent]:
    """메모 생성."""
    return await create_memo(args)


@mcp.tool()
async def sprintable_send_memo(args: CreateMemoInput) -> list[TextContent]:
    """[DEPRECATED] 메모 발송. create_memo와 동일 경로."""
    return await send_memo(args)


@mcp.tool()
async def sprintable_list_my_memos(args: ListMyMemosInput) -> list[TextContent]:
    """내 메모 목록 조회 (담당/작성)."""
    return await list_my_memos(args)


@mcp.tool()
async def sprintable_read_memo(args: MemoIdInput) -> list[TextContent]:
    """메모 읽기 (conversation 우선, 없으면 memos fallback)."""
    return await read_memo(args)


@mcp.tool()
async def sprintable_reply_memo(args: ReplyMemoInput) -> list[TextContent]:
    """[DEPRECATED] 메모 답신 (conversation thread reply로 라우팅)."""
    return await reply_memo(args)


@mcp.tool()
async def sprintable_resolve_memo(args: MemoIdInput) -> list[TextContent]:
    """메모 해결 처리."""
    return await resolve_memo(args)


@mcp.tool()
async def sprintable_send_chat_message(args: SendChatInput) -> list[TextContent]:
    """conversation thread에 채팅 메시지 발송."""
    return await send_chat_message(args)


@mcp.tool()
async def sprintable_create_conversation(args: CreateConversationInput) -> list[TextContent]:
    """새 conversation thread 생성."""
    return await create_conversation(args)


@mcp.tool()
async def sprintable_list_chat_messages(args: ListChatMessagesInput) -> list[TextContent]:
    """conversation thread 메시지 목록 조회."""
    return await list_chat_messages(args)


# ── Meetings (6개) ─────────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_list_meetings(args: ListMeetingsInput) -> list[TextContent]:
    """프로젝트 미팅 목록 조회."""
    return await list_meetings(args)


@mcp.tool()
async def sprintable_get_meeting(args: MeetingIdInput) -> list[TextContent]:
    """미팅 상세 조회."""
    return await get_meeting(args)


@mcp.tool()
async def sprintable_create_meeting(args: CreateMeetingInput) -> list[TextContent]:
    """미팅 생성."""
    return await create_meeting(args)


@mcp.tool()
async def sprintable_update_meeting(args: UpdateMeetingInput) -> list[TextContent]:
    """미팅 수정 (raw_transcript/ai_summary/decisions/action_items 포함)."""
    return await update_meeting(args)


@mcp.tool()
async def sprintable_delete_meeting(args: MeetingIdInput) -> list[TextContent]:
    """미팅 소프트 삭제."""
    return await delete_meeting(args)


@mcp.tool()
async def sprintable_trigger_ai_summary(args: MeetingIdInput) -> list[TextContent]:
    """미팅 AI 요약 생성 트리거."""
    return await trigger_ai_summary(args)


# ── Standup (8개) ──────────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_standup_missing(args: StandupDateInput) -> list[TextContent]:
    """스탠드업 미제출 멤버 조회."""
    return await standup_missing(args)


@mcp.tool()
async def sprintable_standup_history(args: StandupHistoryInput) -> list[TextContent]:
    """최근 스탠드업 히스토리 조회."""
    return await standup_history(args)


@mcp.tool()
async def sprintable_get_standup(args: GetStandupInput) -> list[TextContent]:
    """멤버+날짜 기준 스탠드업 조회."""
    return await get_standup(args)


@mcp.tool()
async def sprintable_save_standup(args: SaveStandupInput) -> list[TextContent]:
    """스탠드업 저장/업데이트."""
    return await save_standup(args)


@mcp.tool()
async def sprintable_list_standup_entries(args: ListStandupEntriesInput) -> list[TextContent]:
    """날짜 기준 스탠드업 목록 조회."""
    return await list_standup_entries(args)


@mcp.tool()
async def sprintable_get_retro_session_by_sprint(args: GetRetroSessionInput) -> list[TextContent]:
    """스프린트 레트로 세션 조회 (없으면 생성)."""
    return await get_retro_session(args)


@mcp.tool()
async def sprintable_update_retro_action_status(args: UpdateRetroActionStatusInput) -> list[TextContent]:
    """레트로 액션 아이템 상태 변경."""
    return await update_retro_action_status(args)


@mcp.tool()
async def sprintable_checkin_sprint(args: CheckinSprintInput) -> list[TextContent]:
    """스프린트 체크인 — 진행률 + 스탠드업 미제출 현황."""
    return await checkin_sprint(args)


# ── Retro (7개) ────────────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_list_retro_sessions(args: ListRetroSessionsInput) -> list[TextContent]:
    """레트로 세션 목록 조회."""
    return await list_retro_sessions(args)


@mcp.tool()
async def sprintable_create_retro_session(args: CreateRetroSessionInput) -> list[TextContent]:
    """레트로 세션 생성."""
    return await create_retro_session(args)


@mcp.tool()
async def sprintable_vote_retro_item(args: VoteRetroItemInput) -> list[TextContent]:
    """레트로 아이템 투표."""
    return await vote_retro_item(args)


@mcp.tool()
async def sprintable_add_retro_action(args: AddRetroActionInput) -> list[TextContent]:
    """레트로 액션 아이템 추가."""
    return await add_retro_action(args)


@mcp.tool()
async def sprintable_change_retro_phase(args: ChangeRetroPhaseInput) -> list[TextContent]:
    """레트로 세션 단계 변경."""
    return await change_retro_phase(args)


@mcp.tool()
async def sprintable_add_retro_item(args: AddRetroItemInput) -> list[TextContent]:
    """레트로 아이템 추가 (good/bad/improve)."""
    return await add_retro_item(args)


@mcp.tool()
async def sprintable_export_retro(args: ExportRetroInput) -> list[TextContent]:
    """레트로 마크다운 내보내기."""
    return await export_retro(args)


# ── Rewards (3개) ──────────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_get_wallet(args: GetWalletInput) -> list[TextContent]:
    """팀원 보상 잔액 조회."""
    return await get_wallet(args)


@mcp.tool()
async def sprintable_give_reward(args: GiveRewardInput) -> list[TextContent]:
    """팀원 보상/패널티 지급."""
    return await give_reward(args)


@mcp.tool()
async def sprintable_get_leaderboard_v2(args: GetLeaderboardInput) -> list[TextContent]:
    """보상 리더보드 조회."""
    return await get_leaderboard_v2(args)


# ── Notifications (3개) ────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_check_notifications(args: CheckNotificationsInput) -> list[TextContent]:
    """알림 목록 조회."""
    return await check_notifications(args)


@mcp.tool()
async def sprintable_mark_notification_read(args: MarkNotificationReadInput) -> list[TextContent]:
    """알림 읽음 처리."""
    return await mark_notification_read(args)


@mcp.tool()
async def sprintable_mark_all_notifications_read(args: MarkAllNotificationsReadInput) -> list[TextContent]:
    """전체 알림 읽음 처리."""
    return await mark_all_notifications_read(args)


# ── Audit (1개) ────────────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_list_audit_logs(args: ListAuditLogsInput) -> list[TextContent]:
    """권한 감사 로그 조회."""
    return await list_audit_logs(args)


# ── Agent Runs (3개) ───────────────────────────────────────────────────────────

@mcp.tool()
async def sprintable_emit_event(args: EmitEventInput) -> list[TextContent]:
    """에이전트 런 이벤트 발행."""
    return await emit_event(args)


@mcp.tool()
async def sprintable_update_run_status(args: UpdateRunStatusInput) -> list[TextContent]:
    """에이전트 런 상태 업데이트."""
    return await update_run_status(args)


@mcp.tool()
async def sprintable_poll_events(args: PollEventsInput) -> list[TextContent]:
    """에이전트 수신 대기 이벤트 폴링."""
    return await poll_events(args)
