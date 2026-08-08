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
싶어서 마커를 붙인 것인지)는 이 정적 스캔으로 판별 불가 — 코드 리뷰가 여전히 필요한 지점.

story #2523(카디르 #2908 QA, 2026-08-08) 근본수정 — ORM 삽입 탐지가 정규식 라인-스캔
(add( 바로 뒤 같은 줄 TeamMember( 만 매치)이라 「생성과 add를 두 줄로 나누면」 회피됐다:
```
tm = TeamMember(id=..., ...)
s.add(tm)
```
#2908의 3번째 테스트가 정확히 이 형태로 가드를 PASS했으나 CI alembic DB에서
`cannot insert into view "team_members"`로 크래시했다. AST 기반 탐지로 교체 —
①`.add(TeamMember(...))` 직접 형태, ②`x = TeamMember(...)` 뒤 `add(x)`, ③`y = x`
단일 alias 뒤 `add(y)`까지 파일 전체 스코프로 추적한다(변수명 재사용 오탐은 실행되는
코드가 아닌 정적 존재-금지 가드라 손해가 없다 — 허용 목록으로 예외 처리 가능).

⚠️이 AST 스캔도 못 잡는 것(정직하게 남김 — «가드는 못 잡는 것도 선언»):
- 속성 체인 보관: `obj.tm = TeamMember(...)` 뒤 `add(obj.tm)`(대입 대상이 단순 이름이
  아니면 추적 안 함).
- 함수 경계 통과: `def make(): return TeamMember(...)` 뒤 `x = make(); add(x)`(값이
  직접 TeamMember(...) 호출이 아니라 다른 함수 호출이면 추적 안 함).
- `session.add_all([...])`(`.add(` 단일 인자 형태만 스캔 — 리스트/컴프리헨션·루프로
  나온 항목은 미대상, 정규식 시절부터 있던 기존 갭).
- 2단 이상 alias 체인(`y = x; z = y; add(z)`)은 안 잡을 수 있음(1단만 보장)."""
from __future__ import annotations

import ast
from pathlib import Path
import re

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
_DESTRUCTIVE_SCHEMA_MARKER = re.compile(r"pytest\.mark\.destructive_schema")


def _is_teammember_call(node: ast.expr | None) -> bool:
    """`TeamMember(...)` 또는 `<module>.TeamMember(...)` 호출인지."""
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    if isinstance(func, ast.Name):
        return func.id == "TeamMember"
    return isinstance(func, ast.Attribute) and func.attr == "TeamMember"


def _is_add_call(func_node: ast.expr) -> bool:
    """`<anything>.add(...)` 형태(세션 변수명을 가리지 않음 — s/session/db 등 전부 커버)."""
    return isinstance(func_node, ast.Attribute) and func_node.attr == "add"


def _find_orm_insert_violations(tree: ast.Module) -> list[tuple[int, str]]:
    """story #2523 근본수정 — 정규식 라인-스캔은 `.add(` 바로 뒤 같은 줄 `TeamMember(`만
    잡아 「변수에 담아 add」·「두 줄로 나눔」에 회피됐다(#2908 3번째 테스트가 이 형태로
    가드를 통과하고 CI에서 크래시). 파일 전체를 대상으로 ①TeamMember(...) 호출로 대입된
    변수, ②그 변수의 1단 alias까지 추적해 `.add(...)` 인자로 쓰이는지 본다. 못 잡는 형태는
    파일 docstring에 명시(속성 체인·함수 반환값·add_all·2단 이상 alias)."""
    teammember_vars: set[str] = set()
    # 고정점: alias 체인(y = x)이 다음 패스에서 잡히도록 최대 5회 반복(비용 거의 0 — 파일당
    # assign 문 수는 보통 수십 개 규모라 5회면 충분히 수렴, 그 이상 체인은 문서화된 기존 갭).
    for _ in range(5):
        grew = False
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            is_direct = _is_teammember_call(node.value)
            is_alias = isinstance(node.value, ast.Name) and node.value.id in teammember_vars
            if not (is_direct or is_alias):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id not in teammember_vars:
                    teammember_vars.add(target.id)
                    grew = True
        if not grew:
            break

    violations: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and _is_add_call(node.func)):
            continue
        for arg in node.args:
            hit = _is_teammember_call(arg) or (
                isinstance(arg, ast.Name) and arg.id in teammember_vars
            )
            if hit:
                violations.append((node.lineno, ast.unparse(node)))
    return violations


def test_no_team_members_view_dml_in_tests():
    violations = []
    for path in _TESTS_DIR.glob("*.py"):
        if path == _SELF or path.name in _ASSERTS_ABSENCE_ALLOWLIST | _CI_EXCLUDED_ALLOWLIST:
            continue
        text = path.read_text()
        if _DESTRUCTIVE_SCHEMA_MARKER.search(text):
            continue  # 자기 전용 격리 create_all DB — TeamMember가 진짜 테이블.
        for lineno, line in enumerate(text.splitlines(), 1):
            if _SQL_DML_PATTERN.search(line):
                violations.append(f"{path.name}:{lineno}: {line.strip()}")
        tree = ast.parse(text, filename=str(path))
        for lineno, snippet in _find_orm_insert_violations(tree):
            violations.append(f"{path.name}:{lineno}: {snippet}")
    assert not violations, (
        "공유 baseline DB(non-destructive_schema)를 쓰는 파일에서 team_members DML 발견 — "
        "team_members는 실 배포 스키마에서 UNION 뷰(members ⋈ project_access)라 "
        "INSERT/UPDATE/DELETE가 전부 실패한다(로컬 create_all throwaway DB에서만 통과하고 "
        "CI 실 스키마에서는 깨짐 — #2516·#2215 2연속 재발). "
        "휴먼은 org_members(+members)를, 에이전트는 members+project_access(member_id 경유)를 "
        "직접 seed할 것(destructive_schema 마커를 붙여 자기 전용 create_all DB로 격리하는 "
        "것도 대안이나 원래 목적이 공유 DB 검증이면 그건 회피가 아니라 우회):\n" + "\n".join(violations)
    )


# ── #2523: 스캐너 자신의 검출/미검출 범위 pin(단발 probe가 아니라 CI가 계속 지키게) ──────────
def _violations_in(source: str) -> list[tuple[int, str]]:
    return _find_orm_insert_violations(ast.parse(source))


def test_ast_scanner_catches_same_line_direct_insert():
    src = "def f(session):\n    session.add(TeamMember(id=1))\n"
    assert len(_violations_in(src)) == 1


def test_ast_scanner_catches_two_line_assign_then_add():
    """⭐본체(#2523) — #2908 3번째 테스트가 정규식을 통과했던 그 정확한 형태."""
    src = "def f(session):\n    tm = TeamMember(id=1)\n    session.add(tm)\n"
    assert len(_violations_in(src)) == 1


def test_ast_scanner_catches_single_hop_alias():
    src = "def f(session):\n    tm = TeamMember(id=1)\n    tm2 = tm\n    session.add(tm2)\n"
    assert len(_violations_in(src)) == 1


def test_ast_scanner_allows_select_read():
    """회귀 0 — select(TeamMember...)는 읽기라 위반 아님(add(가 전혀 없음)."""
    src = "def f(session):\n    session.execute(select(TeamMember).where(TeamMember.id == 1))\n"
    assert _violations_in(src) == []


def test_ast_scanner_known_gap_attribute_chain_not_caught():
    """⭐known-gap pin(문서화된 미검출 그대로 고정) — `obj.tm = TeamMember(...)` 뒤
    `add(obj.tm)`은 대입 대상이 단순 Name이 아니라 이 스캐너가 못 잡는다. 스캐너가
    우연히 이걸 잡게 개선되면 이 pin이 실패해 「문서와 실제가 갈라짐」을 알린다 — 그때
    docstring의 '못 잡는 것' 목록에서 이 항목을 지울 것."""
    src = (
        "def f(session, obj):\n"
        "    obj.tm = TeamMember(id=1)\n"
        "    session.add(obj.tm)\n"
    )
    assert _violations_in(src) == []
