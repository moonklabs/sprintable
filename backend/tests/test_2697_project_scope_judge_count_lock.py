"""story #2697([BE·인가·프로젝트 스코프]) — 판정 함수 한 곳 카운트락.

GET/PATCH/DELETE-by-id 라우터들이 각자 `if not await has_project_access(...): raise
HTTPException(...)` 3줄을 복제하던 것(리소스 타입별 404/403 들쭉날쭉의 근원)을
`project_auth.require_project_access`(SSOT)로 수렴했다 — goals.py 4곳·stories.py
`_assert_story_project_access`·sprints.py 8곳·retros.py 4곳·gates.py 2곳(스토리 원 제목이
지목한 5개 리소스: goals·stories·conversations·sprints, 참고 리소스 retros·gates).

⚠️스코프 정직 고지: AST 전수 스캔 결과 이 정확한 인라인 패턴이 backend/app 전역에 baseline
59건 더 있다(docs.py·standups.py·attachments.py·assets.py·agent_runs.py·evidence.py·
file_locks.py·meetings.py·workflow_templates.py 등 20+ 파일) — #2697 PO 승인 스코프(좁음,
conversations.py 실결함 + 상태코드 통일 + 음성대조 테스트)는 이 전체를 수렴하지 않는다.
baseline=0으로 두면 "다 고쳤다"는 거짓 신호가 된다 — 실측 59를 그대로 고정한다(#2694
AC②가 #2696을 낳은 것과 동형 — 이번엔 마감 없이 스토리 본문에 후속 후보 목록만 남긴다).
이 59 안에는 goals.py:113(list 엔드포인트 쿼리필터, by-id 아님)·goals.py:331(steer_dispatch
커밋 뮤테이션, 이미 404로 존재 확인된 後의 의도된 403)·stories.py 1604/2238(delete_story의
SEC-S3 의도된 403 — 이 스토리 스코프 밖 기존 결정)처럼 «raise하지만 이 스토리가 다루는
GET-by-id 존재-비노출 클래스가 아닌» 정당한 잔존도 섞여 있다 — baseline은 그 구분 없이
전체 카운트를 고정해, 늘면(신규든 회귀든) 사람이 다시 살펴보게 한다.

⛔story #2679(2026-08-16, PO 실측): stories.py 두 좌표가 1600/2234→1604/2238로 다시 흔들림
— #2679의 stories.py diff(_reconcile_story_references_and_candidates 주석 추가)가 그 두
자리보다 앞에서 줄을 밀었을 뿐, 신규 occurrence 아님(count 59 불변, 좌표만 이동 — #2696
merge가 team_members.py/workflow_parallel_approval.py를 흔든 것과 동형, 2회째 실증). 줄번호
키의 구조적 약점 — 다음 스토리(파일::심볼 키 전환, PO 예고)까지는 형제 PR merge마다 이런
drift가 또 날 수 있음을 알고 있을 것."""
from __future__ import annotations

import ast
from pathlib import Path

_APP = Path(__file__).resolve().parent.parent / "app"

# story #2699(2026-08-16, «파일::심볼» 키 전환 — 줄번호 키가 형제 PR merge(#2696)·자기 diff
# (#2679) 두 번 다 "신규 잔존"으로 오탐시킨 뒤 PO 지시로 교체) — 재측(develop HEAD 기준,
# require_project_access 도입 SSOT 통일 이후). 키에 줄번호가 없어 같은 함수 안에서 줄이
# 밀려도(주석 추가·형제 PR merge) 흔들리지 않는다.
#
# ⛔59건 raw 인라인 발견 중 5개 함수(_resolve_member_legacy·_resolve_member_anchor·
# resolve_required_project_id·docs.py의 get_doc·get_doc_preview)는 각각 그 안에 이 패턴이
# «두 번» 있어(휴먼 분기·에이전트 분기 등 서로 다른 조건절에서 같은 모양을 반복) 키가
# 겹친다 — 그래서 고유 키는 54개뿐이지만 raw 총량은 59건(아래 _RAW_INLINE_RAISE_BASELINE이
# len(_KNOWN_HITS)에서 분리된 이유). 진짜로 늘어나면(고유 키 증가든 raw 총량 증가든) 왜
# 늘었는지 검토 후 의식적으로만 올릴 것.
_KNOWN_HITS = {
    "app/dependencies/auth.py::enforce_body_context",
    "app/dependencies/project_scope.py::resolve_required_project_id",
    "app/routers/activity_logs.py::list_activity_logs",
    "app/routers/activity_stream.py::get_activity_stream",
    "app/routers/agent_runs.py::create_agent_run",
    "app/routers/agent_runs.py::list_agent_runs",
    "app/routers/agent_runs.py::update_agent_run",
    "app/routers/analytics.py::_assert_project_access",
    "app/routers/assets.py::_scope_filter",
    "app/routers/assets.py::create_folder",
    "app/routers/assets.py::list_folders",
    "app/routers/attachments.py::authorize_attachment",
    "app/routers/auth.py::set_default_project",
    "app/routers/context_pack.py::search_context_pack",
    "app/routers/current_project.py::set_current_project",
    "app/routers/docs.py::_require_doc_project_access",
    "app/routers/docs.py::get_doc",
    "app/routers/docs.py::get_doc_preview",
    "app/routers/docs.py::register_doc_asset",
    "app/routers/docs.py::upload_doc_attachment",
    "app/routers/entities.py::search_entities",
    "app/routers/evidence.py::_assert_work_item_access",
    "app/routers/file_locks.py::list_file_locks",
    "app/routers/gate_config.py::get_gate_config",
    "app/routers/glance.py::glance_attention",
    "app/routers/goals.py::list_goals",
    "app/routers/goals.py::steer_dispatch",
    "app/routers/meetings.py::_get_repo",
    "app/routers/meetings.py::_get_repo_read",
    "app/routers/members.py::list_members",
    "app/routers/oss.py::oss_seed",
    "app/routers/policy_documents.py::list_policy_documents",
    "app/routers/project_settings.py::get_project_settings",
    "app/routers/reference_candidates.py::get_next_up_reference_candidates",
    "app/routers/references.py::create_reference",
    "app/routers/rewards.py::list_rewards",
    "app/routers/standups.py::add_feedback",
    "app/routers/standups.py::get_missing_standups",
    "app/routers/standups.py::list_feedback",
    "app/routers/standups.py::list_standup_history",
    "app/routers/standups.py::list_standups",
    "app/routers/stories.py::delete_story",
    "app/routers/stories.py::upload_story_attachment",
    "app/routers/team_members.py::claim_story",
    "app/routers/team_members.py::list_team_members",
    "app/routers/workflow_executions.py::story_execution_summary",
    "app/routers/workflow_report.py::report_done",
    "app/routers/workflow_templates.py::apply_template",
    "app/routers/workflow_trigger.py::trigger_workflow",
    "app/services/loop.py::require_loop_project_access",
    "app/services/member_resolver.py::_resolve_member_anchor",
    "app/services/member_resolver.py::_resolve_member_legacy",
    "app/services/project_auth.py::require_project_access",
    "app/services/workflow_parallel_approval.py::reassign_approver",
}
# raw 총량(고유 키 54개 + 위 5개 함수의 내부 중복 5건 = 59) — len(_KNOWN_HITS)와 분리해 명시.
_RAW_INLINE_RAISE_BASELINE = 59


def _qualname_of(node: ast.AST, parents: dict[int, ast.AST]) -> str:
    """node를 감싸는 (Async)FunctionDef/ClassDef 체인을 안쪽→바깥쪽으로 걸어 dotted qualname을
    만든다(예: `MyClass.handler` 또는 모듈 최상위면 그냥 `handler`). id(node) 기반 parents 맵은
    `_attach_parents`가 미리 만들어 둔다 — ast 표준 walk는 parent pointer를 안 주므로."""
    parts: list[str] = []
    cur = parents.get(id(node))
    while cur is not None:
        if isinstance(cur, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            parts.append(cur.name)
        cur = parents.get(id(cur))
    return ".".join(reversed(parts)) if parts else "<module>"


def _attach_parents(tree: ast.AST) -> dict[int, ast.AST]:
    parents: dict[int, ast.AST] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parents[id(child)] = parent
    return parents


def _find_raw_inline_raise_patterns() -> list[str]:
    """`if not await has_project_access(...):` 바로 다음 줄(들)이 `raise HTTPException(...)`인
    자리를 찾는다 — require_project_access로 수렴 안 한 잔존 인라인 판정.

    story #2699(2026-08-16 실증 2회 — #2696 형제 merge의 순수 line-shift·#2679 자기 diff의
    줄 밀림, 둘 다 baseline을 «신규 잔존»으로 오탐시킴): 키를 `{경로}:{줄번호}`에서
    `{경로}::{함수/메서드 qualname}`으로 바꾼다 — 같은 함수 안에서 앞뒤로 줄이 밀려도(주석
    추가·형제 PR merge 등) 키가 안 흔들린다. ⛔못 잡는 것(의식적 트레이드오프, AC4): 같은
    함수 안에 «두 번째» 동일 인라인 raise 패턴이 새로 생기면 기존 키와 충돌해
    `set(hits) - _KNOWN_HITS`(신규 키 diff)에는 안 잡힌다 — 다만 `len(hits) == baseline`
    (원시 리스트 길이, dedup 안 함) 비교는 여전히 걸린다(카운트 불일치로 사람이 다시 봄,
    "어느 함수인지"만 자동으로 못 짚어 줄 뿐)."""
    hits: list[str] = []
    for path in sorted(_APP.rglob("*.py")):
        try:
            src = path.read_text(encoding="utf-8")
            tree = ast.parse(src, filename=str(path))
        except (SyntaxError, UnicodeDecodeError):
            continue
        parents = _attach_parents(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.If):
                continue
            test = node.test
            # `not await has_project_access(...)` 패턴만 겨냥(양성 boolean 사용 — list
            # comprehension·reason-string 반환 등 raise 아닌 자리는 대상 아님, 의도적 제외).
            is_target = (
                isinstance(test, ast.UnaryOp)
                and isinstance(test.op, ast.Not)
                and isinstance(test.operand, ast.Await)
                and isinstance(test.operand.value, ast.Call)
                and isinstance(test.operand.value.func, ast.Name)
                and test.operand.value.func.id == "has_project_access"
            )
            if not is_target:
                continue
            body_is_raise = (
                len(node.body) == 1
                and isinstance(node.body[0], ast.Raise)
            )
            if body_is_raise:
                qualname = _qualname_of(node, parents)
                hits.append(f"{path.relative_to(_APP.parent)}::{qualname}")
    return hits


def test_require_project_access_helper_exists_and_is_importable():
    """양성대조 — SSOT 헬퍼 자체가 존재하는지(스캐너가 무력화돼도 이 자리는 잡는다)."""
    from app.services.project_auth import require_project_access
    import inspect

    assert inspect.iscoroutinefunction(require_project_access)
    sig = inspect.signature(require_project_access)
    assert "not_found_detail" in sig.parameters


def test_no_new_raw_inline_project_access_raise_patterns():
    """count-lock — raw 인라인 `if not await has_project_access(...): raise` 패턴이
    baseline(0)을 넘지 않는지. mutation-kill: 아무 라우터에 그 패턴을 추가하면 RED."""
    hits = _find_raw_inline_raise_patterns()
    assert set(hits) - _KNOWN_HITS == set(), f"신규 잔존(baseline에 없던 자리): {set(hits) - _KNOWN_HITS}"
    assert len(hits) == _RAW_INLINE_RAISE_BASELINE, (
        f"require_project_access로 안 수렴한 인라인 raise 패턴: {hits}\n"
        "정말 raw가 필요하면 사유 주석 남기고 이 baseline을 의식적으로 올릴 것."
    )


def test_ast_scan_catches_raw_pattern_fixture():
    """스캐너 자체의 양성대조 — 실제로 그 패턴이 있는 fixture는 잡히는지(공허통과 방지)."""
    import tempfile

    fixture_src = (
        "async def f(session, user_id, project_id, org_id):\n"
        "    if not await has_project_access(session, user_id, project_id, org_id):\n"
        "        raise HTTPException(status_code=404, detail='x')\n"
    )
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "fixture_router.py").write_text(fixture_src, encoding="utf-8")
        tree = ast.parse(fixture_src)
        found = False
        for node in ast.walk(tree):
            if not isinstance(node, ast.If):
                continue
            test = node.test
            if (
                isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not)
                and isinstance(test.operand, ast.Await)
                and isinstance(test.operand.value, ast.Call)
                and isinstance(test.operand.value.func, ast.Name)
                and test.operand.value.func.id == "has_project_access"
                and len(node.body) == 1 and isinstance(node.body[0], ast.Raise)
            ):
                found = True
        assert found, "스캐너 로직 자체가 이 fixture 패턴을 못 잡는다면 count-lock이 공허통과함"
