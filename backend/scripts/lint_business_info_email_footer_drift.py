"""story #3216(위생·가드, 2026-08-29 · #3206 메일 브랜드 셸 design 리뷰에서 유나 비차단
기록) — 메일 셸 푸터의 회사정보(상호·대표·사업자등록번호·주소·전화)가
backend/app/services/email.py에 **수동 사본**으로 박혀 있다. 정본은 FE
apps/web/src/lib/legal/business-info.ts(전자상거래법 §10 SSOT) — 크로스파일(FE TS ↔
BE Python, 별도 런타임이라 import 불가)이라 기존 어떤 가드도 정본이 바뀔 때 이 사본이
같이 안 바뀌면 조용히 낡는 걸 못 잡는다.

⛔이 가드가 잡는 것: business-info.ts의 BUSINESS_INFO 필드값과 email.py의 대응
_COMPANY_* 상수값이 자구(문자열 그대로) 불일치할 때만.

⛔이 가드가 **못 잡는 것**(자인, AC2):
1. 포맷만 다른 동일 정보의 의미적 동치(예: "070-8098-5775" vs "07080985775") — 순수
   문자열 비교라 다르면 무조건 RED. 실제로 같은 값을 두 파일에 다른 포맷으로 적었다면
   그것도 이 가드 관점에선 드리프트(자구 SSOT 원칙상 올바른 판정 — 포맷도 자구의 일부).
2. business-info.ts/email.py 양쪽의 코드 구조(따옴표 스타일·변수명 등)가 이 스크립트의
   정규식이 못 읽는 형태로 바뀌면 "추출실패"로 보수적으로 RED 처리하지만, 그 실패 자체가
   무엇 때문인지는 사람이 봐야 안다(정규식 파서의 구조적 한계).
3. mailOrderNumber(통신판매업 신고번호)는 email.py 푸터에 애초에 없다(v2 시안 스코프
   밖) — 대조 대상에서 의도적으로 제외.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
BUSINESS_INFO_PATH = REPO_ROOT / "apps/web/src/lib/legal/business-info.ts"
EMAIL_PY_PATH = Path(__file__).resolve().parent.parent / "app/services/email.py"

# SSOT 필드명 -> email.py 상수명. mailOrderNumber는 대조 대상 아님(위 ③).
FIELD_TO_CONST = {
    "companyName": "_COMPANY_NAME",
    "ceo": "_COMPANY_CEO",
    "registrationNumber": "_COMPANY_REG_NO",
    "address": "_COMPANY_ADDRESS",
    "phone": "_COMPANY_PHONE",
}


def extract_business_info_fields(text: str) -> dict[str, str]:
    """business-info.ts의 `key: '값'` 자구를 그대로 뽑는다 — 포맷 정규화 없음(자구 대조)."""
    fields: dict[str, str] = {}
    for key in FIELD_TO_CONST:
        m = re.search(rf"\b{re.escape(key)}\s*:\s*'((?:[^'\\]|\\.)*)'", text)
        if m:
            fields[key] = m.group(1)
    return fields


def extract_email_py_constants(text: str) -> dict[str, str]:
    """email.py의 `_COMPANY_X = "값"` 모듈 상수를 그대로 뽑는다."""
    consts: dict[str, str] = {}
    for const_name in FIELD_TO_CONST.values():
        m = re.search(rf'^{re.escape(const_name)}\s*=\s*"((?:[^"\\]|\\.)*)"', text, re.MULTILINE)
        if m:
            consts[const_name] = m.group(1)
    return consts


def find_drift(business_info_text: str, email_py_text: str) -> list[tuple[str, str, str, str]]:
    """(field, const_name, ssot_value, footer_value) 불일치 목록. 어느 한쪽에서 값을 못
    뽑아도(정규식 실패=파일 구조 변경) 드리프트로 보수적 보고 — "일치"로 오판해 조용히
    통과시키지 않는다."""
    ssot = extract_business_info_fields(business_info_text)
    footer = extract_email_py_constants(email_py_text)
    drifted: list[tuple[str, str, str, str]] = []
    for field, const_name in FIELD_TO_CONST.items():
        ssot_val = ssot.get(field)
        footer_val = footer.get(const_name)
        if ssot_val is None or footer_val is None or ssot_val != footer_val:
            drifted.append((field, const_name, ssot_val if ssot_val is not None else "<추출실패>",
                             footer_val if footer_val is not None else "<추출실패>"))
    return drifted


def main() -> int:
    business_info_text = BUSINESS_INFO_PATH.read_text(encoding="utf-8")
    email_py_text = EMAIL_PY_PATH.read_text(encoding="utf-8")
    drifted = find_drift(business_info_text, email_py_text)
    if drifted:
        print(f"FAIL: business-info.ts ↔ email.py 회사정보 자구 드리프트 {len(drifted)}건")
        for field, const_name, ssot_val, footer_val in drifted:
            print(f"  {field}(SSOT)='{ssot_val}' != {const_name}(footer)='{footer_val}'")
        print(
            "이 가드는 자구(문자열 그대로) 대조만 한다 — 포맷만 다른 동일 정보의 의미적"
            " 동치 판정은 범위 밖이다(story #3216 ②). business-info.ts가 정본 — email.py의"
            " _COMPANY_* 상수를 거기 맞춰 정정할 것."
        )
        return 1
    print(f"OK: 회사정보 자구 {len(FIELD_TO_CONST)}건 전부 business-info.ts ↔ email.py 일치")
    return 0


if __name__ == "__main__":
    sys.exit(main())
