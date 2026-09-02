"""story #3259 AC4(코드 grep 축) — moonklabs org id·이름이 조건 분기로 등장하면 위반.
설명/주석 텍스트("moonklabs도 고객 #N" 류)까지 잡으면 이 테스트 자체가 못 쓰게 되므로,
실제 코드 토큰(리터럴 UUID·변수 비교)만 스캔한다."""
from __future__ import annotations

import re
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent / "app"

# 실측(list_team_members): moonklabs org 실 UUID.
MOONKLABS_ORG_UUID = "54bac162-5c0d-49fa-8e49-85977063a091"


def test_no_hardcoded_moonklabs_org_uuid_in_source():
    offenders = []
    for path in APP_DIR.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        if MOONKLABS_ORG_UUID in text:
            offenders.append(str(path))
    assert offenders == [], f"moonklabs org UUID 리터럴이 소스에 등장: {offenders}"


def test_no_org_id_equality_special_case():
    """`org_id == <literal>` 류 조건 분기 자체가 없어야 한다(어떤 org id를 비교하든) —
    org 소속 판별은 항상 위임 토큰 클레임 신뢰만으로 이뤄지고, 특정 org를 골라내는
    분기가 코드에 있으면 그 자체가 설계 위반 신호."""
    pattern = re.compile(r"org_id\s*==\s*[\"']")
    offenders = []
    for path in APP_DIR.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        for i, line in enumerate(text.splitlines(), start=1):
            if pattern.search(line):
                offenders.append(f"{path}:{i}: {line.strip()}")
    assert offenders == [], f"org_id 리터럴 비교 발견: {offenders}"
