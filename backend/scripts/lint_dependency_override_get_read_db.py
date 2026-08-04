"""story #2451(§6 Phase3, 카디르 QA 3차 재발 2026-08-04) — 「test override 스윕이
get_read_db 를 놓친다」클래스를 CI 로 원천봉쇄한다.

배경: read replica 라우팅(#2451 A1/A2)이 진행되며 `app.dependency_overrides[get_db]
= X`만 걸고 `get_read_db`는 빠뜨리는 테스트가 **세 번** 발견됐다 — A1 사후 12건, A2
`/api/v2/epics`(legacy alias, main.py가 goals.router를 두 prefix로 재마운트) 7건,
그리고 공용 헬퍼(`tests.conftest.override_db_and_read`)를 만든 뒤에도 «그 헬퍼를 어느
파일에 적용할지»를 사람이 수동으로 path-grep해 고르다 3건(그중 하나는 project-scope
IDOR 보안테스트)을 또 놓쳤다. 카디르 QA 진단: 헬퍼 자체는 옳으나 «선택»이 사람 손이라
계속 샌다.

⇒ 근본: 선택을 없앤다. `app.dependency_overrides[get_db] = X` 같은 **raw 직접 대입**
자체를 금지하고, `override_db_and_read(app, X)` 헬퍼를 통해서만 걸게 강제한다. 이러면
어떤 엔드포인트가 read replica 로 라우팅되든(현재·미래·legacy alias 무관) — 애초에
get_db 만 단독으로 걸 방법이 없어 «놓칠 대상 자체가 없어진다»(카디르의 endpoint-aware
버전보다 견고 — 엔드포인트 목록을 추적할 필요가 없다).

⛔이 lint가 잡는 패턴: `<expr>.dependency_overrides[get_db] = <expr>` raw 대입(AST
Assign, target이 Subscript[Attribute(dependency_overrides), Name(get_db)]).
`override_db_and_read(...)` 호출(그 내부 구현 포함, conftest.py 자체)은 대상에서
제외한다(헬퍼 자신은 당연히 raw 대입을 한다 — 그게 헬퍼의 일이다).

⛔grandfather 베이스라인: 이 lint를 처음 켠 시점(2026-08-04) A1/A2가 손대지 않은
tests/ 전역에 이미 raw get_db-only override 가 수백 건 있다(이 스토리 스코프 밖 —
get_read_db 가 필요없는 라우트만 쓰는 테스트가 대부분이라 당장 문제는 아니다). 지금
시점 전량을 베이스라인에 동결하고, **새 위반만** CI를 빨갛게 한다(#2335/#2342와 같은
계약 — "지금 있는 걸 고쳐라"가 아니라 "새로 만들지 마라").
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

TESTS_DIR = Path(__file__).parent.parent / "tests"
BASELINE_PATH = Path(__file__).parent / "dependency_override_get_read_db_baseline.txt"
# 헬퍼 자신의 구현 파일 — 여기의 raw 대입은 당연히 예외(헬퍼가 곧 그 raw 대입을 하는 자리).
HELPER_FILE = TESTS_DIR / "conftest.py"


def _is_raw_get_db_override(node: ast.AST) -> bool:
    """node(Assign 문)가 `<expr>.dependency_overrides[get_db] = <expr>` 형태인지."""
    if not isinstance(node, ast.Assign) or len(node.targets) != 1:
        return False
    target = node.targets[0]
    if not isinstance(target, ast.Subscript):
        return False
    # target.value 는 `<expr>.dependency_overrides` — Attribute(attr="dependency_overrides")
    if not (isinstance(target.value, ast.Attribute) and target.value.attr == "dependency_overrides"):
        return False
    # target.slice 는 get_db (Name) — py3.9+ ast.Subscript.slice is the index expr directly.
    idx = target.slice
    return isinstance(idx, ast.Name) and idx.id == "get_db"


def find_violations(path: Path) -> list[tuple[str, int, str]]:
    """(file, lineno, enclosing_function_or_module) 위반 목록."""
    tree = ast.parse(path.read_text(), filename=str(path))
    violations: list[tuple[str, int, str]] = []

    def _scope_name(node: ast.AST) -> str:
        for parent in ast.walk(tree):
            if isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if node in ast.walk(parent):
                    # innermost — walk 순서상 마지막 매치가 더 안쪽일 수 있어 계속 갱신.
                    pass
        # 단순화: 함수 전체를 순회하며 직계 소속 함수를 찾는다(중첩 시 가장 안쪽 우선).
        best = "<module>"
        best_depth = -1

        def _visit(n: ast.AST, funcs: list[str]):
            nonlocal best, best_depth
            if n is node:
                if len(funcs) > best_depth:
                    best = funcs[-1] if funcs else "<module>"
                    best_depth = len(funcs)
                return
            new_funcs = funcs
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                new_funcs = funcs + [n.name]
            for child in ast.iter_child_nodes(n):
                _visit(child, new_funcs)

        _visit(tree, [])
        return best

    for node in ast.walk(tree):
        if _is_raw_get_db_override(node):
            violations.append((str(path), node.lineno, _scope_name(node)))
    return violations


def violation_key(file: str, func: str) -> str:
    """라인번호 제외(다른 편집으로 흔들림) — (파일 상대경로, 함수명)만으로 식별."""
    rel = str(Path(file).relative_to(Path(__file__).parent.parent))
    return f"{rel}::{func}"


def load_baseline() -> set[str]:
    if not BASELINE_PATH.exists():
        return set()
    return {
        line.strip() for line in BASELINE_PATH.read_text().splitlines()
        if line.strip() and not line.startswith("#")
    }


def scan_repo() -> list[tuple[str, int, str]]:
    violations = []
    for path in sorted(TESTS_DIR.glob("*.py")):
        if path.resolve() == HELPER_FILE.resolve():
            continue  # 헬퍼 구현 자신은 raw 대입이 정상(헬퍼가 그 자리다).
        violations.extend(find_violations(path))
    return violations


def main() -> int:
    violations = scan_repo()
    baseline = load_baseline()
    new_violations = [v for v in violations if violation_key(v[0], v[2]) not in baseline]
    grandfathered = len(violations) - len(new_violations)

    print(f"grandfathered: {grandfathered}")
    if new_violations:
        print(f"FAIL: raw `dependency_overrides[get_db] = ...` 대입이 «새» 자리 {len(new_violations)}건 발견")
        print(
            "story #2451: get_db override는 반드시 tests.conftest.override_db_and_read(app, X)"
            " 를 통해서만 걸어야 한다 — get_read_db 를 놓치는 whack-a-mole(A1 12건·A2 epics"
            " 7건·A2 QA 3차 3건, 총 세 번 재발)을 구조적으로 막는다."
        )
        for file, lineno, func in new_violations:
            rel = Path(file).relative_to(Path(__file__).parent.parent)
            print(f"  {rel}:{lineno} {func}()")
        return 1
    print(f"OK: 새 위반 0건(베이스라인 {grandfathered}건은 그대로 — read-route 무관 테스트 다수, 스코프 밖)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
