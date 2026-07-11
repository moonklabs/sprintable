"""E-SECURITY SEC-S8(story 83ea3d6a) 회귀가드 — CI 강제 consumer test.

S20(`5736c1a5`) authz_coverage_lib.py의 project-scope axis(PROJECT_PARAM_RE/
PROJECT_GUARD_FUNCTIONS)를 실제로 CI에 물리는 첫 consumer(S20 자체는 스캐너만 만들고
"새 라우트가 가드 없으면 CI가 막는" 강제 테스트를 커밋하지 않은 게 오늘 R~EE 스윕이
반복적으로 재발한 진짜 근본 — supply(스캐너) 있는데 demand(CI 강제)가 없었다).

ratchet 패턴: 오늘 스윕(2026-07-11) 시점 기준 project-scope 파라미터(project_id/story_id/
sprint_id/epic_id/doc_id/meeting_id/parent_id)를 가졌는데 가드가 감지되지 않는 라우트
62건을 파일-단위로 직접 실사해 분류했다 — CRITICAL 3건(standups.upsert_standup/add_feedback·
oss.oss_seed)은 EE(#2048)로 즉시 봉인했고, 나머지는 두 그룹으로 baseline에 동결한다:

- ``_FALSE_POSITIVE_ALLOWLIST``: 실제로는 안전(다른 이름의 가드를 1-hop 아래서 호출하거나,
  admin-gate·server-derived param 등으로 스캐너의 단일-바디-스캔이 못 본 것) — 영구 유지,
  이유 주석 필수.
- ``_KNOWN_DEBT_ALLOWLIST``: 실 GAP이지만 CRITICAL이 아니라 오늘 즉시 fix 대상은 아님
  (HIGH/MEDIUM/LOW) — 점진적으로 fix하며 이 dict에서 하나씩 빼는 게 상환 진행의 증거.

⚠️알려진 스캐너 한계(EE #2048 까심 QA가 재확認): 이 스캐너는 "가드 함수가 body 안에서
호출됐는가"만 보고 "그 가드에 넘긴 project_id가 **실제 리소스의 project**인지 **caller가
body에서 주장한 값**인지"는 구분 못한다 — add_feedback이 처음엔 `resolve_member(project_id=
body.project_id)`를 호출해 스캐너 통과였지만, body.project_id(호출자 주장값)만 검증하고
path의 entry가 실제 그 project 소속인지 대조하지 않아 우회 가능했다("body-claimed vs
resource-actual" 클래스). 이건 정적 AST로는 못 잡는 축이라 — 새 project-scope 가드를 추가할
때는 반드시 realdb 테스트로 "리소스가 실제로 caller 무권한 project 소속인데 body가 다른
project를 주장하는" 시나리오까지 실증해야 한다(단순 "가드 호출 여부"로 안심 금지).

이 테스트가 강제하는 것은 ONE 방향뿐이다: **baseline에 없는 새 미가드 라우트가 생기면
CI가 즉시 RED**. baseline 안의 기존 62건(현재는 fix로 줄어든 상태)은 조용히 pass —
그것들을 fix하는 게 이 테스트의 책임이 아니라 각자의 SEC-S8 개별 PR(R~EE류)의 책임이다."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from authz_coverage_lib import (  # noqa: E402
    PROJECT_GUARD_FUNCTIONS,
    PROJECT_PARAM_RE,
    enumerate_routes_matching,
    has_guard,
)

# ── false positive: 실제로는 안전 — 영구 allowlist(이유 주석 필수) ────────────────────
_FALSE_POSITIVE_ALLOWLIST: dict[str, str] = {
    "app.routers.dispatch:dispatch_entity":
        "body.project_id는 사용되지 않는 dead field — entity_project_id는 서버가 엔티티 조회로 도출",
    "app.routers.assets:list_assets":
        "_scope_filter(auth,org_id,project_id) 헬퍼가 has_project_access/accessible_project_ids_in_org를 1-hop 아래서 호출",
    "app.routers.conversations:list_conversations":
        "_resolve_member(auth,org_id,db,project_id=) 로컬 wrapper가 resolve_member(project_id=)를 1-hop 아래서 호출",
    "app.routers.epics:create_epic":
        "enforce_body_context()가 has_project_access를 내부에서 호출(캐노니컬 가드, 이름만 다름)",
    "app.routers.hypotheses:list_hypotheses":
        "Depends(get_project_scoped_org_id)가 동일 project_id 쿼리파라미터로 has_project_access 검증",
    "app.routers.loops:list_loops":
        "Depends(get_project_scoped_org_id) 동일 패턴",
    "app.routers.gate_metrics:get_hitl_gate_metrics":
        "is_org_owner_or_admin 가드 — 거버넌스/오버사이트 데이터는 의도적으로 org 전체 admin 시야",
    "app.routers.workflow_line_config:create_draft_version":
        "_require_draft_author(session,actor,org_id,project_id)가 이름과 달리 admin-level project_auth 접근권을 강제(in-code 문서화됨)",
    "app.routers.workflow_line_config:list_versions_endpoint":
        "동일 _require_draft_author admin-gate",
    "app.routers.workflow_line_config:resolve_preview":
        "동일 _require_draft_author admin-gate",
    "app.routers.workflow_line_config:get_active_line":
        "동일 _require_draft_author admin-gate",
    "app.routers.docs:list_docs":
        "Depends(get_project_scoped_org_id) 동일 패턴",
    "app.routers.meetings:create_meeting":
        "enforce_body_context()가 has_project_access를 내부에서 호출",
    "app.routers.stories:list_stories":
        "Depends(get_project_scoped_org_id) 동일 패턴",
    "app.routers.project_access:list_project_access":
        "_require_owner_or_admin(project_id,...)가 has_project_role(min_role=admin)을 1-hop 아래서 호출",
    "app.routers.project_access:create_project_access":
        "동일 _require_owner_or_admin/has_project_role 가드",
    "app.routers.project_access:delete_project_access":
        "동일 _require_owner_or_admin/has_project_role 가드",
    "app.routers.team_members:claim_story":
        "assert_caller_is_member(id,...)로 self-scope 강제 후 body.story_id는 Story.project_id==member.project_id로 서버파생 제약(클라 project 주입 불가)",
    "app.routers.event_notifications:list_notifications":
        "_resolve_member_id(auth,org_id,db,project_id=) 로컬 wrapper가 resolve_member(project_id=)를 1-hop 아래서 호출",
    "app.routers.event_notifications:get_unread_count":
        "동일 _resolve_member_id 가드",
    "app.routers.event_notifications:mark_all_read":
        "동일 _resolve_member_id 가드",
    "app.routers.rewards:get_balance":
        "_assert_self_or_org_admin(member_id,...) — 본인 잔액 또는 org admin만 조회 가능해 project_id 자체는 blast-radius가 self-data로 제한",
    "app.routers.current_project:set_current_project":
        "assert_caller_is_member self-scope 후 (member_id, body.project_id) TeamMember 행 존재를 요구 — has_project_access보다 엄격(IDOR 아님)",
    "app.routers.project_settings:upsert_project_settings":
        "has_project_role(body.project_id, min_role=admin) 가드",
    "app.routers.analytics:get_overview":
        "SEC-S8 DD(#2047)에서 추가된 로컬 _assert_project_access(repo,auth,project_id) wrapper가 has_project_access를 1-hop 아래서 호출",
    "app.routers.analytics:get_member_workload":
        "동일 _assert_project_access 가드",
    "app.routers.analytics:get_velocity_history":
        "동일 _assert_project_access 가드",
    "app.routers.analytics:get_recent_activity":
        "동일 _assert_project_access 가드",
    "app.routers.analytics:get_epic_progress":
        "동일 _assert_project_access 가드",
    "app.routers.analytics:get_agent_stats":
        "동일 _assert_project_access 가드",
    "app.routers.analytics:get_project_health":
        "동일 _assert_project_access 가드",
    "app.routers.analytics:get_burndown":
        "DD(#2047)에서 sprint.project_id 조회 후 _assert_project_access 호출(org_id 자체는 CRITICAL cross-org fix로 별도 봉인 완료)",
    "app.routers.analytics:get_sprint_velocity":
        "동일 패턴(sprint.project_id 조회 후 _assert_project_access)",
    "app.routers.workflow_executions:list_executions":
        "설계상 안전(SEC-S8 BB 정리) — non-admin은 target_agent_id==member_id로 self-scope, admin은 org 전체 권한으로 통과",
    "app.routers.visual_artifacts:list_artifacts":
        "이전 SEC-S8 finding(G/N)으로 이미 봉인 — project_id가 클라 파라미터가 아니라 auth 컨텍스트에서 서버파생(_get_org_project)",
    "app.routers.open_api_keys:create_project_api_key":
        "require_admin 가드 + project_id가 클라 파라미터가 아니라 JWT app_metadata에서 서버파생(_get_project_id)",
    "app.routers.open_api_keys:list_project_api_keys":
        "동일 require_admin + JWT-derived project_id",
    "app.routers.open_api_keys:revoke_project_api_key":
        "동일 require_admin + JWT-derived project_id, 추가로 key.project_id==project_id 소유권 검증",
}

# ── known debt: 실 GAP(HIGH/MEDIUM/LOW) — CRITICAL 3건(EE #2048)은 이미 fix, 나머지는
# ratchet(PO 결 2026-07-11: baseline 동결 + 점진 상환). fix되면 이 dict에서 제거할 것.
_KNOWN_DEBT_ALLOWLIST: dict[str, str] = {
    "app.routers.activity_logs:list_activity_logs":
        "HIGH — org-scope만·optional project_id 필터에 접근권 검증 없음(actor/action/context 노출)",
    "app.routers.activity_stream:get_activity_stream":
        "HIGH — org-scope만·project_id 필터에 접근권 검증 없음",
    "app.routers.epics:list_epics":
        "HIGH — org-scope만·optional project_id 필터에 접근권 검증 없음(epic 제목/목표 노출)",
    "app.routers.tasks:list_tasks":
        "HIGH — org-scope만·story_id 필터에 caller의 story project 접근권 검증 없음",
    "app.routers.team_members:list_team_members":
        "HIGH — project_id 지정 분기가 접근권 검증 없이 repo.list(project_id=)로 직행(roster 노출)",
    "app.routers.standups:list_standups":
        "HIGH — top-level project_id 필터에 접근권 검증 없음(plan_stories enrichment만 가드됨)",
    "app.routers.standups:list_standup_history":
        "HIGH — 동일 패턴(project_id 필터 미검증)",
    "app.routers.entities:search_entities":
        "HIGH — org-scope만·project_id로 story/doc/epic/task 제목 검색에 접근권 검증 없음",
    "app.routers.rewards:list_rewards":
        "HIGH — org-scope만·project_id 필터에 접근권 검증 없음(리워드 원장 노출)",
    "app.routers.members:list_members":
        "HIGH — assert_target_in_caller_org가 cross-org만 막고 same-org cross-project는 미검증",
    "app.routers.hypotheses:link_hypothesis":
        "MEDIUM — service._assert_targets_same_project가 sprint/epic/story 주입은 막지만 caller의 hyp.project_id 접근권 자체는 미검증",
    "app.routers.participation:add_participation":
        "MEDIUM — org-scope만·body.story_id에 caller의 project 접근권 검증 없음",
    "app.routers.participation:list_participation":
        "MEDIUM — org-scope만·story_id 쿼리에 접근권 검증 없음",
    "app.routers.exclusion:exclusion_dry_run":
        "MEDIUM — org-scope만·optional project_id에 접근권 검증 없음",
    "app.routers.standups:get_missing_standups":
        "MEDIUM — required project_id를 repo.get_missing에 직행(미제출자 roster 노출)",
    "app.routers.standups:list_feedback":
        "MEDIUM — required project_id로 EXISTS join 필터, 접근권 검증 없음(피드백 텍스트 노출)",
    "app.routers.rewards:get_leaderboard":
        "MEDIUM — S20 fast-follow가 cross-org만 막았고 same-org cross-project는 오늘 계열과 동형 미검증",
    "app.routers.dashboard:get_dashboard":
        "MEDIUM — member_id는 org-scope 검증하나 explicit project_id에 접근권 검증 없음(assignee 필터로 blast-radius는 좁음)",
    "app.routers.agent_runs:create_agent_run":
        "MEDIUM — body.agent_id의 org 소속만 검증하고 body.story_id는 caller org/project 접근권 미검증",
    "app.routers.merge_gate:get_merge_gate_metrics":
        "LOW — org-scope만·optional project_id 필터 미검증이나 응답이 집계 비율/카운트뿐(원본 콘텐츠 노출 없음)",
}


def _baseline_key_valid_targets(app) -> set[str]:
    """baseline이 가리키는 실제 module:qualname 집합 — 존재하지 않는(rot된) 엔트리 검출용."""
    routes = enumerate_routes_matching(app, PROJECT_PARAM_RE)
    return {r.key for r in routes}


def test_no_new_unguarded_project_scope_routes():
    """ratchet: baseline(false-positive+known-debt)에 없는 미가드 project-scope 라우트가
    생기면 CI가 즉시 실패 — 신규 라우터가 project_id/story_id/sprint_id/epic_id/doc_id/
    meeting_id/parent_id를 받으면서 has_project_access류 가드를 호출하지 않을 때 발동."""
    from app.main import app

    routes = enumerate_routes_matching(app, PROJECT_PARAM_RE)
    baseline = set(_FALSE_POSITIVE_ALLOWLIST) | set(_KNOWN_DEBT_ALLOWLIST)

    unguarded_not_baselined = [
        r for r in routes
        if not has_guard(r, PROJECT_GUARD_FUNCTIONS) and r.key not in baseline
    ]
    assert unguarded_not_baselined == [], (
        "새 project-scope 미가드 라우트 발견 — has_project_access/resolve_member/"
        "accessible_project_ids_in_org류 가드를 추가하거나(권장), 검토 후 baseline에 "
        "이유와 함께 등록하세요(tests/test_authz_project_scope_coverage.py):\n" +
        "\n".join(f"  {r.key} params={r.identity_params}" for r in unguarded_not_baselined)
    )


def test_baseline_entries_are_not_stale():
    """baseline이 가리키는 module:qualname이 실제 라우트로 여전히 존재하는지(리네임/삭제로
    인한 rot 검출) — 존재하지 않으면 baseline 정리 필요."""
    from app.main import app

    valid = _baseline_key_valid_targets(app)
    stale = (set(_FALSE_POSITIVE_ALLOWLIST) | set(_KNOWN_DEBT_ALLOWLIST)) - valid
    assert stale == set(), (
        f"baseline에 더 이상 존재하지 않는 라우트가 있습니다(rename/삭제로 rot) — 정리하세요: {stale}"
    )


def test_known_debt_allowlist_shrinks_are_welcome_no_assertion():
    """placeholder — known-debt 항목이 fix되면 baseline dict에서 제거하는 게 상환 진행의
    증거(별도 assertion 없음, 다음 fix PR이 이 dict를 줄이면 그걸로 충분)."""
    assert True
