"""Sprintable MCP 서버 — 92개 도구 등록 (flat schema)."""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import time
from collections import OrderedDict
from typing import get_type_hints

from mcp.server.transport_security import TransportSecuritySettings

logger = logging.getLogger(__name__)

from mcp.server.fastmcp import FastMCP
from mcp.types import TextContent
from mcp.types import Tool as MCPTool
from pydantic import BaseModel
from pydantic.fields import PydanticUndefined

from .api_client import _api_key_override, client, reset_project_override, set_project_override
from .config import settings
from .response import ok
from .schemas import SprintableInput

# E-MCP S4: 독립 패키지 디탱글 — backend(app/*) import 제거. 규칙은 vendored .toolset 사용
# (백엔드 app/services/mcp_toolset.py와 동일 규칙 유지·SSOT는 백엔드 매니페스트).
from .toolset import is_tool_allowed
from .tools.a2a import LinkGateToTaskInput, link_gate_to_task
from .tools.evidence import AddEvidenceInput, add_evidence
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
from .tools.hypotheses import (
    ConfirmHypothesisInput, CreateHypothesisInput, GetHypothesisInput,
    LinkHypothesisInput, ListHypothesesInput, UpdateHypothesisInput,
    confirm_hypothesis, create_hypothesis, get_hypothesis,
    link_hypothesis, list_hypotheses, update_hypothesis,
)
from .tools.loops import GetLoopContextInput, get_loop_context
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
    AddStoryInput, AssignStoryToSprintInput,
    ListStoriesInput, UnassignStoryFromSprintInput, UpdateStoryInput,
    UpdateStoryStatusInput,
    add_story, assign_story_to_sprint,
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
# 키의 허용 toolset(scope)을 /api/v2/mcp/manifest에서 로드(per-key 캐시) 후, 매 도구 호출 시
# is_tool_allowed로 차단(403-shape). 백엔드 ApiKey.scope가 진짜 SSOT, 여기선 defense-in-depth.
# E-MCP-HTTP S1: env 단일키 글로벌 캐시 → **per-key bounded 캐시**(http 멀티테넌트·多키 무한증식 방지·
# LRU+TTL·SeenIdsCache 패턴). 미해소(manifest 실패) sentinel=_SCOPE_FAILOPEN(None=전체 허용 fail-open).
_SCOPE_MISS = object()
_SCOPE_FAILOPEN: object = None  # None = legacy 전체 허용(백엔드 최종 SSOT)


class _ScopeCache:
    """per-key scope LRU+TTL 캐시(bound)·SeenIdsCache 패턴. value=list[str]|None(fail-open)."""

    def __init__(self, max_size: int, ttl_seconds: float) -> None:
        self._max = max_size
        self._ttl = ttl_seconds
        self._store: "OrderedDict[str, tuple[float, list[str] | None]]" = OrderedDict()

    def get(self, key: str):
        item = self._store.get(key)
        if item is None:
            return _SCOPE_MISS
        added_at, scope = item
        if (time.monotonic() - added_at) > self._ttl:
            del self._store[key]
            return _SCOPE_MISS
        self._store.move_to_end(key)  # LRU touch
        return scope

    def put(self, key: str, scope: list[str] | None) -> None:
        self._store[key] = (time.monotonic(), scope)
        self._store.move_to_end(key)
        while len(self._store) > self._max:
            self._store.popitem(last=False)  # LRU evict


_scope_cache = _ScopeCache(settings.mcp_scope_cache_max_size, settings.mcp_scope_cache_ttl_seconds)


async def _load_scope_for(key: str) -> list[str] | None:
    """effective 키의 scope 해소(per-key 캐시). manifest 는 api_client 가 per-request 키(contextvar)로
    호출하므로 그 키의 scope 가 온다. 실패 시 fail-open(None·백엔드 최종 SSOT)."""
    cached = _scope_cache.get(key)
    if cached is not _SCOPE_MISS:
        return cached  # type: ignore[return-value]
    try:
        manifest = await client.get("/api/v2/mcp/manifest")
        scope: list[str] | None = manifest.get("scope") or []
    except Exception:
        scope = _SCOPE_FAILOPEN  # 매니페스트 미가용 → fail-open(백엔드가 최종 SSOT)
        logger.warning("MCP toolset manifest load failed — falling back to legacy scope")
    _scope_cache.put(key, scope)
    return scope


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

    # 85429ee0: base SprintableInput.project_id(기본값 有)가 subclass 필수필드보다 앞서면
    # inspect.Signature 가 "non-default argument follows default argument"로 깨진다 → 기본값 없는
    # 파라미터를 앞으로 안정 정렬(MCP 는 keyword 호출이라 순서 변경 무해).
    params.sort(key=lambda p: p.default is not inspect.Parameter.empty)

    async def wrapper(**kwargs):
        # E-MCP S2: call-time enforcement — 키 허용 밖 도구는 호출 차단(403-shape).
        # E-MCP-HTTP S1: effective 키(http=per-request bearer override·stdio=env 단일키)별 scope 로드
        # (per-key bounded 캐시). 멀티테넌트서 키마다 다른 scope 정확 적용.
        _eff_key = _api_key_override.get() or settings.agent_api_key
        _scope = await _load_scope_for(_eff_key)
        if not is_tool_allowed(name, _scope):
            return _denied(name)
        # 85429ee0: per-call project_id override → contextvar(tool 호출 스코프). client.project_id +
        # X-Project-Id 헤더에 반영(org-agent 멀티프로젝트 grant). 미지정이면 키 default(무회귀).
        _tok = set_project_override(kwargs.get("project_id"))
        try:
            result = await fn(input_cls(**kwargs))
        finally:
            reset_project_override(_tok)
        asyncio.create_task(_heartbeat_fire_forget())
        return result

    wrapper.__name__ = name
    wrapper.__qualname__ = name
    wrapper.__doc__ = doc
    wrapper.__signature__ = inspect.Signature(
        params, return_annotation=list[TextContent]
    )
    return wrapper


# E-MCP-HTTP S2: DNS-rebinding 보호 설정. FastMCP 는 명시 transport_security 없으면 host 기반 자동
# 보호(localhost allowed_hosts)를 켜 Cloud Run host(*.run.app)를 421 거부한다. MCP_ALLOWED_HOSTS 지정 시
# 그 호스트만 화이트리스트(보호 ON)·비우면 보호 OFF(공개 bearer-gated 호스팅·Cloud Run TLS+bearer 가 실보안).
_allowed_hosts = [h.strip() for h in (settings.mcp_allowed_hosts or "").split(",") if h.strip()]
# ⭐codex RC: allowed_hosts 는 Host 헤더(bare host) exact-match 이지만 allowed_origins 는 Origin 헤더
# (브라우저=scheme 포함·`https://host`) exact-match 다(SDK _validate_origin). bare host 를 origins 에
# 넣으면 브라우저 Origin 요청이 403(prod·whitelist 시). → origins 는 `https://{host}` 로 파생(Cloud Run/
# 커스텀도메인 TLS=https). Poke 등 server-to-server 는 Origin 부재라 항상 통과(SDK: origin 없으면 True).
_allowed_origins = [f"https://{h}" for h in _allowed_hosts]
_transport_security = TransportSecuritySettings(
    enable_dns_rebinding_protection=bool(_allowed_hosts),
    allowed_hosts=_allowed_hosts,
    allowed_origins=_allowed_origins,
)

# E-MCP-OPT S1: hosted(http) tools/list 요청별 scope 필터. FastMCP.__init__ → _setup_handlers()가
# `self._mcp_server.list_tools()(self.list_tools)`로 **구성 시점 bound method**를 저수준 핸들러에
# 등록한다 — 구성 後 인스턴스 몽키패치(mcp.list_tools = fn)는 이미 캡처된 참조에 안 먹는다(실측 확인:
# 코덱스 + 별도 독립 재현 스크립트 둘 다). 서브클래스 오버라이드는 __init__ 이전에 존재해 self.list_tools
# 속성조회(MRO)가 오버라이드로 해소되므로 저수준 핸들러가 정확히 이걸 호출한다 — 유일하게 먹는 방식.
#
# stdio는 부팅 시 filter_tools_by_scope(레지스트리 destructive mutation)로 이미 걸러진 목록만 남아
# 있어 이 필터가 다시 돌아도 무해한 no-op(전 도구 이미 허용된 것들)이지만, mcp_transport 가드로 아예
# 스킵해 시맨틱을 명확히 하고 매 stdio list_tools 호출마다 불필요한 manifest 캐시 조회도 피한다.
# fail-open(scope=None → 비파괴셋)은 call-time(_flat wrapper)과 동일 철학 — 백엔드가 최종 SSOT라 list는
# degrade(더 보여줌)해도 call은 여전히 403 차단.
class SprintableFastMCP(FastMCP):
    async def list_tools(self) -> list[MCPTool]:
        tools = await super().list_tools()
        if (settings.mcp_transport or "stdio").strip().lower() != "http":
            return tools

        _eff_key = _api_key_override.get() or settings.agent_api_key
        _scope = await _load_scope_for(_eff_key)
        return [tool for tool in tools if is_tool_allowed(tool.name, _scope)]


mcp = SprintableFastMCP(
    name="sprintable-mcp-python",
    instructions=(
        "Sprintable Python MCP server. "
        f"Backend: {settings.sprintable_api_url}"
    ),
    # E-MCP-HTTP S1: stateless HTTP(요청간 세션 미보존)=무상태 툴서버(서버리스/멀티인스턴스 안전·Cloud
    # Run S2). stdio 모드는 이 설정 무시(영향 0).
    stateless_http=True,
    transport_security=_transport_security,
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
    # E-SECURITY SEC-S1: sprintable_delete_story 의도적 제거(에이전트 hard-delete 차단).
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
    # Hypotheses (6)
    ("sprintable_list_hypotheses",
     "가설 목록 조회 (compact). epic_id/story_id/status/owner_member_id 필터.",
     ListHypothesesInput, list_hypotheses),
    ("sprintable_get_hypothesis",
     "가설 단건 조회 (full).",
     GetHypothesisInput, get_hypothesis),
    ("sprintable_create_hypothesis",
     "가설 생성. agent 호출은 status='proposed'로 강제된다.\n"
     "metric_definition(dict) 필수 키: metric(str), source(enum: ga4|internal_ops|manual), "
     "target(number), direction(enum: up|down). "
     "source='ga4'이면 추가 필수: property_id, ga4_metric(enum: activeUsers|newUsers|sessions|"
     "conversions|eventCount|screenPageViews), date_range_days(양의 정수).\n"
     "owner_member_id: agent 호출은 휴먼 멤버 owner_member_id를 반드시 명시해야 한다"
     "(미지정 시 백엔드가 400 HUMAN_OWNER_REQUIRED 반환). list_team_members로 휴먼 멤버 id 조회.",
     CreateHypothesisInput, create_hypothesis),
    ("sprintable_update_hypothesis",
     "가설 수정 (문장/지표/측정일/owner). 상태 전이는 confirm으로.",
     UpdateHypothesisInput, update_hypothesis),
    ("sprintable_link_hypothesis",
     "가설을 epic/story에 연결/재연결.",
     LinkHypothesisInput, link_hypothesis),
    ("sprintable_confirm_hypothesis",
     "가설 확정(active) 또는 폐기(killed). active 확정은 휴먼 경로만.",
     ConfirmHypothesisInput, confirm_hypothesis),
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
    ("sprintable_get_loop_context",
     "loop의 Context Pack(의미 유사한 과거 loop/결정/성과) 조회 — 에이전트 on-demand pull, read-only.",
     GetLoopContextInput, get_loop_context),
    ("sprintable_lock_files",
     "파일 작업 시작 선언 — 동시 수정 충돌 경고 반환. 작업 완료 후 반드시 unlock_files 호출.",
     LockFilesInput, lock_files),
    ("sprintable_unlock_files",
     "파일 작업 완료 선언 — lock 해제.",
     UnlockFilesInput, unlock_files),
    # A2A HITL writer (1) — E-A2A-완성 S-A3
    ("sprintable_link_gate_to_task",
     "이 gate가 이 A2A task를 블록한다고 명시 선언 — 외부 GetTask가 INPUT_REQUIRED로 승격되고,"
     " 사람이 gate를 승인/거부하면 task가 자동으로 WORKING/REJECTED 복귀한다.",
     LinkGateToTaskInput, link_gate_to_task),
    # Evidence 자기증명 (1) — E-VERIFY V0-S1
    ("sprintable_add_evidence",
     "done을 스스로 증명하는 자기 서명 첨부(PR·배포·지표·발행물 링크 등) — story/task에 evidence"
     " 남김. 선택제(첨부 안 해도 무불이익).",
     AddEvidenceInput, add_evidence),
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
