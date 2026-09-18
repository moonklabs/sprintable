"""story #3528(재발 가드, 페드루 PO 근본처방 2026-09-12) —
lint_no_hardcoded_iso_timestamp.py의 정탐/오탐 회귀 가드. 합성 fixture로 짓는다
(실물이 고쳐져도 이 테스트는 안 사라진다 — test_3697/test_3216류와 동형 관례)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from lint_no_hardcoded_iso_timestamp import main as lint_main, scan_source  # noqa: E402


def test_clean_source_reports_zero_violations():
    source = '''
"""모듈 docstring — "2026-09-05T00:00:00+00:00" 같은 값이 여기 있어도(문서 텍스트)
안 걸려야 한다."""
from datetime import timedelta


def foo(published_at):
    """함수 docstring도 동형 제외 — "2026-09-06T00:00:00+00:00" 언급."""
    return published_at + timedelta(minutes=1)
'''
    assert scan_source(source, "app/services/fixture.py") == []


def test_hardcoded_iso_timestamp_in_real_code_is_detected():
    """⭐뮤테이션 표적 — docstring이 아니라 실제 코드 값(딕셔너리 리터럴)에 박힌
    절대 일시는 정확히 잡혀야 한다(실사고 재현 그 자체)."""
    source = '''
def _deterministic_comment(*, media_id, index):
    return {
        "id": f"sandbox-comment-{media_id}-{index}",
        "timestamp": "2026-09-05T00:00:00+00:00",
    }
'''
    violations = scan_source(source, "app/services/fixture.py")
    assert len(violations) == 1
    assert violations[0].text == "2026-09-05T00:00:00+00:00"
    assert violations[0].line == 5


def test_non_docstring_first_line_string_constant_still_scanned():
    """docstring 제외는 "함수/클래스/모듈 body의 첫 statement"로 한정 — 두 번째
    statement 이후의 문자열 상수(진짜 코드 값)는 여전히 스캔 대상이어야 한다."""
    source = '''
def foo():
    x = 1
    y = "2026-01-01T00:00:00+00:00"
    return y
'''
    violations = scan_source(source, "app/services/fixture.py")
    assert len(violations) == 1


def test_non_iso_shaped_string_is_ignored():
    """날짜꼴이 아닌 일반 문자열(예: 년-월-일 없이 T만 있거나, 자릿수가 다른 경우)은
    오탐 없이 통과해야 한다."""
    source = '''
def foo():
    return "hello T world" + "2026-1-1T00:00:00"
'''
    assert scan_source(source, "app/services/fixture.py") == []


# ─── AC — 실물 backend/app/**이 지금 실제로 깨끗한지 ────────────────────────────

def test_current_repo_passes_the_guard():
    assert lint_main() == 0
