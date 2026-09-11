"""E-MCP S2: 키별 MCP toolset SSOT.

API Key의 scope(list[str])가 허용 toolset 그룹을 보유한다(별도 마이그 없이 기존 scope 재사용).
백엔드가 그룹 정의·허용 해소·매니페스트의 단일 진실원천(SSOT)이고, MCP 서버(및 다른 호출자)는
이 모듈/매니페스트로 call-time enforcement(목록 숨김 + 호출 차단)를 수행한다.

tool_name(`sprintable_<verb>_<domain>`) → group 은 명시 키워드 매핑으로 결정(파일 의존 X).
destructive(delete_*/give_reward/close_sprint 등)는 그룹과 별개로 추가 게이팅한다.
"""
from __future__ import annotations

# ── toolset 그룹 키워드(tool 이름 부분일치, 위에서부터 우선) ──────────────────────
# 그룹: stories/tasks/sprints/epics/chat/docs/analytics/retro/standup/meetings/
#       notifications/webhooks/rewards/audit/agent_runs/canvas/admin/core
_GROUP_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("rewards", ("reward", "wallet", "leaderboard")),
    ("analytics", ("velocity", "health", "dashboard", "overview", "stats",
                   "sprint_summary", "recent_activity", "agent_stats", "blocked_stories",
                   "unassigned_stories", "member_workload", "overdue", "epic_progress",
                   # 계층 리네이밍 B1(story 1925): sprintable_get_goal_progress(신)도 이 그룹.
                   "goal_progress")),
    ("agent_runs", ("agent_run", "run_status", "update_run")),
    ("audit", ("audit",)),
    ("webhooks", ("webhook",)),
    ("notifications", ("notification",)),
    ("meetings", ("meeting",)),
    ("retro", ("retro",)),
    ("standup", ("standup",)),
    # story #2668: sprintable_submit_for_approval은 "doc" substring이 없다(propose_canonical_
    # version/give_reward 등과 동형 함정) — "submit_for_approval" 명시 추가 없으면 core로 오분류
    # 돼, role-scope 키(예 scope=["docs"])로 recruit된 에이전트가 이 도구를 호출 못 하는(403)
    # 채로 조용히 회귀한다 — 이 스토리가 고치려던 "발견 못 함"과 결이 같은 새 차단이라 미리 막는다.
    ("docs", ("doc", "search_docs", "submit_for_approval")),
    ("chat", ("chat", "message", "conversation")),
    ("sprints", ("sprint",)),
    ("hypotheses", ("hypothes",)),
    # 계층 리네이밍 B1(story 1925): "goal" 추가 — sprintable_add_goal 등 신 이름도 이 그룹으로
    # 분류(구 이름 sprintable_add_epic과 동일 group, role_template.default_tool_groups의 "epics"
    # literal은 유지 — 데이터 마이그 불요, 스탠드업 core-promotion 때와 동일 관례).
    ("epics", ("epic", "goal")),
    ("tasks", ("task",)),
    ("stories", ("story", "stories", "backlog", "claim", "checkin")),
    # story b4027b2e: E-CANVAS visual_artifacts가 임계(11개 도구·전용 REST 도메인)에 도달해
    # cross-cutting always-allow에서 전용 그룹으로 승격(C1-S3 당시 예고된 신설). "canonical_version"
    # (propose_canonical_version은 "artifact" substring이 없음)·"spec_pin"(핀 4종)까지 포괄.
    ("canvas", ("artifact", "canonical_version", "spec_pin")),
    ("admin", ("give_reward", "emit_event", "trigger_ai", "activate_sprint",
               "close_sprint", "create_sprint", "upsert_webhook", "delete_webhook",
               # story #2636: 이벤트 레지스트리 "등록"(admin 그룹 — 등록=org 관리 행위, PO
               # 확定 §범위5). "events" 그룹 키워드("event")보다 이 admin 항목이 먼저 매치돼야
               # 하므로 반드시 이 admin 튜플 안에 둔다(순서 의존 — 아래 events 항목 주석 참고).
               "register_event_definition", "update_event_definition")),
    # story #2634: 이벤트 레지스트리 발행 표면(publish_event/list_event_definitions) — "admin"
    # 뒤에 둔 이유는 순서 의존적이다: "emit_event"(admin 키워드)가 substring "event"를 포함하므로
    # "events" 그룹을 admin보다 앞에 두면 sprintable_emit_event의 기존 분류(admin)가 깨진다.
    # publish_event/list_event_definitions는 admin 키워드 어느 것과도 안 겹쳐 여기로 안전하게
    # 떨어진다(발행/구독은 admin급 파괴 작업이 아닌 일반 도메인 기능이라 admin에 안 묶는다).
    # story #2636: register_event_definition/update_event_definition도 "event" substring을
    # 포함하지만, 위 admin 튜플에 더 구체적인 키워드("register_event_definition"/
    # "update_event_definition")가 먼저 있어 이 항목까지 안 내려온다(admin이 이 events보다
    # 리스트 앞쪽 — tool_group()은 첫 매치를 반환).
    ("events", ("event",)),
    # story #3614 CHANGES(2026-09-07, 페드루 PO 判定)가 "channel_post" 키워드 하나로 이
    # 그룹을 최소 신설(sprintable_withdraw_channel_post_draft의 카탈로그 커버리지 공백
    # 임시 해소, PR#3972) — story #3631이 그 위에 나머지 콘텐츠 도구 키워드를 마저 얹어
    # 완성한다.
    #
    # "comment"는 바로 안 쓴다 — sprintable_add_artifact_comment/sprintable_
    # list_artifact_comments(canvas 그룹, "artifact" 키워드)와 겹친다. 이 리스트 순서
    # (canvas가 먼저)상 그 둘은 이미 canvas로 먼저 매치되므로 실질 충돌은 없지만,
    # "post_comment"(channel_post_comment류 실제 이름 패턴과 일치)로 더 구체화해 순서
    # 의존성 자체를 없앤다(방어적 이중 안전).
    #
    # "withdraw"는 의도적으로 뺐다 — 이 하나의 동사만으로 미래의 무관한 도구(예: 보상/지갑
    # 인출류)까지 이 그룹으로 잘못 끌어올 위험이 "channel_post" 등 구체 키워드보다 크다.
    # 지금 유일한 실 도구(withdraw_channel_post_draft)는 "channel_post" 키워드로 이미 잡힌다.
    # story #3769(2026-09-10): "content_rule" — sprintable_get_content_rules(신설, 콘텐츠
    # 규칙 읽기)도 같은 콘텐츠 파이프라인 도구다. "channel_post"/"site_post" 등과 겹치지
    # 않는 독립 키워드(순서 의존 없음).
    ("content", ("channel_post", "site_post", "channel_connection", "post_comment", "insight",
                 "content_rule")),
]

_CORE = "core"  # ping/notifications-check 등 기본 — 항상 허용

# 명시 비-그룹 핵심 도구(항상 허용 = picker 의 core 잠금 그룹).
# 2da32fbf(toolset-catalog): 키워드 미매칭으로 tool_group()=='core' 로 떨어지는 read-only 유틸
# (workflow_guide·team_members·poll_events)을 여기 포함 — picker 가 core(always-on)로 표시하는데
# enforcement 가 explicit scope 에서 거부하던 비정합 해소. read 유틸은 비파괴라 always-allow 안전.
_ALWAYS_ALLOWED: frozenset[str] = frozenset({
    # story #2304: "sprintable_ping"은 실재하지 않는 유령 이름이라 걷는다 — 이 목록에 둘 다
    # 적어 두는 "우연한 방패"는 다음 이름축 불일치도 조용히 지나가게 한다.
    "ping", "sprintable_my_dashboard", "sprintable_check_notifications",
    "sprintable_get_workflow_guide", "sprintable_list_team_members", "sprintable_poll_events",
    # P1-S12: get_workflow_guide 동형(read-only·에이전트 on-demand pull) — 항상 허용.
    "sprintable_get_loop_context",
    # S17: lock/unlock 은 file_locks.py 확인 결과 org/project-scoped 파괴적 아닌 협업 조율 도구
    # (advisory mutex — 실 데이터 삭제/변경 아님). 이전엔 "lock"/"unlock" 부분일치로 admin 그룹+
    # destructive 오분류돼 어떤 role 도 호출 불가했다(전 22 role_templates 의 default_tool_groups
    # 어디에도 admin 이 없음). 파일을 다루는 모든 working role 이 도메인 scope(stories/tasks 등)와
    # 무관하게 협업해야 하므로 stories/tasks 같은 특정 도메인 그룹에 묶지 않고, chat/team_members
    # 등과 동형인 cross-cutting 코디네이션 유틸로 core 취급(always-allow)한다.
    "sprintable_lock_files", "sprintable_unlock_files",
    # E-A2A-완성 S-A3(story 6d0454c3): link_gate_to_task — lock/unlock_files와 동형 cross-cutting
    # 선언 유틸(엔드포인트 자체가 self-scope 게이트를 가져 자기 소유 task에만 작용 — 데이터 파괴
    # 아님). A2A 위임을 받은 어떤 역할의 에이전트든 default_tool_groups와 무관하게 써야 하는 협업
    # 도구라 특정 도메인 그룹에 안 묶는다(lock/unlock과 동일 논리).
    "sprintable_link_gate_to_task",
    # E-VERIFY V0-S1(story 5a5ba27b): add_evidence — story/task 자기증명 첨부. work_item_id로
    # story든 task든 첨부 가능해 단일 도메인 그룹(stories 또는 tasks)에 못 묶고, link_gate_to_task와
    # 동형(자기 작업에 self-proof 첨부 = 데이터 파괴 아닌 협업/증명 유틸) — 어떤 역할의 working
    # agent든 default_tool_groups 무관하게 done 첨부해야 하므로 always-allow.
    "sprintable_add_evidence",
    # story #2709(AskUserQuestion 블로킹 대체): request_decision — 어떤 역할의 에이전트든
    # 판단이 필요한 순간 도메인 무관하게 써야 하는 협업 도구(link_gate_to_task/add_evidence와
    # 동일 논리 — 특정 work_item 도메인에 묶이지 않는 self-scope 발행 유틸). vendored 사본과
    # 동기화 필수(sprintable_mcp/toolset.py).
    "sprintable_request_decision",
    # story #2268(D단계, E-CONNECT — "판단 칸"): add_judgment/list_judgments — 판단/철회는
    # work_item_ids(다건 또는 0건 general)에 걸치는 cross-cutting 기록이라 add_evidence와
    # 동일 논리로 core 취급. vendored 사본과 동기화 필수(sprintable_mcp/toolset.py).
    "sprintable_add_judgment", "sprintable_list_judgments",
    # story #2268(C-10, E-CONNECT — "세션 시작 컨텍스트"): get_session_context — my_dashboard/
    # get_loop_context와 동형(read-only·self-scope pull, 특정 도메인 그룹 아님) core 취급.
    # PO 판정(2026-07-29): REST뿐이면 에이전트가 못 쓴다 — MCP core로 노출해야 실제로 도는
    # 자리가 된다. vendored 사본과 동기화 필수(sprintable_mcp/toolset.py).
    "sprintable_get_session_context",
    # story b4027b2e(SEC — 까심 #2140 QA④): E-CANVAS visual_artifacts 11종(원 6개 + 7fe16274
    # 핀 4종 + list_spec_pins)을 여기서 제거하고 전용 "canvas" 그룹(_GROUP_KEYWORDS)으로 이관했다.
    # 이전엔 cross-cutting always-allow였는데(C1-S3 당시 "추가 성장 시 전용 canvas 그룹 신설
    # 고려" 예고), REST 쪽 `/api/v2/visual-artifacts`가 `_PATH_GROUP_PREFIXES` 미등록 + 라우터가
    # scope 체크 의존성 자체를 안 씀 → toolgroup-제한(예 scope=['docs']) 키가 REST로 artifact
    # mutation을 무제한 통과(까심 라이브 실증: POST→201). REST를 조이면서 MCP 쪽을 always-allow로
    # 남기면 "도구는 보이는데 호출은 403"이 되므로 양쪽을 canvas 그룹으로 동시 이관(레거시
    # read/write scope 키는 설계상 전 그룹 허용이라 무회귀).
    # E-MCP-OPT(story ff6cb90d): list_projects/set_default_project — 키 자기 신원/스코프 조회·전환
    # 유틸(sprintable_my_dashboard·sprintable_ping과 동형: 특정 비즈니스 도메인 아닌 self-scope
    # 도구). set_default_project는 write지만 caller 자신의 기본 프로젝트 설정만 바꾸는 self-scope
    # 조작이라 파괴적이지 않음(has_project_access로 대상 검증). vendored 사본과 동기화 필수
    # (sprintable_mcp/toolset.py).
    "sprintable_list_projects", "sprintable_set_default_project",
    # story 205e6831(FR·대표요청): 대표 role이 불명확(role_template 22개 중 어느 것이든 될 수
    # 있음) — 개별 role의 default_tool_groups를 고치는 대신 스탠드업을 범용 업무로 core 편입
    # (선생님 방향: 스탠드업은 직무 무관 공통 업무). tool_group()은 여전히 "standup" 그룹으로
    # 분류하지만(피커 UI 라벨용), is_tool_allowed는 이 목록을 먼저 체크해 그룹/scope 무관 항상
    # 허용 — role_template.default_tool_groups에 "standup" 유무와 무관하게 모든 role이 호출
    # 가능해진다(pm/scrum-master 전용이던 걸 22개 role 전체로 확대 = 회귀 아닌 기능 추가).
    "sprintable_get_standup", "sprintable_save_standup", "sprintable_list_standup_entries",
    "sprintable_standup_history", "sprintable_standup_missing",
    # story #2597(E-AGENT-ONBOARD·A2A발견 P0-1, 문서 e-a2a-discovery-spike-design 갭 A):
    # list_agent_cards — sprintable_list_team_members와 동형(read-only·org-scope 로스터
    # 조회) core 취급. "누구에게 청할지" 발견은 role_template.default_tool_groups 유무와
    # 무관하게 어떤 role이든 필요한 cross-cutting 협업 유틸 — 여기 안 두면 대부분의
    # 스코프 키가 이 도구를 403으로 못 본다. vendored 사본과 동기화 필수
    # (sprintable_mcp/toolset.py).
    "sprintable_list_agent_cards",
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
    """파괴적/민감 도구 — 그룹과 별개로 추가 게이팅.

    S17: lock_files/unlock_files 는 여기서 제외 — file_locks.py 확인 결과 advisory
    mutex(org/project-scoped 협업 조율)일 뿐 데이터 삭제/변경이 아니다(_ALWAYS_ALLOWED 참고).
    """
    n = tool_name.lower()
    return (
        "delete" in n
        or "give_reward" in n
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


# ── 7b63c226: BE 서버사이드 path→group scope 강제 ────────────────────────────
# MCP 서버(client)의 is_tool_allowed/tool_group 와 **동일 그룹 소스**(ALL_GROUPS·resolve_policy)를
# 재사용해 드리프트를 막는다. BYO 에이전트가 MCP 클라를 우회해 BE 엔드포인트를 직접 호출해도
# 키 scope 외 그룹은 403 — 진짜 boundary.

# always-allowed(core/비파괴 read) 엔드포인트 — scope 막론 허용(CP③ bypass).
# check_notifications·poll_events·list_team_members·my_dashboard·manifest·세션/자기 self-ops.
_ALWAYS_ALLOWED_PATH_PREFIXES: tuple[str, ...] = (
    "/api/v2/notifications",
    "/api/v2/events",
    "/api/v2/team-members",
    "/api/v2/dashboard",
    "/api/v2/mcp",
    "/api/v2/me",
    "/api/v2/auth",
    "/api/v2/current-project",
    "/api/v2/agent",
    # E-VERIFY V0-S1: evidence는 story/task 어느 쪽이든 첨부되는 cross-cutting 자기증명이라
    # 단일 도메인 그룹에 안 묶임(_ALWAYS_ALLOWED의 sprintable_add_evidence와 동일 근거).
    "/api/v2/evidence",
    # story #2268(D단계): judgments도 evidence와 동일 근거(work_item_ids 다건/0건 cross-cutting).
    "/api/v2/judgments",
    # story 205e6831(FR·대표요청): MCP _ALWAYS_ALLOWED에 스탠드업 5종을 core 편입했는데 여기(REST
    # path scope)를 같이 안 고치면 canvas 선례(b4027b2e)와 동일한 "도구는 보이는데 호출은 403"
    # 불일치가 재발한다 — tools/list는 항상 노출하지만 실제 HTTP 호출은 _check_api_key_scope가
    # 여전히 "standup" 그룹 미보유 키를 막았을 것. 아래 _PATH_GROUP_PREFIXES의 standup 매핑도 같이
    # 제거(이 prefix가 먼저 매치돼 always-allowed로 빠지므로 그 매핑은 이제 도달 불가 dead 항목).
    "/api/v2/standups",
)

# path-prefix → toolset group(라우터 리소스 정렬). 모든 group 은 ALL_GROUPS 소속이어야 함.
_PATH_GROUP_PREFIXES: tuple[tuple[str, str], ...] = (
    ("/api/v2/rewards", "rewards"),
    ("/api/v2/wallet", "rewards"),
    ("/api/v2/leaderboard", "rewards"),
    ("/api/v2/audit-logs", "audit"),
    ("/api/v2/webhooks", "webhooks"),
    ("/api/v2/conversations", "chat"),
    ("/api/v2/meetings", "meetings"),
    ("/api/v2/retros", "retro"),
    ("/api/v2/stories", "stories"),
    ("/api/v2/tasks", "tasks"),
    ("/api/v2/sprints", "sprints"),
    ("/api/v2/hypotheses", "hypotheses"),
    ("/api/v2/epics", "epics"),
    # 계층 리네이밍 B1(story 1925): 신 경로(/api/v2/goals)도 동일 "epics" 그룹 — main.py가 같은
    # router를 신/구 prefix 둘 다로 include하므로 REST scope 게이트도 짝을 맞춰야 한다(안 그러면
    # canvas 선례 b4027b2e와 동일한 "신 경로만 게이트 누락" 불일치 재발).
    ("/api/v2/goals", "epics"),
    ("/api/v2/docs", "docs"),
    ("/api/v2/agent-runs", "agent_runs"),
    ("/api/v2/analytics", "analytics"),
    # story b4027b2e(SEC): 미등록 시 permissive-unmapped 폴백으로 toolgroup-제한 키가 전부 통과
    # (까심 라이브 실증). ⚠️ 등록만으론 불충분 — app/routers/visual_artifacts.py 라우터가
    # `get_verified_org_id`(이 체크를 트리거하는 의존성)를 안 쓰면 이 매핑 자체가 무효라 라우터
    # 쪽 의존성 배선도 함께 필요(이 변경과 짝).
    ("/api/v2/visual-artifacts", "canvas"),
)

# story #3654(BE·REST·소형, 페드루 PO 確定 2026-09-07) — org 스코프 콘텐츠 경로
# (`/api/v2/organizations/{org_id}/<segment>...`). `_PATH_GROUP_PREFIXES`(위, 고정
# prefix 매칭)는 이 형을 표현 못 한다 — org_id가 동적 값으로 리터럴 prefix 사이에 끼어
# 있어 `path.startswith(prefix)`가 안 통한다(test_3614_content_toolset_group_changes.py
# 의 옛 pin이 이 갭을 기록해 뒀었다). 정규식 신설 대신 org_id **뒤 첫 세그먼트**만 뽑아
# (그라운딩③ 싼 쪽) 이 표와 대조한다 — org_id 값 자체는 안 본다(UUID든 아니든 위치만).
#
# 그라운딩② 전수 — 6개 라우터(channel_posts·channel_connections·site_posts·
# channel_post_comments·insight_snapshots·publishing_metrics)뿐 아니라 같은 콘텐츠
# 파이프라인의 나머지 org-scoped 라우터(channel_post_comment_replies·insights_board)
# 까지 실제 세그먼트를 전수 스캔하면 9개다(스토리 초안이 5개로 적었던 것보다 많다 —
# publication-commands(발행 재시도)·comments(댓글 답변 초안)·insights/insights-board
# (콘텐츠 성과 조회)도 같은 콘텐츠 파이프라인 자원이라 포함했다, PO 재확認 요청 완료).
_ORG_SCOPED_PATH_GROUP_SEGMENTS: tuple[tuple[str, str], ...] = (
    ("channel-posts", "content"),
    ("site-posts", "content"),
    ("publication-commands", "content"),
    ("channel-connections", "content"),
    ("publications", "content"),
    ("comments", "content"),
    ("insights", "content"),
    ("insights-board", "content"),
    ("publishing-metrics", "content"),
    # story #3769(2026-09-10): sprintable_get_content_rules 신설로 "MCP 도구/키워드 0건"
    # 사유가 더 이상 사실이 아니게 됐다 — 예외 목록(아래)에서 이리로 이관.
    ("content-rules", "content"),
    # story #3805(BE PR1 CI 정정, 카디르 실측·페드루 전달 2026-09-11) — 「반응」
    # (Engagement) 화면. channel_post_comments와 같은 원본 테이블·같은 콘텐츠
    # 파이프라인 자원이라 "comments"와 동형으로 content면 등재.
    ("engagement", "content"),
)

# story #3654(정적 가드) — `test_3654_org_scoped_content_rest_group.py`의 가드 테스트가
# `app/routers/` 전수를 스캔해, `/api/v2/organizations/{org_id}/<segment>...`(또는
# `/{id}/<segment>`) 형 라우터의 모든 세그먼트가 위 표에 있거나 이 목록에 «이유»와 함께
# 있어야만 통과시킨다 — 새 org-scoped 자원이 표·목록 어느 쪽에도 없이 추가되면 가드가
# 스스로 RED(b4027b2e류 사각지대의 재발을 "조용한 통과"가 아니라 "빨간 실패"로 바꾼다).
# 아래 사유는 전부 실측 확認(sprintable_mcp/ 전수 grep) — 이 세그먼트들과 매칭되는 MCP
# 도구/키워드가 현재 0건이라, REST를 미매핑으로 두는 것이 MCP 쪽 취급(core, 이미 존재하는
# 별도 갭)과 최소한 "새로 벌어지지는" 않는다는 뜻 — 이 갭 자체를 정당화하지 않는다(이
# 스토리 범위 밖일 뿐, 후속 후보로 남긴다).
_ORG_SCOPED_UNMAPPED_SEGMENTS_WITH_REASON: dict[str, str] = {
    "campaigns": "MCP 도구/키워드 0건(REST·MCP 양쪽 다 core 취급 — 이 스토리가 새로 벌리는 격차 아님)",
    "connectors": "MCP 도구/키워드 0건(connectors.py, 위와 동형)",
    # story #3769(2026-09-10): "content-rules"는 sprintable_get_content_rules 신설로
    # _ORG_SCOPED_PATH_GROUP_SEGMENTS(위)로 이관 — 여기 목록에선 제거(이중 등재 금지,
    # test_content_group_reason_dict_has_no_overlap_with_mapped_segments 참고).
    # "generation-budget"은 그 도구가 내부적으로 함께 읽어 응답에 병합하지만(비 1:1 REST
    # 프록시), 이 세그먼트 자체를 독립 매핑하진 않는다 — 이유가 "0건"에서 "간접 소비"로
    # 바뀌었을 뿐 REST 직접 호출 경로는 여전히 미매핑(permissive) 그대로 둔다(범위 밖 —
    # 별도 필요성이 생기면 그때 매핑).
    "generation-budget": "MCP 도구/키워드 있음(sprintable_get_content_rules가 간접 소비, 3769) — "
                          "REST 1:1 전용 도구는 여전히 0건, 세그먼트 직접 매핑은 범위 밖으로 보류",
    "domain-labels": "MCP 도구/키워드 0건(domain_labels.py, 사이트 도메인 설정·admin류)",
    "gate-config": "MCP 도구/키워드 0건(gate_config.py, 승인 게이트 거버넌스 설정·admin류)",
    "measurement-connections": "MCP 도구/키워드 0건(measurement_connections.py, GA4 연결 설정)",
    "invites": "MCP 도구/키워드 0건(org_invites.py, org 멤버 초대·admin류)",
    "metering-key": "MCP 도구/키워드 0건(pageview_metering.py, hosted-site 계측 설정·admin류)",
    "pageviews": "MCP 도구/키워드 0건(pageview_metering.py, hosted-site pageview 조회)",
    "impact": "MCP 도구/키워드 0건(organizations.py, org 임팩트 조회·admin류)",
    "resolve": "MCP 도구/키워드 0건(organizations.py, slug→org 해소·session 유틸류)",
    "(empty/root)": "MCP 도구/키워드 0건(organizations.py, org 목록/생성 자체·admin류)",
    "(root, org_id only)": "MCP 도구/키워드 0건(organizations.py, org 단건 조회/수정·admin류)",
    # story #3806(Phase3·3-2 PR3, 페드루 PO 確定 2026-09-11 — CI 빨감 정정) —
    # ads_boost_execution.py의 start/pause/resume. content 매핑표(에이전트 읽기
    # 전제)가 아니라 이 목록이 맞는 방향 — AC4가 에이전트를 실행/예산 API에서
    # 명시적으로 배제(제안만)하므로 MCP 도구 자체를 0건으로 유지하는 것이 설계
    # 의도. engagement(#3805)와 반대 방향.
    "ads-boosts": "human-only (3806 AC4: agents propose only, no execution/budget API access); "
                  "no MCP tool exposes it",
}


def _org_scoped_content_group(path: str) -> str | None:
    """story #3654 — `/api/v2/organizations/<org_id>/<segment>[...]`에서 `<segment>`만
    뽑아 `_ORG_SCOPED_PATH_GROUP_SEGMENTS`와 대조한다. org_id 자체는 값 무관(위치만
    본다) — 정규식 없이 split만으로 충분하다."""
    parts = [p for p in path.split("/") if p]
    # ["api", "v2", "organizations", "<org_id>", "<segment>", ...]
    if len(parts) < 5 or parts[0] != "api" or parts[1] != "v2" or parts[2] != "organizations":
        return None
    segment = parts[4]
    for seg, group in _ORG_SCOPED_PATH_GROUP_SEGMENTS:
        if seg == segment:
            return group
    return None


def path_to_tool_group(path: str) -> str | None:
    """요청 path → toolset group. always-allowed/미매핑(core 취급)이면 None(강제 면제)."""
    for prefix in _ALWAYS_ALLOWED_PATH_PREFIXES:
        if path == prefix or path.startswith(prefix + "/"):
            return None
    for prefix, group in _PATH_GROUP_PREFIXES:
        if path == prefix or path.startswith(prefix + "/"):
            return group
    org_scoped_group = _org_scoped_content_group(path)
    if org_scoped_group is not None:
        return org_scoped_group
    return None  # 미매핑 → core 취급(허용)


def path_allowed_for_scope(path: str, scope: list[str] | None) -> bool:
    """7b63c226: API-key 요청 path 가 scope 의 허용 그룹에 속하는지(서버사이드 boundary).

    always-allowed/미매핑 → True. 매핑된 group 은 resolve_policy 의 allowed_groups 에 있어야 True.
    레거시(read/write)·full scope → allowed_groups=전체 → 모든 그룹 True(일반키 무회귀).
    """
    group = path_to_tool_group(path)
    if group is None or group not in ALL_GROUPS:
        return True  # 면제 or 미지(ALL_GROUPS 드리프트 방어) → over-block 방지
    return group in resolve_policy(scope)["allowed_groups"]


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
    # story #2304: 실등록명은 "ping"이다(server.py:311 `@mcp.tool()` 데코레이터, `_TOOL_DEFS`
    # 밖에서 단독등록 — sprintable_mcp/tests/test_e2e_dev.py 등 다수 테스트·라이브 MCP client가
    # 이미 이 이름으로 실호출한다). "sprintable_ping"은 이 목록에만 존재하던 유령 이름이었다.
    # ⛔접두사 없음은 실수가 아니라 «의도»다 — 나머지 114개가 전부 sprintable_* 라고 이 줄을
    # "sprintable_ping"으로 되돌리지 말 것. 실등록명이 ping이고 e2e·라이브 MCP client가 이
    # 이름으로 부른다. 바꾸려면 클라이언트 쪽이 먼저 따라와야 한다(server.py:311 데코레이터
    # 개명 + 모든 호출자 마이그 선행, story #2304).
    "ping",
    "sprintable_activate_sprint", "sprintable_add_epic", "sprintable_add_goal",
    "sprintable_add_retro_action",
    "sprintable_add_retro_item", "sprintable_add_story", "sprintable_add_task",
    "sprintable_assign_story_to_sprint", "sprintable_change_retro_phase",
    "sprintable_check_notifications", "sprintable_checkin_sprint", "sprintable_claim_story",
    "sprintable_close_sprint", "sprintable_create_conversation", "sprintable_create_doc",
    "sprintable_create_meeting", "sprintable_create_retro_session", "sprintable_create_sprint",
    "sprintable_delete_meeting",
    # E-SECURITY SEC-S1(확장): sprintable_delete_story/task/epic/doc 의도적 제거(에이전트
    # hard-delete 차단 — 까심 적대적 QA가 delete_story만으로는 반쪽임을 발견, story와 동형 확대).
    # E-SECURITY SEC-S8 확장: sprintable_delete_sprint도 동일 사유로 제거.
    "sprintable_delete_webhook_config", "sprintable_emit_event", "sprintable_export_retro",
    "sprintable_get_agent_stats", "sprintable_get_blocked_stories", "sprintable_get_doc",
    "sprintable_get_epic_progress", "sprintable_get_goal_progress",
    "sprintable_get_leaderboard_v2", "sprintable_get_meeting",
    "sprintable_get_member_workload", "sprintable_get_overdue_tasks", "sprintable_get_project_health",
    "sprintable_get_project_overview", "sprintable_get_recent_activity",
    "sprintable_get_retro_session_by_sprint", "sprintable_get_sprint_velocity_history",
    "sprintable_get_standup", "sprintable_get_task", "sprintable_get_unassigned_stories",
    "sprintable_get_velocity", "sprintable_get_wallet", "sprintable_get_workflow_guide",
    "sprintable_give_reward", "sprintable_list_audit_logs", "sprintable_list_backlog",
    "sprintable_get_chat_message",
    "sprintable_list_chat_messages", "sprintable_list_conversations", "sprintable_list_docs", "sprintable_list_epics",
    "sprintable_list_goals",
    "sprintable_list_meetings", "sprintable_list_my_tasks", "sprintable_list_retro_sessions",
    "sprintable_list_sprints", "sprintable_list_standup_entries", "sprintable_list_stories",
    "sprintable_list_tasks", "sprintable_list_team_members", "sprintable_list_webhook_configs",
    "sprintable_lock_files", "sprintable_mark_all_notifications_read",
    "sprintable_mark_notification_read", "sprintable_my_dashboard", "sprintable_poll_events",
    "sprintable_save_standup", "sprintable_search_docs", "sprintable_search_stories",
    "sprintable_send_chat_message", "sprintable_sprint_summary", "sprintable_standup_history",
    "sprintable_standup_missing",
    "sprintable_submit_for_approval",
    # story #2010: sprintable_transition_goal — 목표 lifecycle 전이 전용 신설(구 _epic 별칭
    # 없음). tool_group()은 "goal" substring 매칭으로 "epics" 그룹에 귀속(add_goal/update_goal/
    # list_goals와 동일 그룹) — role_template.default_tool_groups의 "epics" literal이 그대로
    # 커버하므로 role_template 데이터 마이그 불요.
    "sprintable_transition_goal",
    "sprintable_trigger_ai_summary",
    "sprintable_unassign_story_from_sprint", "sprintable_unclaim_story", "sprintable_unlock_files",
    "sprintable_update_doc", "sprintable_update_epic", "sprintable_update_goal",
    "sprintable_update_meeting",
    "sprintable_update_retro_action_status", "sprintable_update_run_status",
    "sprintable_update_sprint", "sprintable_update_story", "sprintable_update_story_status",
    "sprintable_update_task", "sprintable_update_task_status", "sprintable_upsert_webhook_config",
    "sprintable_vote_retro_item",
    # hypotheses (E1-S5)
    "sprintable_list_hypotheses", "sprintable_get_hypothesis", "sprintable_create_hypothesis",
    "sprintable_update_hypothesis", "sprintable_link_hypothesis", "sprintable_confirm_hypothesis",
    # loops (E-LOOP-LEDGER P1-S12)
    "sprintable_get_loop_context",
    # a2a HITL writer (E-A2A-완성 S-A3) + 발견 (story #2597, E-AGENT-ONBOARD·A2A발견 P0-1)
    "sprintable_link_gate_to_task", "sprintable_list_agent_cards",
    # evidence (E-VERIFY V0-S1)
    "sprintable_add_evidence",
    # 비동기 결정 요청 (story #2709, AskUserQuestion 블로킹 대체)
    "sprintable_request_decision",
    # 판단 칸 (story #2268, D단계)
    "sprintable_add_judgment", "sprintable_list_judgments",
    # 세션 시작 컨텍스트 (story #2268, C-10)
    "sprintable_get_session_context",
    # visual artifacts (E-CANVAS C1-S3 + C2-S6 코멘트 + C3-S7 편집 + C4-S8 정본 제안 + 핀 저작 story 7fe16274)
    "sprintable_create_artifact", "sprintable_get_artifact", "sprintable_list_artifacts",
    "sprintable_list_artifact_comments", "sprintable_add_artifact_comment",
    "sprintable_edit_artifact", "sprintable_propose_canonical_version",
    "sprintable_list_spec_pins", "sprintable_create_spec_pin", "sprintable_update_spec_pin",
    "sprintable_delete_spec_pin",
    # story b6b9c52d(#2707 부수): sprintable_import_image_artifact — base64 원콜 이미지 임포트
    # 신설(Bash/HTTP 클라이언트 없는 에이전트용 create_artifact 대안). tool_group()은 "artifact"
    # substring 매칭으로 이미 "canvas" 그룹 귀속(신규 매핑 불요).
    "sprintable_import_image_artifact",
    # story #1922: sprintable_delete_artifact — artifact soft delete(생성자 전용) 전용 신설.
    # #2010(sprintable_transition_goal)이 이 SSOT 목록 등록을 처음 커밋에서 빠뜨려 role-template
    # picker 카탈로그/신규 에이전트 채용 치트시트에서 누락됐던 갭(follow-up 커밋 8126465e로 정정)을
    # 이번엔 최초 커밋부터 함께 반영. tool_group()은 "artifact" substring 매칭으로 "canvas" 그룹
    # 귀속(create_artifact/edit_artifact/delete_spec_pin과 동일 경로) — role_template의 "canvas"
    # literal이 그대로 커버해 데이터 마이그 불요. is_destructive()도 "sprintable_delete" 접두로
    # True(delete_spec_pin과 동형 — canvas 그룹 + destructive scope 둘 다 필요).
    "sprintable_delete_artifact",
    # projects (E-MCP-OPT story ff6cb90d)
    "sprintable_list_projects", "sprintable_set_default_project",
    # events (story #2634) — POST /api/v2/events/publish(#2633) 발행 + GET /definitions 카탈로그.
    "sprintable_publish_event", "sprintable_list_event_definitions",
    # events registry 등록(story #2636) — POST/PATCH /api/v2/events/definitions(org 커스텀).
    "sprintable_register_event_definition", "sprintable_update_event_definition",
    # channel post drafts (story #3614) — 이 도메인의 첫 MCP 도구. "channel_post"/"withdraw"
    # 둘 다 _GROUP_KEYWORDS에 없어 tool_group()이 core로 분류한다(cross-cutting 취급) —
    # 콘텐츠 전용 그룹이 아직 없다는 기존 갭(REST _PATH_GROUP_PREFIXES에도 channel-posts
    # 미등록, 동일 갭)의 연장선. 새 그룹 신설은 이 스토리 범위 밖 — 후속 스토리 후보로 남긴다.
    "sprintable_withdraw_channel_post_draft",
    # 발행물 인사이트(story #3651) — 이름에 "insight"가 있어 _GROUP_KEYWORDS의 "content"
    # 그룹(3631 신설)이 이미 커버한다(위 withdraw와 달리 새 갭이 아니다).
    "sprintable_get_publication_insights",
    # 콘텐츠 규칙 읽기(story #3769) — "content_rule" 키워드로 "content" 그룹.
    "sprintable_get_content_rules",
)

# picker 표시 순서(비파괴 먼저). order 필드 힌트 + 배열 순서 둘 다 이 순서.
# story 205e6831: "standup"을 여기서 제거 — 스탠드업 5종 전부가 _ALWAYS_ALLOWED(core)로 편입돼
# build_toolset_catalog()의 always-allowed 제외 로직상 이 그룹은 영구적으로 tools=[]가 된다
# (모든 그룹은 멤버를 가져야 하는 카탈로그 계약 위반). "standup"은 _GROUP_KEYWORDS/ALL_GROUPS엔
# 그대로 남겨둔다 — pm/scrum-master role_template.default_tool_groups가 여전히 이 literal
# 토큰을 갖고 있어 제거 시 validate_tool_groups()가 unknown-group ValueError를 던진다(그
# 토큰 자체는 이제 no-op이지만 seed seed 마이그 없이 여길 건드리면 recruit/rotate가 깨진다).
_CATALOG_DISPLAY_ORDER: tuple[str, ...] = (
    "stories", "tasks", "sprints", "epics", "hypotheses", "chat", "docs", "analytics", "retro",
    "meetings", "notifications", "webhooks", "rewards", "audit", "agent_runs", "canvas",
    # story #2634: publish_event/list_event_definitions — 새 그룹이라 role_template.
    # default_tool_groups에 아직 이 토큰을 가진 role이 없다(선생님 승인 게이트 — 데이터
    # 마이그 없이 여기 등록만으로는 아무 role도 자동으로 이 도구를 못 쓴다, fail-closed).
    "events",
    # story #3614 CHANGES가 최소 신설(events와 동일 이유로 당시 fail-closed) — story #3631
    # (alembic 0350)이 growth-hacker·performance-marketer 2 role_template.default_tool_groups
    # 에 "content" 토큰을 배선해 실제로 도는 자리로 완성한다(dev 실측 — 뭉클랩 활성
    # 에이전트 11 전수 훑어도 이 2 role 밖에서 recruit된 콘텐츠 전담 role 0건).
    "content",
)


def build_toolset_catalog() -> dict:
    """toolset-catalog 응답(picker SSOT). 그룹별 멤버 툴 + core/destructive 플래그 + order.

    계약(FE `lib/toolset-catalog.ts`): {groups: [{key, tools[], is_core, is_destructive, order}]}.
    - key = enforcement 그룹 토큰(scope 저장값·불변). label/description 은 FE i18n(BE 미제공).
    - tools = tool_group() SSOT 매핑(항상허용=core 로 통합, 그룹별서 제외).
    - is_core = core(항상허용 잠금 그룹). is_destructive = admin(위험 작업 격리·opt-in).
    - 순서: core → 비파괴 15그룹(_CATALOG_DISPLAY_ORDER) → admin(파괴적) 마지막.
    """
    # story #2304: 예전엔 "sprintable_" 접두사로 필터했는데, 그 필터의 유일한 실효과가
    # "ping"(비접두사, 실등록명)을 core 그룹에서 조용히 빼는 것이었다 — _ALWAYS_ALLOWED가
    # 이제 정확한 이름만 담으므로 필터 없이 그대로 쓴다.
    always = set(_ALWAYS_ALLOWED)
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
