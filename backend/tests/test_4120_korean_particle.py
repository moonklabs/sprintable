"""story #4120([E-RECIPE-1·Phase 3 폴리시] 조사 플레이스홀더 클래스 해소) — BE 조사 헬퍼
`app.utils.korean_particle.pick_i_ga_josa` 단위 테스트. FE `korean-particle.ts`의
pickIGaJosa와 동일 근거(완성형 한글 종성 유무=예외 없는 기계적 규칙)·동일 숫자 읽기
표(마지막 자리 숫자의 고유한 소리)를 고정한다.

gate_service.py:2093(`f"v{version_number}이(가) 정본으로 확정됐어요."`)의 실사용 형태
그대로 v1·v2·v10을 표본으로(카드가 명시한 3값)."""
from __future__ import annotations

from app.utils.korean_particle import pick_i_ga_josa


def test_hangul_batchim():
    assert pick_i_ga_josa("담롱") == "이"  # 롱=ㅇ받침
    assert pick_i_ga_josa("미르코") == "가"  # 코=받침없음
    assert pick_i_ga_josa("김") == "이"  # 김=ㅁ받침


def test_hangul_rieul_batchim_no_exception():
    # 으로/로와 달리 이/가엔 ㄹ 예외가 없다(FE pickIGaJosa 동형).
    assert pick_i_ga_josa("메일") == "이"  # 일=ㄹ받침


def test_digit_reading_gate_service_version_numbers():
    """gate_service.py:2093 실사용 형태 — "v{version_number}" 마지막 자리 숫자 읽기."""
    assert pick_i_ga_josa("v1") == "이"  # 일=ㄹ받침
    assert pick_i_ga_josa("v2") == "가"  # 이=받침없음
    assert pick_i_ga_josa("v10") == "이"  # 0=영=ㅇ받침(마지막 자리 기준)


def test_digit_reading_full_table():
    assert pick_i_ga_josa("v0") == "이"  # 영=ㅇ받침
    assert pick_i_ga_josa("v3") == "이"  # 삼=ㅁ받침
    assert pick_i_ga_josa("v4") == "가"  # 사=받침없음
    assert pick_i_ga_josa("v5") == "가"  # 오=받침없음
    assert pick_i_ga_josa("v6") == "이"  # 육=ㄱ받침
    assert pick_i_ga_josa("v7") == "이"  # 칠=ㄹ받침
    assert pick_i_ga_josa("v8") == "이"  # 팔=ㄹ받침
    assert pick_i_ga_josa("v9") == "가"  # 구=받침없음


def test_non_hangul_non_digit_falls_back_to_no_batchim():
    assert pick_i_ga_josa("GA4") == "가"  # 4=받침없음이라 폴백과 결과가 같음(대조 예시)
    assert pick_i_ga_josa("Claude") == "가"
    assert pick_i_ga_josa("") == "가"
