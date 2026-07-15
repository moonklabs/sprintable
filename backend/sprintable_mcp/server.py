"""Sprintable MCP 서버 — 106개 도구 등록 (flat schema)."""
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
from .tools.visual_artifacts import (
    AddArtifactCommentInput, CreateArtifactInput, CreateSpecPinInput, DeleteSpecPinInput,
    EditArtifactInput, GetArtifactInput, ListArtifactCommentsInput, ListArtifactsInput,
    ListSpecPinsInput, ProposeCanonicalInput, UpdateSpecPinInput,
    add_artifact_comment, create_artifact, create_spec_pin, delete_spec_pin, edit_artifact,
    get_artifact, list_artifact_comments, list_artifacts, list_spec_pins,
    propose_canonical_version, update_spec_pin,
)
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
from .tools.projects import (
    ListProjectsInput, SetDefaultProjectInput, list_projects, set_default_project,
)
from .tools.docs import (
    CreateDocInput, GetDocInput, ListDocsInput,
    SearchDocsInput, UpdateDocInput,
    create_doc, get_doc, list_docs, search_docs, update_doc,
)
from .tools.epics import (
    AddEpicInput, ListEpicsInput, UpdateEpicInput,
    add_epic, list_epics, update_epic,
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
    CreateConversationInput, GetChatMessageInput, ListChatMessagesInput, SendChatInput,
    create_conversation, get_chat_message, list_chat_messages, send_chat_message,
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
    activate_sprint, close_sprint, create_sprint,
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
    AddTaskInput, GetTaskInput, ListMyTasksInput,
    ListTasksInput, UpdateTaskInput, UpdateTaskStatusInput,
    add_task, get_task, list_my_tasks, list_tasks,
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
     "[일감] 프로젝트 스토리 목록 조회. project_id/org_id context 자동 주입.",
     ListStoriesInput, list_stories),
    ("sprintable_list_backlog",
     "[일감] 백로그 스토리 목록 (스프린트 미배정).",
     SprintableInput, list_backlog),
    ("sprintable_add_story",
     "[일감] 스토리 생성.",
     AddStoryInput, add_story),
    ("sprintable_update_story",
     "[일감] 스토리 수정.",
     UpdateStoryInput, update_story),
    # E-SECURITY SEC-S1: sprintable_delete_story 의도적 제거(에이전트 hard-delete 차단).
    ("sprintable_assign_story_to_sprint",
     "[일감] 스토리를 스프린트에 배정.",
     AssignStoryToSprintInput, assign_story_to_sprint),
    ("sprintable_unassign_story_from_sprint",
     "[일감] 스토리를 스프린트에서 제거.",
     UnassignStoryFromSprintInput, unassign_story_from_sprint),
    ("sprintable_update_story_status",
     "[일감] 스토리 상태 변경.",
     UpdateStoryStatusInput, update_story_status),
    # Tasks (6) — E-SECURITY SEC-S1 확장: delete_task 제거(에이전트 hard-delete 차단)
    ("sprintable_list_tasks",
     "[일감] 태스크 목록 조회.",
     ListTasksInput, list_tasks),
    ("sprintable_list_my_tasks",
     "[일감] 내 태스크 목록 조회.",
     ListMyTasksInput, list_my_tasks),
    ("sprintable_get_task",
     "[일감] 태스크 단건 조회.",
     GetTaskInput, get_task),
    ("sprintable_add_task",
     "[일감] 태스크 생성.",
     AddTaskInput, add_task),
    ("sprintable_update_task",
     "[일감] 태스크 수정.",
     UpdateTaskInput, update_task),
    ("sprintable_update_task_status",
     "[일감] 태스크 상태 변경.",
     UpdateTaskStatusInput, update_task_status),
    # Epics (3) — E-SECURITY SEC-S1 확장: delete_epic 제거(에이전트 hard-delete 차단)
    ("sprintable_list_epics",
     "[일감] 에픽 목록 조회.",
     ListEpicsInput, list_epics),
    ("sprintable_add_epic",
     "[일감] 에픽 생성.",
     AddEpicInput, add_epic),
    ("sprintable_update_epic",
     "[일감] 에픽 수정.",
     UpdateEpicInput, update_epic),
    # Hypotheses (6)
    ("sprintable_list_hypotheses",
     "[일감] 가설 목록 조회 (compact). epic_id/story_id/status/owner_member_id 필터."
     " all_projects=true면 project_id 대신 org 전체(접근 가능한 모든 project)에서 조회.",
     ListHypothesesInput, list_hypotheses),
    ("sprintable_get_hypothesis",
     "[일감] 가설 단건 조회 (full).",
     GetHypothesisInput, get_hypothesis),
    ("sprintable_create_hypothesis",
     "[일감] 가설 생성. agent 호출은 status='proposed'로 강제된다.\n"
     "metric_definition(dict) 필수 키: metric(str), source(enum: ga4|internal_ops|manual), "
     "target(number), direction(enum: up|down). "
     "source='ga4'이면 추가 필수: property_id, ga4_metric(enum: activeUsers|newUsers|sessions|"
     "conversions|eventCount|screenPageViews), date_range_days(양의 정수).\n"
     "owner_member_id: agent 호출은 휴먼 멤버 owner_member_id를 반드시 명시해야 한다"
     "(미지정 시 백엔드가 400 HUMAN_OWNER_REQUIRED 반환). list_team_members로 휴먼 멤버 id 조회.",
     CreateHypothesisInput, create_hypothesis),
    ("sprintable_update_hypothesis",
     "[일감] 가설 수정 (문장/지표/측정일/owner). 상태 전이는 confirm으로.",
     UpdateHypothesisInput, update_hypothesis),
    ("sprintable_link_hypothesis",
     "[일감] 가설을 epic/story에 연결/재연결.",
     LinkHypothesisInput, link_hypothesis),
    ("sprintable_confirm_hypothesis",
     "[일감] 가설 확정(active) 또는 폐기(killed). active 확정은 휴먼 경로만.",
     ConfirmHypothesisInput, confirm_hypothesis),
    # Sprints (7) — E-SECURITY SEC-S8 확장: delete_sprint 제거(에이전트 hard-delete 차단)
    ("sprintable_list_sprints",
     "[일감] 스프린트 목록 조회.",
     ListSprintsInput, list_sprints),
    ("sprintable_sprint_summary",
     "[일감] 스프린트 스토리 상태별 요약.",
     SprintIdInput, sprint_summary),
    ("sprintable_activate_sprint",
     "[일감] 스프린트 활성화 (planning → active).",
     SprintIdInput, activate_sprint),
    ("sprintable_close_sprint",
     "[일감] 스프린트 종료 (active → closed).",
     SprintIdInput, close_sprint),
    ("sprintable_get_velocity",
     "[일감] 스프린트 벨로시티 조회.",
     SprintIdInput, get_velocity),
    ("sprintable_create_sprint",
     "[일감] 스프린트 생성.",
     CreateSprintInput, create_sprint),
    ("sprintable_update_sprint",
     "[일감] 스프린트 수정.",
     UpdateSprintInput, update_sprint),
    # Docs (5) — E-SECURITY SEC-S1 확장: delete_doc 제거(에이전트 삭제 차단)
    ("sprintable_list_docs",
     "[지식] 문서 목록 조회 (tree 또는 tag 필터).",
     ListDocsInput, list_docs),
    ("sprintable_get_doc",
     "[지식] slug로 문서 단건 조회.",
     GetDocInput, get_doc),
    ("sprintable_search_docs",
     "[지식] 문서 제목/본문 검색.",
     SearchDocsInput, search_docs),
    ("sprintable_create_doc",
     "[지식] 문서 생성.",
     CreateDocInput, create_doc),
    ("sprintable_update_doc",
     "[지식] 문서 수정.",
     UpdateDocInput, update_doc),
    # Analytics (11)
    ("sprintable_get_project_overview",
     "[일감] 프로젝트 개요 통계 조회.",
     SprintableInput, get_project_overview),
    ("sprintable_get_member_workload",
     "[일감] 팀원 워크로드 조회.",
     WorkloadInput, get_member_workload),
    ("sprintable_get_sprint_velocity_history",
     "[일감] 스프린트 벨로시티 히스토리 조회.",
     SprintableInput, get_sprint_velocity_history),
    ("sprintable_search_stories",
     "[일감] 스토리 제목 검색.",
     SearchStoriesInput, search_stories),
    ("sprintable_get_blocked_stories",
     "[일감] in-review 상태 스토리 목록 (블로킹 스토리).",
     SprintFilterInput, get_blocked_stories),
    ("sprintable_get_unassigned_stories",
     "[일감] 담당자 미지정 스토리 목록.",
     SprintFilterInput, get_unassigned_stories),
    ("sprintable_get_overdue_tasks",
     "[일감] 미완료 태스크 목록.",
     OverdueMemberInput, get_overdue_tasks),
    ("sprintable_get_recent_activity",
     "[일감] 최근 프로젝트 활동 조회.",
     ActivityInput, get_recent_activity),
    ("sprintable_get_epic_progress",
     "[일감] 에픽 진행 현황 조회.",
     EpicProgressInput, get_epic_progress),
    ("sprintable_get_agent_stats",
     "[일감] 에이전트 성과 통계 조회.",
     AgentStatsInput, get_agent_stats),
    ("sprintable_get_project_health",
     "[일감] 프로젝트 전체 건강도 조회.",
     SprintableInput, get_project_health),
    # Core (6) — E-MCP-OPT(story ff6cb90d): list_projects/set_default_project 2종 추가.
    ("sprintable_list_team_members",
     "프로젝트 팀 멤버 목록 조회.",
     SprintableInput, list_team_members),
    ("sprintable_my_dashboard",
     "팀원 대시보드 요약 조회.",
     DashboardInput, my_dashboard),
    ("sprintable_list_projects",
     "이 키(멤버)가 접근 가능한 프로젝트 목록 조회(id·이름·org) — 무권한/타조직 미노출.",
     ListProjectsInput, list_projects),
    ("sprintable_set_default_project",
     "이 키의 기본 프로젝트를 서버에 저장(감사 가능) — project_id 없는 후속 호출이 이 프로젝트로"
     " 해소됨. 지정 project_id에 접근권 없으면 403.",
     SetDefaultProjectInput, set_default_project),
    ("sprintable_claim_story",
     "[일감] 현재 작업 중인 스토리를 claim — active_story_id 갱신, 중복 배정 방지.",
     ClaimStoryInput, claim_story),
    ("sprintable_unclaim_story",
     "[일감] 작업 중인 스토리 claim 해제 — active_story_id = NULL.",
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
    # Visual artifacts (11) — E-CANVAS C1-S3 + C2-S6(코멘트) + C3-S7(편집) + C4-S8(정본 제안) +
    # 핀 저작(story 7fe16274)
    ("sprintable_create_artifact",
     "[일감] 시각 산출물 생성(에이전트 생성 입구) — 트리(nodes[])로 구조화. 임포트된 raw HTML/이미지는"
     " type=\"html_blob\" 노드 하나로 감싸도 됨. canvas_bounds{w,h}(선택): 렌더 자기 프레임 크기"
     "(CSS px, 양수·≤20000) — sandbox iframe이라 서버가 측정 불가해 선언 필요·미지정=FE 기본 아트보드."
     " ⭐UI·화면·디자인·시각 산출물을 만들 때는 텍스트 설명 대신 이 툴로 구조화해 그린다(사람이"
     " 캔버스에서 보고 코멘트/핀으로 피드백).",
     CreateArtifactInput, create_artifact),
    ("sprintable_get_artifact",
     "[일감] 시각 산출물 단건 조회(latest 버전 + nodes). ⭐편집/코멘트/핀 작업 전 먼저 현재 상태(노드"
     " 구조·프레임)를 확인할 때.",
     GetArtifactInput, get_artifact),
    ("sprintable_list_artifacts",
     "[일감] 현재 프로젝트 시각 산출물 목록 조회(각 항목=메타+latest 버전 번호·노드 트리 미포함·상세는"
     " get_artifact) — story_id/epic_id/doc_id로 필터(미지정=프로젝트 전체). ⭐특정 story/epic/doc에"
     " 이미 산출물이 있는지 확인하거나 전체 현황을 파악할 때(중복 생성 방지).",
     ListArtifactsInput, list_artifacts),
    ("sprintable_list_artifact_comments",
     "[일감] artifact 코멘트 스레드 조회(요소/좌표 앵커·resolve 상태) — 휴먼 피드백 왕복 입구. ⭐산출물에"
     " 반응하기 전 먼저 미해결 코멘트가 있는지 확인할 때.",
     ListArtifactCommentsInput, list_artifact_comments),
    ("sprintable_add_artifact_comment",
     "[일감] artifact에 코멘트 추가(요소/좌표 앵커·답글 가능) — 대상자에게 이벤트 전파. ⭐산출물의 특정"
     " 요소/위치에 의견·질문을 남길 때(바로 고치지 않고 논의가 필요할 때 — edit 대신 이것).",
     AddArtifactCommentInput, add_artifact_comment),
    ("sprintable_edit_artifact",
     "[일감] artifact 요소를 operations[]로 편집(휴먼 딸깍과 같은 경로·항상 새 버전·이벤트 전파). 각 op="
     "{op:add|update|delete, id, type?, props?}. ⭐update/delete 대상 노드는 `id` 필드로 지정"
     "(get_artifact의 node.id·코멘트 앵커 node_id 아님)·add는 type 필수. canvas_bounds{w,h}(선택):"
     " 프레임 크기 재선언 — 미지정 시 직전 버전 값 유지·operations 비우고 이것만 보내도 유효"
     "(둘 다 비면 오류). ⭐기존 산출물을 수정할 때는 create_artifact로 새로 만들지 말고 이걸로"
     "(새 버전 생성·이전 버전은 그대로 보존).",
     EditArtifactInput, edit_artifact),
    ("sprintable_list_spec_pins",
     "[일감] artifact 최신 버전의 스펙 핀 목록 조회(description pane 저작 대상 — 코멘트와 별개 레이어)."
     " 작성자/시간 미노출(감시금지). ⭐요소별로 이미 지정된 핸드오프 스펙을 편집 전에 확인할 때.",
     ListSpecPinsInput, list_spec_pins),
    ("sprintable_create_spec_pin",
     "[일감] artifact에 스펙 핀 추가 — 요소/좌표에 description(핸드오프 스펙)을 앵커. anchor_type="
     "\"coord\"면 anchor_x/anchor_y(canvas_bounds 좌표계, 0 이상) 둘 다 필수·node_id 금지."
     " \"node\"면 node_id(get_artifact의 node.id) 필수·좌표 금지. description은 non-empty 강제"
     "(빈 스펙 저장 불가). 핀은 최신 버전에 붙고 이후 edit_artifact마다 자동 계승(node 앵커는"
     " 그 노드가 삭제되면 핀도 함께 소멸). ⭐산출물의 특정 요소/위치를 콕 집어 스펙(치수·색상·동작"
     " 등 핸드오프 설명)을 못박을 때 — 자유 코멘트(add_artifact_comment) 대신 이걸로.",
     CreateSpecPinInput, create_spec_pin),
    ("sprintable_update_spec_pin",
     "[일감] 스펙 핀 description 재저작(덮어씀·스레드/이력 없음) — 최신 버전 소속 핀만 대상. ⭐기존 스펙"
     " 핀의 설명을 정정·보강할 때.",
     UpdateSpecPinInput, update_spec_pin),
    ("sprintable_delete_spec_pin",
     "[일감] 스펙 핀 삭제(최신 버전 소속만 대상). ⭐더 이상 유효하지 않은 스펙 핀을 치울 때.",
     DeleteSpecPinInput, delete_spec_pin),
    ("sprintable_propose_canonical_version",
     "[신뢰] 이 버전을 정본으로 제안(게이트 생성) — 제안만, 승인/반려는 항상 휴먼. ⭐이 버전이 확定될"
     " 준비가 됐다고 판단될 때 휴먼 승인을 요청.",
     ProposeCanonicalInput, propose_canonical_version),
    # Chat (4)
    ("sprintable_send_chat_message",
     "[조직] conversation thread에 채팅 메시지 발송.",
     SendChatInput, send_chat_message),
    ("sprintable_create_conversation",
     "[조직] 새 conversation thread 생성.",
     CreateConversationInput, create_conversation),
    ("sprintable_list_chat_messages",
     "[조직] conversation thread 메시지 목록 조회.",
     ListChatMessagesInput, list_chat_messages),
    ("sprintable_get_chat_message",
     "[조직] conversation thread 내 메시지 단건 원문 조회(message_id로 즉시 픽업). ⭐웹훅 payload가"
     " 잘렸거나 원문이 의심될 때 재발신 요청 대신 이걸로 먼저 확인 — thread_id=conversation_id,"
     " message_id=조회할 메시지 id(top-level·리플 공용).",
     GetChatMessageInput, get_chat_message),
    # Meetings (6)
    ("sprintable_list_meetings",
     "[일감] 프로젝트 미팅 목록 조회.",
     ListMeetingsInput, list_meetings),
    ("sprintable_get_meeting",
     "[일감] 미팅 상세 조회.",
     MeetingIdInput, get_meeting),
    ("sprintable_create_meeting",
     "[일감] 미팅 생성.",
     CreateMeetingInput, create_meeting),
    ("sprintable_update_meeting",
     "[일감] 미팅 수정 (raw_transcript/ai_summary/decisions/action_items 포함).",
     UpdateMeetingInput, update_meeting),
    ("sprintable_delete_meeting",
     "[일감] 미팅 소프트 삭제.",
     MeetingIdInput, delete_meeting),
    ("sprintable_trigger_ai_summary",
     "[일감] 미팅 AI 요약 생성 트리거.",
     MeetingIdInput, trigger_ai_summary),
    # Standup (8)
    ("sprintable_standup_missing",
     "[일감] 스탠드업 미제출 멤버 조회.",
     StandupDateInput, standup_missing),
    ("sprintable_standup_history",
     "[일감] 최근 스탠드업 히스토리 조회.",
     StandupHistoryInput, standup_history),
    ("sprintable_get_standup",
     "[일감] 멤버+날짜 기준 스탠드업 조회.",
     GetStandupInput, get_standup),
    ("sprintable_save_standup",
     "[일감] 스탠드업 저장/업데이트.",
     SaveStandupInput, save_standup),
    ("sprintable_list_standup_entries",
     "[일감] 날짜 기준 스탠드업 목록 조회.",
     ListStandupEntriesInput, list_standup_entries),
    ("sprintable_get_retro_session_by_sprint",
     "[일감] 스프린트 레트로 세션 조회 (없으면 생성).",
     GetRetroSessionInput, get_retro_session),
    ("sprintable_update_retro_action_status",
     "[일감] 레트로 액션 아이템 상태 변경.",
     UpdateRetroActionStatusInput, update_retro_action_status),
    ("sprintable_checkin_sprint",
     "[일감] 스프린트 체크인 — 진행률 + 스탠드업 미제출 현황.",
     CheckinSprintInput, checkin_sprint),
    # Retro (7)
    ("sprintable_list_retro_sessions",
     "[일감] 레트로 세션 목록 조회.",
     ListRetroSessionsInput, list_retro_sessions),
    ("sprintable_create_retro_session",
     "[일감] 레트로 세션 생성.",
     CreateRetroSessionInput, create_retro_session),
    ("sprintable_vote_retro_item",
     "[일감] 레트로 아이템 투표.",
     VoteRetroItemInput, vote_retro_item),
    ("sprintable_add_retro_action",
     "[일감] 레트로 액션 아이템 추가.",
     AddRetroActionInput, add_retro_action),
    ("sprintable_change_retro_phase",
     "[일감] 레트로 세션 단계 변경.",
     ChangeRetroPhaseInput, change_retro_phase),
    ("sprintable_add_retro_item",
     "[일감] 레트로 아이템 추가 (good/bad/improve).",
     AddRetroItemInput, add_retro_item),
    ("sprintable_export_retro",
     "[일감] 레트로 마크다운 내보내기.",
     ExportRetroInput, export_retro),
    # Rewards (3)
    ("sprintable_get_wallet",
     "[조직] 팀원 보상 잔액 조회.",
     GetWalletInput, get_wallet),
    ("sprintable_give_reward",
     "[조직] 팀원 보상/패널티 지급.",
     GiveRewardInput, give_reward),
    ("sprintable_get_leaderboard_v2",
     "[조직] 보상 리더보드 조회.",
     GetLeaderboardInput, get_leaderboard_v2),
    # Notifications (3)
    ("sprintable_check_notifications",
     "알림 목록 조회.",
     CheckNotificationsInput, check_notifications),
    ("sprintable_mark_notification_read",
     "[조직] 알림 읽음 처리.",
     MarkNotificationReadInput, mark_notification_read),
    ("sprintable_mark_all_notifications_read",
     "[조직] 전체 알림 읽음 처리.",
     MarkAllNotificationsReadInput, mark_all_notifications_read),
    # Audit (1)
    ("sprintable_list_audit_logs",
     "[신뢰] 권한 감사 로그 조회 (Admin/Owner 전용).",
     ListAuditLogsInput, list_audit_logs),
    # Agent Runs (3)
    ("sprintable_emit_event",
     "[일감] 에이전트 런 이벤트 발행.",
     EmitEventInput, emit_event),
    ("sprintable_update_run_status",
     "[일감] 에이전트 런 상태 업데이트.",
     UpdateRunStatusInput, update_run_status),
    ("sprintable_poll_events",
     "에이전트 수신 대기 이벤트 폴링.",
     PollEventsInput, poll_events),
    # Webhooks (3)
    ("sprintable_list_webhook_configs",
     "[조직] Webhook config 목록 조회.",
     ListWebhookConfigsInput, list_webhook_configs),
    ("sprintable_upsert_webhook_config",
     "[조직] Webhook config 생성/수정. secret 설정 시 HMAC 서명 활성화.",
     UpsertWebhookConfigInput, upsert_webhook_config),
    ("sprintable_delete_webhook_config",
     "[조직] Webhook config 삭제.",
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
