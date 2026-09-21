"""story #4079(까디르 #4077 스캔 §4-4 처방, 2026-09-21) —
lint_no_hardcoded_iso_timestamp.py의 사각 봉합 회귀 가드. test_3528_no_hardcoded_iso_
timestamp_lint.py(ISO-문자열·backend/app 전용, 그대로 유지)와 별도 파일로 신설 —
이 파일은 신규 능력(생성자 스타일·backend/tests 정책·sentinel/DI/freeze 예외)만
합성 fixture로 고정한다."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from lint_no_hardcoded_iso_timestamp import (  # noqa: E402
    main as lint_main,
    scan_source,
    scan_tests_source,
)


# ─── AC1: backend/app — 생성자 스타일도 ISO-문자열과 동일 강도로 잡는다 ──────────

def test_ac1_constructor_style_literal_in_app_code_is_detected():
    """positive — story #4077이 실측한 정확히 그 갭(datetime(2026, 9, 20, ...) 생성자
    스타일은 옛 정규식이 아예 못 봤다)."""
    source = '''
from datetime import datetime, timezone


def compute_deadline():
    return datetime(2026, 9, 20, tzinfo=timezone.utc)
'''
    violations = scan_source(source, "app/services/fixture.py")
    assert len(violations) == 1
    assert "2026, 9, 20" in violations[0].text


def test_ac1_module_attribute_style_constructor_is_also_detected():
    """`import datetime` 관례(`datetime.datetime(...)`)도 놓치지 않는다 — bare-name
    관례만 보면 임포트 스타일이 다른 파일에서 조용히 새는 사각이 남는다."""
    source = '''
import datetime as dt


def compute_deadline():
    return dt.datetime(2026, 9, 20)
'''
    violations = scan_source(source, "app/services/fixture.py")
    assert len(violations) == 1


def test_ac1_sentinel_epoch_constructor_is_not_flagged():
    """negative — `_EPOCH = datetime(1970, 1, 1, ...)`류 "항상 과거" sentinel은
    conversations.py의 실제 프로덕션 관용구다(_is_sentinel_year 예외 대상)."""
    source = '''
from datetime import datetime, timezone

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
'''
    assert scan_source(source, "app/routers/fixture.py") == []


def test_ac1_non_date_shaped_call_is_not_misdetected():
    """`datetime(...)`이지만 첫 인자가 연도로 읽을 수 없는 모양(예: 다른 datetime을
    그대로 감싸는 호출)은 오탐하지 않는다."""
    source = '''
from datetime import datetime


def echo(dt):
    return datetime(dt.year, dt.month, dt.day)
'''
    assert scan_source(source, "app/services/fixture.py") == []


# ─── backend/tests 정책 — live-now 게이트가 다수(순수 픽스처)를 먼저 걸러낸다 ──────

def test_tests_policy_literal_with_no_live_now_call_anywhere_is_safe():
    """이 스토리의 핵심 실측(367→2건) — 파일에 실 `datetime.now()`/`date.today()`
    호출이 아예 없으면 위험대 리터럴이 있어도 통과(순수 CRUD 픽스처·페이지네이션
    앵커류, #4077 문서 §AC2 (c) "상대오프셋의 앵커일 뿐" 부류와 동형)."""
    source = '''
from datetime import datetime, timezone


def test_seed_row():
    created_at = datetime(2026, 7, 17, tzinfo=timezone.utc)
    assert created_at.year == 2026
'''
    assert scan_tests_source(source, "tests/fixture.py") == []


def test_tests_policy_is_function_scoped_not_file_scoped():
    """negative — 실측 회귀(test_1970_gate_single_get.py) — 순수 픽스처 팩토리
    함수(`_gate`)는 자기 body에 live-now 호출이 없다. 같은 **파일**의 무관한 다른
    함수가 `datetime.now()`를 쓴다는 이유만으로 이 팩토리의 리터럴을 오탐해선 안 된다
    (파일 단위 1차 설계가 걸렸던 그 사고 그대로 재현·고정)."""
    source = '''
from datetime import datetime, timezone


def _gate(work_item_id):
    return {
        "id": work_item_id,
        "created_at": datetime(2026, 7, 17, tzinfo=timezone.utc),
    }


def test_unrelated_marks_deleted():
    deleted_at = datetime.now(timezone.utc)
    assert deleted_at is not None
'''
    assert scan_tests_source(source, "tests/fixture.py") == []


def test_tests_policy_dangerous_literal_with_live_now_call_and_no_marker_fails():
    """positive — 파일에 실 `datetime.now()` 호출이 있고(위험 신호), 그 위험대
    리터럴을 안전하다고 설명할 freeze/DI 관용구가 하나도 없으면 FAIL."""
    source = '''
from datetime import datetime, timezone


def test_uses_live_now():
    boundary = datetime.now(timezone.utc)
    scheduled = datetime(2026, 9, 20, tzinfo=timezone.utc)
    assert scheduled > boundary
'''
    violations = scan_tests_source(source, "tests/fixture.py")
    assert len(violations) == 1
    assert "2026, 9, 20" in violations[0].text


def test_tests_policy_now_kwarg_di_pattern_is_safe_even_with_live_now_call_elsewhere():
    """negative — `now=`류 DI 키워드로 넘기는 자리는, 같은 파일 다른 곳에 실 now()
    호출이 있어도 안전(test_3528_comment_continuous_polling.py 실사례와 동형)."""
    source = '''
from datetime import datetime, timezone, timedelta


def test_unrelated_uses_live_now():
    _ = datetime.now(timezone.utc)


def test_di_pattern():
    published_at = datetime(2026, 9, 1, tzinfo=timezone.utc)
    now = published_at + timedelta(days=1)
    assert resolve(now=now)


def resolve(*, now):
    return now
'''
    assert scan_tests_source(source, "tests/fixture.py") == []


def test_tests_policy_module_level_now_named_constant_is_self_exempt():
    """negative — `_NOW = datetime(2026, 6, 19, ...)`류 모듈 상수(test_edg_s18_
    runtime_mode.py 실사례) — 여러 테스트가 `now=_NOW`로 주입해 쓴다. 대입 대상
    이름 자체가 DI 관용구(밑줄 접두 허용)면 스코프·live-now 여부와 무관하게 안전."""
    source = '''
from datetime import datetime, timezone

_NOW = datetime(2026, 6, 19, 12, 0, 0, tzinfo=timezone.utc)


def test_uses_fixed_now():
    assert resolve_runtime_mode(now=_NOW) == "off"


def test_unrelated_uses_live_now():
    _ = datetime.now(timezone.utc)
'''
    assert scan_tests_source(source, "tests/fixture.py") == []


def test_tests_policy_monkeypatch_freeze_idiom_is_safe():
    """negative — `monkeypatch.setattr(module, "datetime", ...)` freeze 관용구
    (test_3663_wake_resting_schedule_unique_collision.py 실사례와 동형)가 있으면
    같은 파일의 위험대 리터럴 전부를 통과시킨다."""
    source = '''
from datetime import datetime, timezone


class _FixedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 9, 20, tzinfo=timezone.utc)


def test_freezes_clock(monkeypatch):
    monkeypatch.setattr(some_module, "datetime", _FixedDatetime)
    _ = datetime.now(timezone.utc)
'''
    assert scan_tests_source(source, "tests/fixture.py") == []


def test_tests_policy_sentinel_year_safe_even_with_live_now_call():
    """negative — "항상 과거"(<=2021)/"항상 미래"(>=2090) sentinel은 live-now 호출이
    있어도 무조건 안전(#4077 문서 2020/2099류 실사례와 동형)."""
    source = '''
from datetime import datetime, timezone


def test_always_past_sentinel():
    boundary = datetime.now(timezone.utc)
    old = datetime(2020, 1, 1, tzinfo=timezone.utc)
    assert old < boundary


def test_always_future_sentinel():
    boundary = datetime.now(timezone.utc)
    far = datetime(2099, 1, 1, tzinfo=timezone.utc)
    assert far > boundary
'''
    assert scan_tests_source(source, "tests/fixture.py") == []


def test_tests_policy_explicit_allowlist_entry_is_honored():
    """TEST_ALLOWLIST는 (file, line, literal) 완전일치만 통과시킨다 — 같은 값이 다른
    줄/다른 파일에 있으면 그대로 FAIL(말없이 넓어지는 예외 금지, 기존 ALLOWLIST와
    동형 계약)."""
    source = '''
from datetime import datetime, timezone


def test_uses_live_now():
    boundary = datetime.now(timezone.utc)
    scheduled = datetime(2026, 9, 10, tzinfo=timezone.utc)
    assert scheduled > boundary
'''
    # 실제 TEST_ALLOWLIST엔 이 (file, line, literal) 조합이 없다 — 값이 같아도 등재
    # 안 된 파일/줄이면 여전히 FAIL.
    violations = scan_tests_source(source, "tests/not_the_allowlisted_file.py")
    assert len(violations) == 1


# ─── AC — 실물 backend/app·backend/tests 전체가 지금 실제로 깨끗한지 ────────────

def test_current_repo_passes_the_extended_guard():
    """실측 367건(파일 단위 marker-만 요구하던 1차 설계)→2건(live-now 게이트 추가)→
    0건(sentinel epoch·TEST_ALLOWLIST 2건 반영) — 이 pin이 그 최종 상태를 고정한다."""
    assert lint_main() == 0
