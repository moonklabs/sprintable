"""story #3008(카디르 3003 축② 발견, 공개 레포 위생) — `backend/scripts/`에 ad-hoc 진단
스크립트의 실행 결과(실 prod 접속정보·직원 이메일·내부 UUID 매핑)가 그대로 커밋된 사고
(`fk_null_survey_result.json`, 2026-05-04 커밋·2026-08-24 HEAD 제거)의 재발 방지 가드.

⛔무엇을 잡는가(둘 중 하나면 위반):
  ① 파일명이 "실행해서 나온 산출물"의 관례적 명명(`*_result.*`/`*_survey*.*`/`*_dump.*`)과
     일치 — `.gitignore`에도 같은 패턴을 추가했지만(story #3008), `git add -f`로 강제
     추가되는 경로까지는 gitignore가 못 막는다 — 이 가드가 그 사각을 메운다.
  ② 파일명과 무관하게, 이 사고의 원인이었던 구체적 위험 필드명(`supabase_auth_uid`·
     `cloud_sql_id`·`registered_users_mapping`)을 담고 있음 — 다른 이름으로 커밋돼도
     같은 종류의 내부 매핑 데이터면 잡는다.

⛔baseline 없음 — 이 가드 도입 시점(2026-08-24) `backend/scripts/`에 위반 0건 확認 후 켰다
   (fk_null_survey_result.json은 이 PR에서 같이 제거).

⛔이 가드가 못 잡는 것(선언, story #2786 관례와 동형): `backend/scripts/` 밖에 같은 산출물이
   커밋되는 경우(스코프 밖 — 카디르 3003 발견은 이 디렉토리 한정), 위 세 필드명 없이 다른
   형태의 실 데이터를 담는 파일(콘텐츠 시그니처가 늘 필요하면 이 목록을 넓힌다).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent

_NAME_PATTERNS = (
    re.compile(r"_result\.\w+$"),
    re.compile(r"_survey.*\.\w+$"),
    re.compile(r"_dump\.\w+$"),
)
_DANGEROUS_FIELD_RE = re.compile(r"supabase_auth_uid|cloud_sql_id|registered_users_mapping")

# 이 가드 자신·문서(docstring에 위 필드명을 예시로 인용하는 스크립트)는 스캔 대상에서 뺀다.
_SELF = Path(__file__).name


def find_violations(root: Path) -> list[tuple[str, str]]:
    violations: list[tuple[str, str]] = []
    for path in sorted(root.glob("*")):
        if not path.is_file() or path.name == _SELF:
            continue
        name_hit = any(p.search(path.name) for p in _NAME_PATTERNS)
        content_hit = False
        try:
            content_hit = bool(_DANGEROUS_FIELD_RE.search(path.read_text(encoding="utf-8", errors="ignore")))
        except OSError:
            pass
        if name_hit:
            violations.append((str(path), "파일명이 실행-산출물 명명 관례(*_result/*_survey*/*_dump)와 일치"))
        elif content_hit:
            violations.append((str(path), "내부 UUID 매핑 필드명(supabase_auth_uid 등) 포함"))
    return violations


def main() -> int:
    violations = find_violations(SCRIPTS_DIR)
    print(f"스캔 대상: {SCRIPTS_DIR}")
    if violations:
        print(f"FAIL: 커밋 금지 대상 산출물 파일 {len(violations)}건 발견")
        print("story #3008 판정: backend/scripts/의 ad-hoc 진단 스크립트 결과물은 실 prod")
        print("접속정보·직원 PII를 담을 수 있다 — 커밋하지 않는다(.gitignore로도 막되, 이 가드가")
        print("강제추가/다른 파일명 우회를 재확인).")
        for file, reason in violations:
            print(f"  {file} — {reason}")
        return 1
    print("OK: backend/scripts/ 커밋 금지 대상 산출물 0건")
    return 0


if __name__ == "__main__":
    sys.exit(main())
