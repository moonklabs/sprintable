"""story #2459 회귀(2026-08-05, PR #2851) — 「commit() 後 model_validate() 前 refresh
누락」클래스를 CI 로 원천봉쇄한다.

배경: #2459(auth 의존체인이 primary 커넥션을 요청 전체 동안 쥐고 있던 §6 구조 문제) 수정이
prod MissingGreenlet 500 을 깨웠다 — `stories.py::update_story`에서 `await db.commit()` 뒤에
`StoryResponse.model_validate(story)`를 동기 호출했는데, `story.updated_at`이 unloaded
상태라 lazy-load 가 greenlet 밖에서 트리거됐다. `expire_on_commit=False`(양쪽 세션 팩토리
확인됨)인데도 관측상 commit 이후 속성이 종종 unloaded 로 남는다 — ⚠️정확한 트리거 메커니즘은
«끝내 확定하지 못했다»(양성대조: `session.expire()` 강제로 실패 재현은 성공, 근데 prod가
«왜» commit 후 expire 상태가 되는지는 미상). 트리거를 모르는 채 재배포하면 «모르는 자리»서
또 터질 수 있어, 원인 규명 대신 **클래스 전체를 봉쇄**하는 접근을 택했다(PO 판정, 카디르 QA
AST 스캔으로 최초 3곳 넘어 7곳 추가 발견 후 "10곳 다 고치고 재배포" 지시).

⛔이 lint가 잡는 패턴: 같은 (async) 함수 안에서 `<expr>.commit()` 호출 뒤, `X.model_validate(obj)`
(obj 가 단순 이름)가 나오는데, 그 사이에 `<expr>.refresh(obj)` 나 `obj = ...` 재대입이 없는 경우.
순수 AST 정적분석(변수명 매칭) — 함수 안에서만 추적하고 크로스함수 데이터흐름은 안 본다.

⛔범위: `app/routers`, `app/services`, `ee` 전체를 스캔한다(story #2459 수정 당시 라우터만
스캔했다가 카디르 QA 가 "서비스단도 봐야" 지적 — 실제로 `app/services/hypothesis.py`의
`_to_response()`/`HypothesisResponse.from_model()` 간접 호출 경유 사이트 1건을 이 AST
스캐너로는 못 잡고 수동 감사로 찾았다. 그 사이트는 고쳤지만, **같은 간접-호출 패턴
(헬퍼 함수나 `from_model`류 classmethod 뒤에 숨은 model_validate)은 이 lint의 알려진
사각지대로 남는다** — 새 헬퍼를 만들 때 이 패턴을 쓰면 이 lint가 못 본다.

⛔grandfather 베이스라인 없음: 2026-08-05 도입 시점에 스캔 대상 3개 디렉터리에 위반 0건
(#2851에서 스캐너가 찾은 20곳 + 수동 감사로 찾은 1곳, 총 21곳을 전부 고친 뒤 확認) —
그래서 이 lint는 baseline 관용 없이 위반이 하나라도 있으면 즉시 FAIL한다(#2335/#2451과
다른 계약 — 저건 기존 위반이 있어 grandfather 했고, 이건 처음부터 0건이라 그럴 필요가 없다).

⛔이 lint가 «못 잡는» 것(정직하게 적어둔다 — story #2335 AC5 와 같은 원칙):
  ①헬퍼 함수/classmethod 뒤에 숨은 간접 model_validate (위 hypothesis.py 사례).
  ②`getattr`/동적 호출로 commit 또는 model_validate 를 부르는 경우.
  ③trigger 메커니즘 자체가 미상이라, 이 lint를 통과해도 "안전이 증명된 것"은 아니다 —
    다만 "commit 後 refresh 없이 model_validate" 라는 «알려진» 실패 모양은 막는다.
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
SCAN_ROOTS = ["app/routers", "app/services", "ee"]


class _Event:
    __slots__ = ("lineno", "kind", "var")

    def __init__(self, lineno: int, kind: str, var: str | None = None) -> None:
        self.lineno = lineno
        self.kind = kind  # "commit" | "validate" | "refresh" | "assign"
        self.var = var


def _is_commit_call(node: ast.Call) -> bool:
    return isinstance(node.func, ast.Attribute) and node.func.attr == "commit"


def _is_refresh_call(node: ast.Call) -> str | None:
    if isinstance(node.func, ast.Attribute) and node.func.attr == "refresh":
        if node.args and isinstance(node.args[0], ast.Name):
            return node.args[0].id
    return None


def _is_validate_call(node: ast.Call) -> str | None:
    if isinstance(node.func, ast.Attribute) and node.func.attr == "model_validate":
        if node.args and isinstance(node.args[0], ast.Name):
            return node.args[0].id
    return None


def scan_function(fn: ast.AST) -> list[tuple[int, str]]:
    events: list[_Event] = []

    class Visitor(ast.NodeVisitor):
        def visit_Assign(self, node: ast.Assign) -> None:
            for t in node.targets:
                if isinstance(t, ast.Name):
                    events.append(_Event(node.lineno, "assign", t.id))
            self.generic_visit(node)

        def visit_Call(self, node: ast.Call) -> None:
            if _is_commit_call(node):
                events.append(_Event(node.lineno, "commit"))
            r = _is_refresh_call(node)
            if r:
                events.append(_Event(node.lineno, "refresh", r))
            v = _is_validate_call(node)
            if v:
                events.append(_Event(node.lineno, "validate", v))
            self.generic_visit(node)

    Visitor().visit(fn)
    events.sort(key=lambda e: e.lineno)

    findings: list[tuple[int, str]] = []
    seen_commit = False
    safe_vars_since_commit: set[str] = set()
    for e in events:
        if e.kind == "commit":
            seen_commit = True
            safe_vars_since_commit = set()
        elif e.kind in ("refresh", "assign"):
            if e.var:
                safe_vars_since_commit.add(e.var)
        elif e.kind == "validate":
            if seen_commit and e.var not in safe_vars_since_commit:
                findings.append((e.lineno, e.var))
    return findings


def scan_file(path: Path) -> list[tuple[str, int, str, str]]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except SyntaxError:
        return []
    out: list[tuple[str, int, str, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
            for lineno, var in scan_function(node):
                out.append((str(path.relative_to(BACKEND_ROOT)), lineno, node.name, var))
    return out


def scan_repo() -> list[tuple[str, int, str, str]]:
    findings: list[tuple[str, int, str, str]] = []
    for root in SCAN_ROOTS:
        root_path = BACKEND_ROOT / root
        if not root_path.exists():
            continue
        for path in sorted(root_path.rglob("*.py")):
            findings.extend(scan_file(path))
    return findings


def main() -> int:
    findings = scan_repo()
    if findings:
        print(
            f"FAIL: commit() 後 model_validate() 前 refresh/재대입 없는 자리 {len(findings)}건 "
            "발견(story #2459 회귀 클래스, PR #2851/#2461 lint):"
        )
        for file, lineno, func, var in findings:
            print(f"  {file}:{lineno} in {func}() — model_validate({var}) commit 後 refresh 없음")
        print(
            "\n고치는 법: commit() 직후·model_validate() 직전에 `await <session>.refresh(<obj>)` "
            "를 넣는다(gates.py/stories.py/goals.py 등 #2851 커밋 참고). 헬퍼 함수 뒤에 숨은 "
            "간접 model_validate 는 이 lint 사각지대(스크립트 docstring 참조) — 새로 짤 때 직접 "
            "주의할 것."
        )
        return 1
    print("OK: commit() 後 refresh 없는 model_validate() 0건")
    return 0


if __name__ == "__main__":
    sys.exit(main())
