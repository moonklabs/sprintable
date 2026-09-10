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
    evaluate,
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


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
