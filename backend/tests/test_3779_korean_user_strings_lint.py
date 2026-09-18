"""story #3779(1층) — BE 한글 사용자 문장 재발 가드(scripts/
verify_no_new_korean_user_strings.py) 자체를 검증한다. 실PG 불요(순수 AST 정적분석).

⛔영구 양성/음성표본 — 이 테스트 파일 자체가 고정 fixture(문자열 소스)로 표본을 둔다(story
#2335 test_2335_query_sentinel_lint.py와 동일 관례) — 실물 site가 고쳐져도 표본은 그대로
살아있어 "이 lint가 진짜 잡는가"를 언제든 재확認할 수 있다.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from verify_no_new_korean_user_strings import (  # noqa: E402
    EXEMPT_FILES,
    check_baseline_growth,
    evaluate,
    scan_repo,
    scan_source,
    violation_key,
)


def test_hangul_string_literal_is_flagged():
    source = '''
def raise_error():
    raise ValueError("연결을 찾을 수 없거나 비활성 상태입니다")
'''
    violations = scan_source(source, "app/routers/fixture.py")
    assert len(violations) == 1
    assert violations[0].text == "연결을 찾을 수 없거나 비활성 상태입니다"


def test_english_only_string_is_not_flagged():
    source = '''
def raise_error():
    raise ValueError("connection not found or inactive")
'''
    assert scan_source(source, "app/routers/fixture.py") == []


def test_fstring_literal_fragment_is_flagged():
    """f-string의 리터럴 조각(변수 자리 제외)은 ast.JoinedStr 하위 Constant로 잡힌다."""
    source = '''
def raise_error(connection_id):
    raise ValueError(f"연결을 찾을 수 없음: {connection_id}")
'''
    violations = scan_source(source, "app/routers/fixture.py")
    assert len(violations) == 1
    assert violations[0].text == "연결을 찾을 수 없음:"


# ─── ⭐docstring 제외 ────────────────────────────────────────────────────────


def test_module_docstring_is_not_flagged():
    source = '''
"""이 모듈은 한글 docstring을 갖는다 — 개발자 문서지 사용자 문장이 아니다."""

def foo():
    pass
'''
    assert scan_source(source, "app/services/fixture.py") == []


def test_function_docstring_is_not_flagged():
    source = '''
def foo():
    """이 함수도 한글 docstring — 제외 대상."""
    return 1
'''
    assert scan_source(source, "app/services/fixture.py") == []


def test_non_docstring_string_after_docstring_is_still_flagged():
    """docstring 제외가 "함수 body의 첫 문자열 literal Expr"로 정확히 한정되는지 —
    두 번째 이후 문자열 상수는 여전히 걸려야 한다(과다 제외 방지)."""
    source = '''
def foo():
    """이건 docstring."""
    message = "이건 docstring이 아니다"
    return message
'''
    violations = scan_source(source, "app/services/fixture.py")
    assert len(violations) == 1
    assert violations[0].text == "이건 docstring이 아니다"


# ─── ⭐logger.* 제외 ─────────────────────────────────────────────────────────


def test_logger_call_argument_is_not_flagged():
    source = '''
import logging
logger = logging.getLogger(__name__)

def foo():
    logger.warning("auth.refresh 실패 reason=invalid_jwt")
'''
    assert scan_source(source, "app/routers/fixture.py") == []


def test_underscore_logger_call_argument_is_not_flagged():
    source = '''
import logging
_logger = logging.getLogger(__name__)

def foo():
    _logger.info("신규 project default 판정 실패", exc_info=True)
'''
    assert scan_source(source, "app/main.py") == []


def test_non_logger_call_with_same_method_name_is_still_flagged():
    """다른 객체의 .info(...)/.warning(...)까지 과다 배제하면 안 된다 — base 이름이
    logger/_logger가 아니면 걸려야 한다(과다 제외 방지)."""
    source = '''
def foo(response):
    response.info("사용자에게 보이는 정보 문구")
'''
    violations = scan_source(source, "app/routers/fixture.py")
    assert len(violations) == 1
    assert violations[0].text == "사용자에게 보이는 정보 문구"


def test_logger_call_with_non_string_first_arg_still_excludes_later_korean_args():
    """logger.warning("fmt %s", "한글 값") 형태 — span 기반 제외라 두 번째 인자도 잡힌다."""
    source = '''
import logging
logger = logging.getLogger(__name__)

def foo():
    logger.warning("실패 reason=%s", "한글 사유")
'''
    assert scan_source(source, "app/routers/fixture.py") == []


# ─── ⭐violation_key — 개행 이스케이프(baseline 파일이 줄 단위라 필수) ────────


def test_violation_key_escapes_embedded_newlines():
    """멀티라인 문자열 리터럴(예: email_copy.py류)이 그대로 baseline에 들어가면 한 항목이
    여러 physical line을 차지해 파일을 깨뜨린다 — 실측으로 발견(write 시점 key 개수와 파일
    실제 줄 수가 어긋남, 2026-09-10). `\\n`으로 이스케이프해 한 줄에 눌러 담는지 고정."""
    from verify_no_new_korean_user_strings import Violation

    v = Violation(file="app/services/email_copy.py", line=10, text="첫 줄\n둘째 줄")
    key = violation_key(v)
    assert "\n" not in key
    assert key == "app/services/email_copy.py::첫 줄\\n둘째 줄"


# ─── ⭐stale RED(페드루 PO 지적 2026-09-10 08:17Z, 카드 處方 ① "stale RED") ──────
#
# 최초 구현은 stale을 ⚠️ 경고만 찍고 exit 0을 반환했다 — 「고쳐졌는데 baseline에 죽은
# 항목으로 조용히 남는」 클래스(오늘 유나가 별건에서 잡은 것과 동형, story #3776 ③-b가
# 이미 세운 성질)를 재발시켰던 자리. evaluate()가 stale을 정확히 보고하는지 고정한다.


def test_evaluate_flags_baseline_entry_with_no_matching_violation_as_stale():
    """baseline에 가짜(실물 없는) 키를 심으면 stale로 잡혀야 한다 — 되돌리면(stale을
    다시 경고만으로 낮추면) main()이 exit 0을 반환해 이 클래스가 재발한다."""
    source = 'x = "실제로 있는 한글"'
    violations = scan_source(source, "app/services/fixture.py")
    baseline = {
        "app/services/fixture.py::실제로 있는 한글",
        "app/services/fixture.py::가짜_유령_문자열_이제_없음",
    }
    new_violations, stale = evaluate(violations, baseline)
    assert new_violations == []
    assert stale == ["app/services/fixture.py::가짜_유령_문자열_이제_없음"]


def test_evaluate_reports_no_stale_when_baseline_matches_exactly():
    source = 'x = "실제로 있는 한글"'
    violations = scan_source(source, "app/services/fixture.py")
    baseline = {"app/services/fixture.py::실제로 있는 한글"}
    new_violations, stale = evaluate(violations, baseline)
    assert new_violations == []
    assert stale == []


# ─── EXEMPT_FILES(story #3786, 페드루 PO 明示 2026-09-10 12:24Z) — 이름 붙은 유일 예외 ──


def test_exempt_files_has_exactly_one_named_entry():
    """무배제 원칙이 깨지지 않았는지 — 예외 세트가 정확히 1건(i18n_catalog.py)인지 고정.
    누군가 조용히 더 추가하면(PO 승인 없이) 이 테스트가 잡는다."""
    assert EXEMPT_FILES == frozenset({"app/services/i18n_catalog.py"})


def test_scan_repo_excludes_i18n_catalog_but_still_catches_other_korean():
    """⭐양성대조 — scan_repo()가 실 저장소를 돌 때 i18n_catalog.py의 ko 값은 안 잡히고,
    (다른 파일이 여전히 정상적으로 잡히는지는) baseline 초과-0 계약으로 이미 간접 보장되므로,
    여기서는 EXEMPT 파일 자체가 스캔 결과에 전혀 안 나타나는지만 직접 고정한다."""
    backend_root = Path(__file__).resolve().parent.parent
    violations = scan_repo(backend_root)
    exempt_hits = [v for v in violations if v.file in EXEMPT_FILES]
    assert exempt_hits == [], (
        f"EXEMPT_FILES({EXEMPT_FILES})가 여전히 스캔에 걸린다 — scan_repo()의 제외 로직이 깨짐: {exempt_hits}"
    )


def test_mutation_removing_exemption_would_flag_catalog_ko_values():
    """뮤테이션 대표 — EXEMPT_FILES 필터를 안 거친 scan_source()로 직접 돌리면(= 제외 로직을
    걷어낸 것과 동형) i18n_catalog.py의 ko 값이 실제로 걸려야 한다(가드가 "원래는 잡을
    수 있는 것"을 의도적으로 봐주고 있다는 증거 — 필터 자체가 무력화된 게 아님을 증명)."""
    backend_root = Path(__file__).resolve().parent.parent
    catalog_path = backend_root / "app" / "services" / "i18n_catalog.py"
    source = catalog_path.read_text(encoding="utf-8")
    violations = scan_source(source, "app/services/i18n_catalog.py")
    assert len(violations) > 0, "i18n_catalog.py에 ko 문자열이 없다 — fixture 전제가 깨짐(카탈로그가 비었는지 확認)"


# ─── check_baseline_growth(story #3924, 페드루 PO 處方 2026-09-15) ──────────────────────
# CI "Verify baseline can only shrink" 스텝의 구 구현(순수 집합 diff, comm -13과 동형)이
# 기존 grandfather 항목의 «문구만 바뀐» rename을 신규 추가로 오판한 실 사고(PR#4316,
# app/routers/conversations.py:3062 — 3903 AC1 습니다체→해요체 + PO 후속 「회원님을」→
# 「나를」)를 재현·고정한다. 판정 자체가 파일 단위 항목 수 비증가+전역 비증가로 바뀌어
# rename은 통과하고 진짜 순증만 잡는다.


def test_growth_guard_flags_a_brand_new_file():
    """⭐양성대조 ① — base에 없던 파일이 head에 항목을 가지면(그 파일 카운트 0→N>0) RED."""
    base = {"app/routers/existing.py::기존 문구"}
    head = {"app/routers/existing.py::기존 문구", "app/routers/new_file.py::새로 생긴 한글 문장"}
    violations = check_baseline_growth(base, head)
    assert any("new_file.py" in v for v in violations)


def test_growth_guard_allows_a_pure_text_rename_in_the_same_file():
    """⭐양성대조 ② — 같은 파일에서 기존 항목 1건이 삭제되고 문구가 바뀐 1건이 추가되면
    (그 파일 카운트 불변) GREEN — 이게 구 구현(comm -13)이 오판하던 정확한 그 케이스."""
    base = {"app/routers/conversations.py::님이 회원님을 멘션했습니다"}
    head = {"app/routers/conversations.py::님이 나를 멘션했어요"}
    assert check_baseline_growth(base, head) == []


def test_growth_guard_allows_removal():
    """⭐양성대조 ③ — 항목이 그냥 삭제되면(코드가 실제로 고쳐짐) GREEN(환영할 감소)."""
    base = {"app/routers/x.py::지워질 문구", "app/routers/x.py::남을 문구"}
    head = {"app/routers/x.py::남을 문구"}
    assert check_baseline_growth(base, head) == []


def test_growth_guard_still_flags_a_real_net_increase_in_the_same_file():
    """음성대조 — rename처럼 보이지만 실제로 그 파일에서 항목이 «늘면»(2건 남기고 1건만
    지움 = 순증 1) 여전히 RED — rename 관용이 "그 파일은 뭘 해도 통과"가 아님을 고정."""
    base = {"app/routers/x.py::기존 A"}
    head = {"app/routers/x.py::기존 A(그대로)", "app/routers/x.py::신규 B"}
    violations = check_baseline_growth(base, head)
    assert any("app/routers/x.py" in v for v in violations)


def test_growth_guard_real_incident_regression_red_to_green():
    """실 사고(PR#4316 head d2a79022, story #3924 처방 前) 재현 — 구 판정(순수 집합 diff)
    이라면 이 케이스는 RED였다(new_lines에 새 텍스트가 걸림). 이 함수(파일 단위+전역
    비증가)로는 GREEN이어야 한다 — 처방 자체의 존재 이유를 고정하는 회귀가드."""
    base_baseline = {
        "app/routers/conversations.py::님이 회원님을 멘션했습니다",
        "app/routers/conversations.py::서킷브레이커 해제는 org owner/admin만 가능합니다.",
    }
    head_baseline = {
        "app/routers/conversations.py::님이 나를 멘션했어요",
        "app/routers/conversations.py::서킷브레이커 해제는 org owner/admin만 가능합니다.",
    }
    # 구 구현이었다면 이 assert가 실패했을 것(새 텍스트가 base에 없어 new_lines에 걸림).
    old_impl_new_lines = head_baseline - base_baseline
    assert old_impl_new_lines, "fixture 전제 확認 — 구 구현이 오판하려면 실제로 새 줄이 있어야 한다"

    assert check_baseline_growth(base_baseline, head_baseline) == []


def test_growth_guard_empty_base_means_every_head_entry_counts_but_nothing_is_new():
    """경계 — base·head가 완전히 동일하면(아무것도 안 바뀜) 당연히 GREEN."""
    same = {"app/routers/a.py::a", "app/routers/b.py::b"}
    assert check_baseline_growth(same, set(same)) == []


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
