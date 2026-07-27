"""오르테가군 지시(2026-07-27, #2215 CI 2연속 재발 후): `team_members`는 실 배포 스키마에서
`members ⋈ project_access` UNION 뷰다(baseline schema.sql) — UNION 뷰는 Postgres에서
자동 갱신 불가라 DML(INSERT/UPDATE/DELETE)이 전부 실패한다. 로컬 `Base.metadata.create_all()`
throwaway DB는 `TeamMember` 모델을 진짜 테이블로 만들어 이 DML이 로컬에서는 통과하지만, CI의
공유 alembic-migrated DB(`pytest -m "not destructive_schema"` 스위트, ci.yml)에서는 항상
깨진다 — 오늘 #2516과 #2215에서 각각 독립적으로 재현된 동일 결함 클래스.

⛔"채팅에 교훈을 남기는 것"과 "다음 사람이 그 자리에 서 있는 것"은 다르다 — 이 파일은 후자를
강제한다. 정적 grep 가드: `pytest.mark.destructive_schema`가 **아닌** 파일(=공유 baseline DB를
쓰는 84개 파일) 안에서 `team_members`에 대한 DML(SQL 문자열) 또는 `TeamMember(...)` ORM
생성자를 통한 삽입 시도가 하나도 없어야 한다. 대체 경로: 휴먼은 org_members(+선택적 members),
에이전트는 members+project_access(member_id 경유) 직접 seed —
`test_doc_mutation_project_scope_idor_realdb.py` 선례. `select(TeamMember...)`(읽기)는 허용.

destructive_schema 마커 파일(story 8236bbc3)은 **자기 전용 격리 create_all DB**
(`sprintable_test_iso`, ci.yml)를 쓰므로 거기서는 TeamMember가 진짜 쓰기 가능한 테이블이다 —
이 가드가 잡으면 안 되는 정당한 축이라 명시 제외한다.

⚠️이 가드가 못 잡는 것(오르테가군 지적, 2026-07-27): destructive_schema 파일의 `s.add(
TeamMember(...))` 픽스처를 **그대로 복사**해 non-destructive 파일에 붙여넣으면, 붙여넣은
그 순간엔 이 가드가 새 위반으로 즉시 잡는다 — 그런데 만약 그 복사가 파일 자체를
`destructive_schema`로 마킹하면서 이뤄지면(마커까지 함께 복사) 가드는 그 파일을 통째로
스캔 대상에서 제외해버려 **못 잡는다**. 오늘 #2515/#2519 재발이 정확히 이 경로였다 — "어딘가
(다른 realdb 파일)에서 되던 패턴"을 그대로 옮겨 쓴 것. 마커 자체가 파일의 실제 DB 대상과
일치하는지(정말 자기 전용 create_all이 필요한 테스트인지, 아니면 그냥 team_members를 건드리고
싶어서 마커를 붙인 것인지)는 이 정적 스캔으로 판별 불가 — 코드 리뷰가 여전히 필요한 지점."""
from __future__ import annotations

import re
from pathlib import Path

_TESTS_DIR = Path(__file__).parent

# 이 가드 자신의 docstring/주석에 "team_members"·"TeamMember(" 문자열이 등장하므로 자기 자신은
# 스캔에서 제외한다(설명 텍스트를 결함으로 오탐하는 것 방지).
_SELF = Path(__file__)

# ── 정당한 예외(이유 필수) ────────────────────────────────────────────────────
# 문자열 리터럴이 "이 안티패턴이 코드에 없어야 한다"를 검증하는 대상이지, 실행되는 DML이
# 아니다(라인-단위 정적 스캔이 문자열의 실행 여부를 못 가르는 한계 — 반대 방향 오탐).
_ASSERTS_ABSENCE_ALLOWLIST = {
    "test_auth_fallback_fix.py",
    "test_e_entity_cleanup_s5_human_cleanup.py",
}
# story 8236bbc3: CI에서 의도적으로 전량 제외(자기 파일 docstring에 명시) — legacy cutover
# parity 테스트, 이미 obsolete. 실행 자체가 안 되니 이 가드의 대상이 아니다.
_CI_EXCLUDED_ALLOWLIST = {
    "test_member_ssot_parity_realdb.py",
}

_SQL_DML_PATTERN = re.compile(
    r"(?i)\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+team_members\b"
)
# ORM 삽입: s.add(TeamMember(...)) / session.add(TeamMember(...)) — select(TeamMember...)는
# 정상 읽기라 별개 패턴(add( 뒤에 바로 TeamMember( 가 와야만 매치).
_ORM_INSERT_PATTERN = re.compile(r"\.add\(\s*TeamMember\(")
_DESTRUCTIVE_SCHEMA_MARKER = re.compile(r"pytest\.mark\.destructive_schema")


def test_no_team_members_view_dml_in_tests():
    violations = []
    for path in _TESTS_DIR.glob("*.py"):
        if path == _SELF or path.name in _ASSERTS_ABSENCE_ALLOWLIST | _CI_EXCLUDED_ALLOWLIST:
            continue
        text = path.read_text()
        if _DESTRUCTIVE_SCHEMA_MARKER.search(text):
            continue  # 자기 전용 격리 create_all DB — TeamMember가 진짜 테이블.
        for lineno, line in enumerate(text.splitlines(), 1):
            if _SQL_DML_PATTERN.search(line) or _ORM_INSERT_PATTERN.search(line):
                violations.append(f"{path.name}:{lineno}: {line.strip()}")
    assert not violations, (
        "공유 baseline DB(non-destructive_schema)를 쓰는 파일에서 team_members DML 발견 — "
        "team_members는 실 배포 스키마에서 UNION 뷰(members ⋈ project_access)라 "
        "INSERT/UPDATE/DELETE가 전부 실패한다(로컬 create_all throwaway DB에서만 통과하고 "
        "CI 실 스키마에서는 깨짐 — #2516·#2215 2연속 재발). "
        "휴먼은 org_members(+members)를, 에이전트는 members+project_access(member_id 경유)를 "
        "직접 seed할 것(destructive_schema 마커를 붙여 자기 전용 create_all DB로 격리하는 "
        "것도 대안이나 원래 목적이 공유 DB 검증이면 그건 회피가 아니라 우회):\n" + "\n".join(violations)
    )
