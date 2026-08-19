"""story #2786 — 「공유 실PG를 부수는 테스트 연산」정적 가드. CI가 커밋 시점에 잡는다.

배경(2026-08-18 — 같은 클래스 3일 내 2회):
- 08-16 PR 3088: pytester가 복사한 conftest의 autouse 스키마리셋이 CI 공유 DB에
  `DROP SCHEMA` → 906건 연쇄(story #2662).
- 08-18 PR 3217: 신설 realdb 테스트 autouse가 WHERE 없는
  `DELETE FROM offering_versions`(migration 0228 공유 seed) → 무관 26건 연쇄(story #2777).
공통 구조: 로컬(개인 disposable DB)에선 안 잡히고 CI(공유 실PG·알파벳 순서 실행)에서만
터진다 — 「검사를 어디서 돌렸나」 맹점. 두 사고 모두 실행 **전에** 잡을 방법이 없었다:
`pytest_collection_modifyitems`(conftest.py, story #2643)의 `_calls_raw_ddl_literal`은
`DROP/CREATE/TRUNCATE/ALTER TABLE`만 보고 `DELETE`는 안 본다 — PR#3217급 사고를 원천적으로
못 잡는 사각이었다. 이 가드가 그 사각을 메운다.

⛔`destructive_schema` 마커 파일은 스캔 대상에서 뺀다(오탐 방지 — 최초 스윕에서 32건이
   여기 걸렸다가 전부 이 이유로 제외됨을 실측): story #2293(2026-07-28)이 이미 이 마커가
   붙은 파일을 CI `Backend destructive-schema (shard)` job으로 **파일마다 완전히 새로운
   격리 DB**를 붙여 돌리도록 구조화해놨다(`ci.yml` "isolated fresh DB per file, this
   shard") — 그 안에서의 DROP/TRUNCATE/무WHERE DELETE는 다른 어떤 테스트도 공유하지
   않는 자기 전용 DB만 건드리므로 **이 스토리가 막으려는 위험(공유 CI DB 오염) 자체가
   구조적으로 성립하지 않는다**. 이 가드는 정확히 그 마커가 **없는데** 파괴적 SQL을 쓰는
   파일 — 즉 공유 메인 pytest job(`-m "not destructive_schema"`)에서 도는데 위험한 SQL을
   쓰는 파일만 잡는다(PR#3217이 정확히 이 케이스 — 마커 없이 신설 realdb 테스트가 공유
   DB에서 돌았다).

⛔무엇을 잡는가(conftest.py `_calls_raw_ddl_literal`과 같은 원리 — `text(...)`/`.execute(...)`
로 **직접 전달된 문자열 리터럴**만 본다, docstring/주석 프로즈 오탐 방지, story #2643 교훈):
  ① `DROP SCHEMA`/`DROP TABLE`/`TRUNCATE` — 무조건(WHERE라는 개념 자체가 없다).
  ② `DELETE FROM <table>` — 같은 문자열 리터럴 안에 `WHERE`가 없으면(테이블 전체 삭제).
     PR#3217 원문(`DELETE FROM offering_versions`, WHERE 없음)이 바로 이 케이스.
     WHERE가 있으면(예: `DELETE FROM org_members WHERE org_id=:o`) — 테스트가 만든 자기
     데이터만 지우는 정상 self-cleanup 관례이므로 통과(백엔드 테스트 전역 그라운딩 실측:
     WHERE절 있는 DELETE FROM 90여 자리 전부 이 패턴).

⛔예외(마커) — 정말 필요한 자리는 같은 줄 또는 바로 윗줄에 `# destructive-sql-allow: <사유>`
   주석이 있으면 통과. conftest.py의 `_reset_public_schema()`(story #2662, `assert_
   disposable_test_db()`로 런타임 이중가드된 유일한 정당한 DROP SCHEMA)가 그 예.

⛔이 가드가 **못 잡는 것**(story #2786 요구사항 — 선언):
  · SQLAlchemy ORM 삭제(`session.execute(delete(Model))`, `Query.delete()`) — 문자열
    리터럴이 아니라 API 호출이라 이 스캐너의 대상 밖(별도 클래스 — ORM delete는 프레임워크가
    자동으로 조건절을 강제하지 않는 한 grep 불가능한 형태로 무한히 다양하다).
  · f-string/`.format()`/`+` 로 **동적 조립**된 SQL 문자열(예: `f"DELETE FROM {t}"`) — AST
    리터럴이 아니라서 파싱 시점에 값이 없다(conftest.py #2643 교훈과 동일 계층의 사각 —
    데이터흐름분석 없인 못 본다, 비용 대비 이득 밖).
  · `text`/`execute`가 아닌 다른 이름으로 wrapping된 실행 경로(`conn.exec_driver_sql` 등,
    1-hop 이상 간접 경로).
  다음에 이 사각을 밟는 사람이 있다면 그게 이 판단이 틀렸다는 신호이니 그때 확장한다
  (conftest.py #2643 docstring과 동일한 원칙).

⛔baseline 없음 — 이 가드 도입 시점(2026-08-19) 스윕으로 기존 위반 전부 정리(WHERE 없는
   DELETE/무마커 DROP·TRUNCATE 0건 확認 후 켰다). #2459 commit-before-validate와 같은 계약
   ("baseline 없음" = 지금 위반이 있으면 그것도 즉시 FAIL, 봐주는 게 없다).

⛔재QA 1라운드(2026-08-19, PR#3221 — 디디 독립검증→PO 격상): 초판이 `TESTS_DIR.glob("*.py")`
   (top-level만)를 써서 `tests/mcp/`(8파일) 등 서브디렉토리가 스캔 밖이었는데, pytest 자신은
   `tests/` 하위를 재귀 실행한다 — 그 하위 파일이 위반을 갖고 있어도 이 가드는 「OK: 0건」이라는
   **거짓 안전 신호**를 냈다("가드가 자기 재료를 못 찾으면 빨강" 원칙의 변형 — 안 본 걸 본 것처럼
   찍는 게 이 가드가 잡으려는 바로 그 클래스). fix: `glob`→`rglob`(재귀)+출력에 "스캔 파일 N개"
   명시(카디르 mobile#61 QA가 요구한 "비교/스킵 계수" 규율과 동형 — 스캔 모수가 줄면 눈에
   보이게)+서브디렉토리 위반 양성대조 테스트 추가.
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

TESTS_DIR = Path(__file__).parent.parent / "tests"

_SQL_EXEC_CALL_NAMES = {"text", "execute"}
_UNCONDITIONAL_RE = re.compile(r"\b(DROP\s+SCHEMA|DROP\s+TABLE|TRUNCATE)\b", re.IGNORECASE)
_DELETE_RE = re.compile(r"\bDELETE\s+FROM\s+\S+", re.IGNORECASE)
_WHERE_RE = re.compile(r"\bWHERE\b", re.IGNORECASE)
_ALLOW_MARKER_RE = re.compile(r"#\s*destructive-sql-allow\s*:")


def _call_func_name(node: ast.Call) -> str | None:
    func = node.func
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return None


def _is_destructive_literal(value: str) -> tuple[bool, str] | None:
    """(위반여부, 사유) — value가 파괴적 SQL 리터럴이면 사유 문자열과 함께 반환, 아니면 None."""
    if _UNCONDITIONAL_RE.search(value):
        return True, "DROP SCHEMA/DROP TABLE/TRUNCATE — 무조건 위반"
    if _DELETE_RE.search(value) and not _WHERE_RE.search(value):
        return True, "DELETE FROM ... — WHERE절 없음(테이블 전체 삭제)"
    return None


def _has_allow_marker(lines: list[str], lineno: int) -> bool:
    """1-index lineno의 같은 줄 또는 바로 윗줄에 destructive-sql-allow 마커가 있는지."""
    for candidate in (lineno - 1, lineno - 2):  # 0-index: 같은 줄, 윗줄
        if 0 <= candidate < len(lines) and _ALLOW_MARKER_RE.search(lines[candidate]):
            return True
    return False


def _is_destructive_schema_mark(node: ast.AST) -> bool:
    """`pytest.mark.destructive_schema` 형태의 Attribute 체인인지(장식자·pytestmark 대입 공용)."""
    return (
        isinstance(node, ast.Attribute)
        and node.attr == "destructive_schema"
        and isinstance(node.value, ast.Attribute)
        and node.value.attr == "mark"
    )


def _has_destructive_schema_marker(tree: ast.AST) -> bool:
    """파일이 `pytestmark = pytest.mark.destructive_schema`(모듈레벨) 또는
    `@pytest.mark.destructive_schema`(함수 데코레이터) 중 하나라도 가지면 True.

    story #2293이 이 마커 파일을 CI `Backend destructive-schema (shard)` job으로
    «파일마다 격리된 fresh DB»에서 돌리도록 이미 구조화해뒀다 — 그 격리 안에서는
    DROP/TRUNCATE/무WHERE DELETE가 이 스토리가 막으려는 위험(공유 CI DB 오염)을
    구조적으로 못 만든다. conftest.py의 `pytest_collection_modifyitems`(story #2643)가
    이 마커 유무로 이미 같은 판별을 하고 있어(파일이 raw DDL 리터럴을 쓰는데 마커가
    없으면 collection 시점에 즉시 UsageError) — 그 판별축과 동일한 신호를 재사용한다.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and _is_destructive_schema_mark(node.value):
            return True
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for deco in node.decorator_list:
                target = deco.func if isinstance(deco, ast.Call) else deco
                if _is_destructive_schema_mark(target):
                    return True
    return False


def find_violations(path: Path) -> list[tuple[str, int, str]]:
    """(file, lineno, reason) — text()/execute()로 실행되는 파괴적 SQL 리터럴(마커 없는 것만).

    destructive_schema 마커 파일은 스캔 자체를 스킵한다(위 docstring 참조 — 격리 shard에서
    돌아 이 스토리가 막으려는 위험이 구조적으로 성립 안 함)."""
    source = path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError:
        return []
    if _has_destructive_schema_marker(tree):
        return []
    lines = source.splitlines()
    violations: list[tuple[str, int, str]] = []

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or _call_func_name(node) not in _SQL_EXEC_CALL_NAMES:
            continue
        for arg in list(node.args) + [kw.value for kw in node.keywords]:
            if not (isinstance(arg, ast.Constant) and isinstance(arg.value, str)):
                continue
            verdict = _is_destructive_literal(arg.value)
            if verdict is None:
                continue
            _, reason = verdict
            if _has_allow_marker(lines, arg.lineno):
                continue
            violations.append((str(path), arg.lineno, reason))
    return violations


def scan_dir(root: Path) -> tuple[list[tuple[str, int, str]], int]:
    """(violations, scanned_file_count). rglob — pytest는 tests/ 하위 서브디렉토리(예: tests/mcp/)
    까지 재귀 실행하는데(story #2786 재QA, PO 격상 — 디디 3221 fix), 이전 버전이 top-level
    glob만 써서 그 하위 파일들이 스캔 밖인데 pytest는 도는 «거짓 안전 신호»였다. «가드가 자기
    재료를 못 찾으면 빨강» 원칙의 변형 — 안 본 걸 본 것처럼 찍는 게 이 가드가 잡으려는 바로
    그 클래스다."""
    violations = []
    files = sorted(root.rglob("*.py"))
    for path in files:
        violations.extend(find_violations(path))
    return violations, len(files)


def scan_repo() -> tuple[list[tuple[str, int, str]], int]:
    return scan_dir(TESTS_DIR)


def main() -> int:
    violations, scanned = scan_repo()
    print(f"스캔 파일 {scanned}개(tests/ 재귀)")
    if violations:
        print(f"FAIL: 공유 실PG를 부술 수 있는 테스트 SQL 리터럴 {len(violations)}건 발견")
        print("story #2786 판정: WHERE 없는 DELETE FROM / DROP SCHEMA·DROP TABLE·TRUNCATE는")
        print("공유 CI DB에서 무관 테스트를 연쇄로 깨뜨린다(PR#3088·PR#3217 실사고).")
        print("정말 필요하면 같은 줄/윗줄에 `# destructive-sql-allow: <사유>` 마커를 다세요.")
        for file, lineno, reason in violations:
            print(f"  {file}:{lineno} — {reason}")
        return 1
    print("OK: 마커 없는 파괴적 테스트 SQL 리터럴 0건")
    return 0


if __name__ == "__main__":
    sys.exit(main())
