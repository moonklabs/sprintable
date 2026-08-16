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
커밋 뮤테이션, 이미 404로 존재 확인된 後의 의도된 403)·stories.py 1600/2234(delete_story의
SEC-S3 의도된 403 — 이 스토리 스코프 밖 기존 결정)처럼 «raise하지만 이 스토리가 다루는
GET-by-id 존재-비노출 클래스가 아닌» 정당한 잔존도 섞여 있다 — baseline은 그 구분 없이
전체 카운트를 고정해, 늘면(신규든 회귀든) 사람이 다시 살펴보게 한다."""
from __future__ import annotations

import ast
from pathlib import Path

_APP = Path(__file__).resolve().parent.parent / "app"

# 2026-08-16 실측(develop HEAD 2a5a1cbfb 기준, #2696 merge 후 재측 — team_members.py:592→594·
# workflow_parallel_approval.py:308→310는 #2696의 via_outbox=True 라인 삽입에 의한 순수
# 줄번호 드리프트였다(카디르 최초 리포트는 "신규 잔존"으로 읽었으나 git diff로 대조한 결과
# 헬퍼 미전환 신규 발생이 아니라 그 두 자리였음 그대로임을 확인 — count=59 불변, 그 2건만
# 좌표 이동) — 정확한 자리를 고정해 "어디가 늘었는지"를 count 불일치가 아니라 diff로 바로
# 보여준다. 진짜로 늘어나면 왜 늘었는지 검토 후 의식적으로만 올릴 것.
_KNOWN_HITS = {
    "app/dependencies/auth.py:823",
    "app/dependencies/project_scope.py:61",
    "app/dependencies/project_scope.py:71",
    "app/routers/activity_logs.py:97",
    "app/routers/activity_stream.py:41",
    "app/routers/agent_runs.py:65",
    "app/routers/agent_runs.py:106",
    "app/routers/agent_runs.py:159",
    "app/routers/analytics.py:47",
    "app/routers/assets.py:146",
    "app/routers/assets.py:252",
    "app/routers/assets.py:300",
    "app/routers/attachments.py:198",
    "app/routers/auth.py:1557",
    "app/routers/context_pack.py:50",
    "app/routers/current_project.py:79",
    "app/routers/docs.py:339",
    "app/routers/docs.py:373",
    "app/routers/docs.py:412",
    "app/routers/docs.py:434",
    "app/routers/docs.py:697",
    "app/routers/docs.py:970",
    "app/routers/docs.py:1095",
    "app/routers/entities.py:316",
    "app/routers/evidence.py:112",
    "app/routers/file_locks.py:295",
    "app/routers/gate_config.py:75",
    "app/routers/glance.py:120",
    "app/routers/goals.py:113",
    "app/routers/goals.py:331",
    "app/routers/meetings.py:37",
    "app/routers/meetings.py:65",
    "app/routers/members.py:54",
    "app/routers/oss.py:34",
    "app/routers/policy_documents.py:29",
    "app/routers/project_settings.py:27",
    "app/routers/reference_candidates.py:40",
    "app/routers/references.py:153",
    "app/routers/rewards.py:47",
    "app/routers/standups.py:176",
    "app/routers/standups.py:294",
    "app/routers/standups.py:340",
    "app/routers/standups.py:355",
    "app/routers/standups.py:423",
    "app/routers/stories.py:1600",
    "app/routers/stories.py:2234",
    "app/routers/team_members.py:180",
    "app/routers/team_members.py:594",
    "app/routers/workflow_executions.py:70",
    "app/routers/workflow_report.py:158",
    "app/routers/workflow_templates.py:104",
    "app/routers/workflow_trigger.py:45",
    "app/services/loop.py:92",
    "app/services/member_resolver.py:77",
    "app/services/member_resolver.py:93",
    "app/services/member_resolver.py:157",
    "app/services/member_resolver.py:173",
    "app/services/project_auth.py:413",
    "app/services/workflow_parallel_approval.py:310",
}
_RAW_INLINE_RAISE_BASELINE = len(_KNOWN_HITS)


def _find_raw_inline_raise_patterns() -> list[str]:
    """`if not await has_project_access(...):` 바로 다음 줄(들)이 `raise HTTPException(...)`인
    자리를 찾는다 — require_project_access로 수렴 안 한 잔존 인라인 판정."""
    hits: list[str] = []
    for path in sorted(_APP.rglob("*.py")):
        try:
            src = path.read_text(encoding="utf-8")
            tree = ast.parse(src, filename=str(path))
        except (SyntaxError, UnicodeDecodeError):
            continue
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
                hits.append(f"{path.relative_to(_APP.parent)}:{node.lineno}")
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
