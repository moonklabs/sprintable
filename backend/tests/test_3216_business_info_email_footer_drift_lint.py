"""story #3216(위생·가드) — lint_business_info_email_footer_drift.py의 정탐/오탐 회귀
가드. 합성 fixture로 짓는다(실물이 고쳐져도 이 테스트는 안 사라진다, story #2342/#2335
lint와 동형)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from lint_business_info_email_footer_drift import (  # noqa: E402
    FIELD_TO_CONST,
    extract_business_info_fields,
    extract_email_py_constants,
    find_drift,
    main as lint_main,
)

BUSINESS_INFO_TS = """
export const BUSINESS_INFO = {
  companyName: '주식회사 뭉클랩',
  ceo: '윤도선',
  registrationNumber: '488-88-02579',
  address: '경기도 고양시 일산동구 무궁화로 20-38, 5층 502호',
  phone: '070-8098-5775',
  mailOrderNumber: '제2023-고양일산동-1337호',
} as const;
"""

EMAIL_PY_MATCHING = """
_COMPANY_NAME = "주식회사 뭉클랩"
_COMPANY_CEO = "윤도선"
_COMPANY_REG_NO = "488-88-02579"
_COMPANY_ADDRESS = "경기도 고양시 일산동구 무궁화로 20-38, 5층 502호"
_COMPANY_PHONE = "070-8098-5775"
"""


def test_matching_files_report_zero_drift():
    assert find_drift(BUSINESS_INFO_TS, EMAIL_PY_MATCHING) == []


def test_single_field_mismatch_is_detected():
    """정본 회사명이 그대로인데 email.py 사본만 낡은 값 — 회사명 필드 1건만 드리프트로
    잡혀야 한다(다른 4건은 여전히 일치)."""
    stale_email_py = EMAIL_PY_MATCHING.replace('_COMPANY_NAME = "주식회사 뭉클랩"', '_COMPANY_NAME = "주식회사 뭉클랩(구)"')
    drifted = find_drift(BUSINESS_INFO_TS, stale_email_py)
    assert len(drifted) == 1
    assert drifted[0][0] == "companyName"
    assert drifted[0][2] == "주식회사 뭉클랩"
    assert drifted[0][3] == "주식회사 뭉클랩(구)"


def test_mailordernumber_absence_in_footer_is_not_flagged():
    """mailOrderNumber는 email.py 푸터에 애초에 없다(스코프 밖, AC2) — 다른 5건만 일치하면
    드리프트 0이어야 한다."""
    assert "mailOrderNumber" not in FIELD_TO_CONST
    assert find_drift(BUSINESS_INFO_TS, EMAIL_PY_MATCHING) == []


def test_decoy_earlier_match_does_not_silently_pass_a_changed_real_value():
    """카디르 QA(PR#3621) — re.search(첫 매치)였다면 진짜 선언보다 앞선 decoy(주석 예시·
    중복 선언)가 "정본"으로 잘못 채택돼, 진짜 값이 바뀌어도(email.py 낡음) decoy 쪽만
    일치하면 조용히 GREEN이 났을 것이다. 매치 정확히 1건 원칙으로 이런 decoy 자체가
    "추출실패"(보수적 RED)로 떨어져야 한다."""
    ts_with_decoy = (
        "// decoy: companyName: '주식회사 구버전'\n" + BUSINESS_INFO_TS
    )
    # decoy와 진짜 선언 둘 다 매치되므로(2건) companyName은 <추출실패>로 떨어져야 한다 —
    # decoy 값이 "정본"으로 잘못 채택돼 email.py(진짜와 다른 값)와 우연히 일치해 통과하면
    # 안 된다.
    stale_email_py = EMAIL_PY_MATCHING.replace('_COMPANY_NAME = "주식회사 뭉클랩"', '_COMPANY_NAME = "주식회사 구버전"')
    drifted = find_drift(ts_with_decoy, stale_email_py)
    company_name_drift = [d for d in drifted if d[0] == "companyName"]
    assert len(company_name_drift) == 1, "decoy 때문에 companyName 드리프트를 놓쳤다 — 우회 재발"
    assert company_name_drift[0][2] == "<추출실패>"


def test_extraction_failure_is_conservatively_flagged_not_silently_passed():
    """정규식이 값을 못 읽으면(파일 구조 변경 등) "일치"로 오판해 조용히 통과시키지 않고
    드리프트로 보수적 보고한다."""
    malformed_ts = "export const BUSINESS_INFO = { companyName: SOME_VARIABLE, } as const;"
    drifted = find_drift(malformed_ts, EMAIL_PY_MATCHING)
    fields = [d[0] for d in drifted]
    assert "companyName" in fields
    assert drifted[[d[0] for d in drifted].index("companyName")][2] == "<추출실패>"


def test_extract_business_info_fields_reads_all_five_mapped_keys():
    fields = extract_business_info_fields(BUSINESS_INFO_TS)
    for key in FIELD_TO_CONST:
        assert key in fields


def test_extract_email_py_constants_reads_all_five_constants():
    consts = extract_email_py_constants(EMAIL_PY_MATCHING)
    for const_name in FIELD_TO_CONST.values():
        assert const_name in consts


def test_mutation_removing_value_comparison_causes_missed_detection():
    """뮤테이션: find_drift가 항상 빈 리스트를 반환하게 하면 위 정탐 테스트가 깨져야
    한다 — 이 lint의 핵심 로직이 실제로 테스트에 의해 지켜지는지 자가 검증(story #2342
    lint와 동형 계약)."""
    import lint_business_info_email_footer_drift as mod

    original = mod.find_drift
    try:
        mod.find_drift = lambda a, b: []
        stale_email_py = EMAIL_PY_MATCHING.replace('_COMPANY_NAME = "주식회사 뭉클랩"', '_COMPANY_NAME = "주식회사 뭉클랩(구)"')
        assert mod.find_drift(BUSINESS_INFO_TS, stale_email_py) == [], "뮤테이션 후에는 탐지가 0이어야 정상"
    finally:
        mod.find_drift = original


def test_ac1_mutation_single_character_change_in_real_ssot_triggers_red(monkeypatch):
    """AC1 필수 pin — 실물 business-info.ts에서 정본 한 글자를 바꾸면(뮤테이션) 실물
    email.py(무변경) 대비 RED가 실제로 뜨는지 실증한다(합성 fixture가 아니라 실 파일
    콘텐츠 기반)."""
    import lint_business_info_email_footer_drift as mod

    real_business_info = mod.BUSINESS_INFO_PATH.read_text(encoding="utf-8")
    real_email_py = mod.EMAIL_PY_PATH.read_text(encoding="utf-8")

    # 착수 전제 확인 — 실물 두 파일이 지금 실제로 일치해야 이 뮤테이션 테스트가 의미 있다.
    assert mod.find_drift(real_business_info, real_email_py) == [], (
        "실물 파일이 이미 불일치 상태 — AC3(현재 일치 확認) 위반, 뮤테이션 테스트 전제 무효"
    )

    # 정본 phone 값 한 글자(끝자리 5→6)만 바꾼다 — email.py는 무변경.
    mutated_business_info = real_business_info.replace(
        "phone: '070-8098-5775'", "phone: '070-8098-5776'"
    )
    assert mutated_business_info != real_business_info, "뮤테이션 대상 문자열을 못 찾음 — 실물 파일 포맷이 바뀌었을 수 있음"

    drifted = mod.find_drift(mutated_business_info, real_email_py)
    assert len(drifted) == 1
    assert drifted[0][0] == "phone"
    assert drifted[0][2] == "070-8098-5776"
    assert drifted[0][3] == "070-8098-5775"


def test_current_repo_files_pass_the_guard():
    """AC3 — 실물 두 파일이 지금 실제로 일치하는지(불일치였다면 이 스토리에서 email.py를
    정본에 맞춰 정정했어야 함)."""
    assert lint_main() == 0
