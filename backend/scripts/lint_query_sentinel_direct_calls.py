"""story #2335([클래스 봉인]) — `Query(default=None)` 센티널이 직접호출 테스트로 새는
클래스를 CI에서 막는다. 세 번째 재발(#2191→#2659→이 전수) 뒤에 세운 lint다.

메커니즘(story #2330/#2335 본문과 동일): `x: T | None = Query(default=None)`의 기본값은
`T | None`이 아니라 `fastapi.params.Query` **인스턴스**다. FastAPI가 실제 HTTP 요청 경로를
탈 때만 그 센티널을 실값(쿼리 파라미터 또는 None)으로 해소한다. 테스트가 라우터 함수를
직접 호출(`await list_stories(...)`)하면서 그 파라미터를 명시로 안 넘기면, 그 자리에
`Query` 객체 그대로가 들어간다 — `if x is not None:` 같은 가드는 그 객체가 "값이 있다"고
착각해 통과시킨다.

⛔이 lint가 하는 일: `app/routers/*.py`의 각 함수가 선언한 `Query(...)` 파라미터 집합과,
`tests/`의 그 함수 직접호출부가 명시로 넘기는 인자 집합을 AST로 대조한다. 명시로 안 넘긴
Query 파라미터가 하나라도 있으면 그 호출부를 위반으로 보고한다.

⛔grandfather 베이스라인(story #2335 AC6과의 접점 — 반드시 읽어야 한다): 이 lint를 처음
켠 시점(2026-07-30) develop에 이미 위반이 있었다(`query_sentinel_baseline.txt`에 스냅샷).
#2335 AC6은 "41건(그 부분집합이 이 기존 위반들)을 «고치지 않는다»"고 명시로 판정했다 —
조용히 틀리는 것이 0(전부 크래시)이라 개별 수리가 이 판이 아니기 때문이다. 그래서 이 lint는
베이스라인에 있는 기존 위반을 실패시키지 않는다 — 대신 **베이스라인에 없는 새 위반**
(`(파일, 함수, 누락파라미터집합)` 3중키로 식별, 라인번호는 무관한 다른 편집으로 흔들리므로
키에서 제외)만 CI를 빨갛게 한다. 즉 이 lint의 계약은 "지금 있는 걸 고쳐라"가 아니라
"더 이상 늘리지 마라"다 — #2335 AC1이 요구하는 게 정확히 그것이다.

⛔범위: `Query(...)`만 본다(`Depends(...)`는 story #2335 스코프 밖 — 대부분 세션/인증처럼
생략하면 즉시 명백하게 죽어 "조용히 새는" 이 클래스가 아니다).

⛔이 lint가 «못 잡는» 것(story #2335 AC5 — 반드시 읽어야 하는 한계):
  ①`getattr`/동적 함수참조로 호출하는 경우(`fn = globals()[name]; await fn(...)`) — 정적으로
    호출 대상을 특정 못 하면 검사 자체를 안 한다(오탐 방지 우선).
  ②라우터 밖(서비스/repository 계층)에 같은 Query 센티널 패턴을 쓰는 경우 — 이 lint는
    `app/routers/*.py`만 스캔한다. 서비스 함수가 직접 `Query(...)`를 쓰는 것 자체가
    이례적이라 실제 사례는 없었으나, 생기면 이 lint 밖이다.
  ③`**kwargs`로 뭉쳐 넘기는 호출부: 그 kwargs 변수의 출처를 «한 단계»(같은 함수 안의
    `dict(...)` 리터럴 대입 + 그 뒤 `.update(dict-리터럴)` 체이닝까지만) 추적한다. 그보다
    복잡한 경로(다른 함수가 만들어 리턴한 dict, 조건부로 키가 붙는 dict 등)는 «추적 불가»로
    판단해 검사를 건너뛴다(SKIPPED로 집계).
    ⭐SKIPPED에 대한 정확한 문장(2026-07-30, PO 확認): 「안전하다」도 「샌다」도 아니다 —
    **이 lint가 «모른다»**다. 오탐 방지가 확실성보다 우선이라 의도적으로 미검사한 것이지,
    안전을 확인해서 봐준 게 아니다. ⛔SKIPPED 4건이 실제로 새는지 알고 싶으면 이 lint가
    아니라 **직접 호출해 보면 된다** — story #2335 조사에서 12건(gates.py 3종·docs.py
    project_id/q·visual_artifacts.py story_id·workflow_executions.py member_id 등)을
    바로 그렇게(disposable PG로 직접 호출) 쟀다.
  ④41건(story #2335 전수 스윕) 자체가 «하한»이었다 — 함수명 충돌(`list_docs`가 라우터에도
    MCP 툴에도 있는 사례)로 grep이 실제로 놓친 적이 있다. 이 lint는 import 문으로 정확한
    모듈 출처를 추적해 그 충돌은 막지만, «아직 파악 못 한 다른 종류의 충돌»이 있을 가능성은
    남는다.
「이제 다 잡는다」로 읽으면 그것이 네 번째 사고다.
"""
from __future__ import annotations

import ast
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROUTERS_DIR = "app/routers"
TESTS_DIR = "tests"


@dataclass
class RouterFunctionInfo:
    module: str  # "app.routers.stories" 형태(점 표기, import 문 대조용)
    name: str
    query_params: set[str] = field(default_factory=set)
    param_order: list[str] = field(default_factory=list)  # 위치인자 매핑용


def _is_query_call(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "Query"
    )


def find_router_functions(source: str, module: str) -> list[RouterFunctionInfo]:
    """모듈 소스에서 `Query(...)` 기본값을 가진 파라미터를 하나 이상 선언한
    (async) 함수를 전부 뽑는다."""
    tree = ast.parse(source)
    results: list[RouterFunctionInfo] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        args = node.args
        # ast: posonlyargs + args가 defaults와 뒤에서부터 정렬, kwonlyargs는 kw_defaults와 병렬.
        all_positional = list(args.posonlyargs) + list(args.args)
        defaults = list(args.defaults)
        pad = len(all_positional) - len(defaults)
        query_params: set[str] = set()
        param_order = [a.arg for a in all_positional] + [a.arg for a in args.kwonlyargs]
        for i, a in enumerate(all_positional):
            if i < pad:
                continue
            default = defaults[i - pad]
            if _is_query_call(default):
                query_params.add(a.arg)
        for a, default in zip(args.kwonlyargs, args.kw_defaults):
            if default is not None and _is_query_call(default):
                query_params.add(a.arg)
        if query_params:
            results.append(RouterFunctionInfo(
                module=module, name=node.name, query_params=query_params, param_order=param_order,
            ))
    return results


def _module_name_for(routers_root: Path, file_path: Path) -> str:
    rel = file_path.relative_to(routers_root.parent.parent)  # backend/ 기준
    return ".".join(rel.with_suffix("").parts)


def collect_router_functions(backend_root: Path) -> dict[str, dict[str, RouterFunctionInfo]]:
    """{module: {func_name: RouterFunctionInfo}}"""
    out: dict[str, dict[str, RouterFunctionInfo]] = {}
    routers_root = backend_root / ROUTERS_DIR
    for f in sorted(routers_root.glob("*.py")):
        module = _module_name_for(routers_root, f)
        source = f.read_text(encoding="utf-8")
        try:
            funcs = find_router_functions(source, module)
        except SyntaxError:
            continue
        if funcs:
            out[module] = {fi.name: fi for fi in funcs}
    return out


@dataclass
class Violation:
    file: str
    line: int
    func_name: str
    missing: set[str]


@dataclass
class ScanResult:
    violations: list[Violation]
    skipped: list[str]  # 추적불가로 건너뛴 자리 설명(파일:줄)


def _resolve_dict_literal_keys(
    func_body: list[ast.stmt], var_name: str, call_lineno: int,
) -> set[str] | None:
    """`var_name = dict(k=v, ...)` (선택: 그 뒤 `var_name.update(dict(...))` 1회까지) 를
    같은 함수 body 안에서, call_lineno 이전 라인 중 «가장 가까운» 대입부터 추적한다.
    못 찾으면 None(추적불가 — 호출부는 SKIPPED 처리)."""
    keys: set[str] | None = None
    for stmt in ast.walk(ast.Module(body=func_body, type_ignores=[])):
        if getattr(stmt, "lineno", 10**9) >= call_lineno:
            continue
        if (
            isinstance(stmt, ast.Assign)
            and len(stmt.targets) == 1
            and isinstance(stmt.targets[0], ast.Name)
            and stmt.targets[0].id == var_name
        ):
            val = stmt.value
            if isinstance(val, ast.Call) and isinstance(val.func, ast.Name) and val.func.id == "dict":
                keys = {kw.arg for kw in val.keywords if kw.arg is not None}
            elif isinstance(val, ast.Dict):
                keys = {
                    k.value for k in val.keys
                    if isinstance(k, ast.Constant) and isinstance(k.value, str)
                }
        elif (
            keys is not None
            and isinstance(stmt, ast.Expr)
            and isinstance(stmt.value, ast.Call)
            and isinstance(stmt.value.func, ast.Attribute)
            and stmt.value.func.attr == "update"
            and isinstance(stmt.value.func.value, ast.Name)
            and stmt.value.func.value.id == var_name
        ):
            arg = stmt.value.args[0] if stmt.value.args else None
            if isinstance(arg, ast.Call) and isinstance(arg.func, ast.Name) and arg.func.id == "dict":
                keys |= {kw.arg for kw in arg.keywords if kw.arg is not None}
            elif isinstance(arg, ast.Dict):
                keys |= {
                    k.value for k in arg.keys
                    if isinstance(k, ast.Constant) and isinstance(k.value, str)
                }
            else:
                return None  # update()에 리터럴 아닌 것 — 추적불가
    return keys


def _imports_from_routers(tree: ast.Module) -> dict[str, tuple[str, str]]:
    """`from app.routers.stories import list_stories as ls` → {"ls": ("app.routers.stories", "list_stories")}.
    함수명 충돌(story #2335 배경 — list_docs가 라우터/MCP 툴 둘 다에 있던 사례) 방지를 위해
    import 출처 모듈을 명시로 추적한다(bare 이름 매치 금지)."""
    out: dict[str, tuple[str, str]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("app.routers"):
            for alias in node.names:
                local = alias.asname or alias.name
                out[local] = (node.module, alias.name)
    return out


def _build_parent_map(tree: ast.Module) -> dict[ast.AST, ast.AST]:
    parents: dict[ast.AST, ast.AST] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parents[child] = parent
    return parents


def _enclosing_function_body(node: ast.AST, parents: dict[ast.AST, ast.AST]) -> list[ast.stmt] | None:
    """call node가 속한 가장 가까운 (async) 함수의 body를 반환한다 — dict 변수 추적을
    «그 함수 안»으로만 한정하기 위함(다른 함수의 동명 변수와 섞이지 않게)."""
    cur = parents.get(node)
    while cur is not None:
        if isinstance(cur, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return cur.body
        cur = parents.get(cur)
    return None


def scan_test_file(
    source: str, file_label: str, router_functions: dict[str, dict[str, RouterFunctionInfo]],
) -> ScanResult:
    tree = ast.parse(source)
    imports = _imports_from_routers(tree)
    violations: list[Violation] = []
    skipped: list[str] = []
    parents = _build_parent_map(tree)

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
            continue
        local_name = node.func.id
        if local_name not in imports:
            continue
        module, orig_name = imports[local_name]
        info = router_functions.get(module, {}).get(orig_name)
        if info is None:
            continue

        explicit: set[str] = {kw.arg for kw in node.keywords if kw.arg is not None}
        has_dyn_kwargs = any(kw.arg is None for kw in node.keywords)  # **something
        # 위치인자 매핑(드묾 — 대부분 kwargs 스타일이나 방어적으로 처리).
        for i, _ in enumerate(node.args):
            if i < len(info.param_order):
                explicit.add(info.param_order[i])

        if has_dyn_kwargs:
            splat_name = None
            for kw in node.keywords:
                if kw.arg is None and isinstance(kw.value, ast.Name):
                    splat_name = kw.value.id
                    break
            if splat_name is None:
                skipped.append(f"{file_label}:{node.lineno} ({orig_name}) — **동적표현식 splat, 추적불가")
                continue
            owning_body = _enclosing_function_body(node, parents)
            resolved = _resolve_dict_literal_keys(owning_body or [], splat_name, node.lineno) if owning_body else None
            if resolved is None:
                skipped.append(f"{file_label}:{node.lineno} ({orig_name}) — **{splat_name} 출처 추적불가")
                continue
            explicit |= resolved

        missing = info.query_params - explicit
        if missing:
            violations.append(Violation(file=file_label, line=node.lineno, func_name=orig_name, missing=missing))

    return ScanResult(violations=violations, skipped=skipped)


def scan_repo(backend_root: Path) -> ScanResult:
    router_functions = collect_router_functions(backend_root)
    all_violations: list[Violation] = []
    all_skipped: list[str] = []
    tests_root = backend_root / TESTS_DIR
    for f in sorted(tests_root.rglob("*.py")):
        source = f.read_text(encoding="utf-8")
        try:
            result = scan_test_file(source, str(f.relative_to(backend_root)), router_functions)
        except SyntaxError:
            continue
        all_violations.extend(result.violations)
        all_skipped.extend(result.skipped)
    return ScanResult(violations=all_violations, skipped=all_skipped)


BASELINE_FILE = "scripts/query_sentinel_baseline.txt"


def violation_key(v: Violation) -> str:
    """(파일, 함수, 정렬된 누락파라미터집합) — 라인번호는 무관한 편집으로 흔들리므로 키에서
    제외한다(story #2335 AC6 grandfather 계약: 베이스라인은 "이 자리가 이 파라미터들을 안
    넘긴다"는 사실을 추적하지, 정확한 줄 위치를 추적하지 않는다)."""
    return f"{v.file}::{v.func_name}::{','.join(sorted(v.missing))}"


def load_baseline(path: Path) -> set[str]:
    if not path.exists():
        return set()
    return {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")}


def write_baseline(path: Path, keys: set[str]) -> None:
    header = (
        "# story #2335 grandfather 베이스라인 — 2026-07-30 lint 첫 도입 시점 develop의 기존 위반\n"
        "# AC6 판정: 조용히 틀리는 것 0건(전부 크래시)이라 개별 수리는 이 판이 아니다 — 그래서\n"
        "# 여기 있는 항목은 실패시키지 않는다. 새 위반(여기 없는 것)만 CI를 빨갛게 한다.\n"
        "# 형식: 파일::함수::정렬된누락파라미터(콤마구분) — 라인번호는 고의로 안 담는다(편집마다 흔들림).\n"
    )
    path.write_text(header + "\n".join(sorted(keys)) + "\n", encoding="utf-8")


def main() -> int:
    backend_root = Path(__file__).resolve().parent.parent
    result = scan_repo(backend_root)
    baseline = load_baseline(backend_root / BASELINE_FILE)

    new_violations = [v for v in result.violations if violation_key(v) not in baseline]
    grandfathered = [v for v in result.violations if violation_key(v) in baseline]

    print(f"위반 {len(result.violations)}건(베이스라인 기존 {len(grandfathered)}건 + 신규 {len(new_violations)}건) "
          f"· SKIPPED {len(result.skipped)}건(추적불가 — story #2335 AC5, «못 잡는 것»의 크기)")

    if new_violations:
        print("\nFAIL: 베이스라인에 없는 «새» 위반 — 라우터 함수를 직접호출하며 Query(...) 파라미터를 "
              "명시로 안 넘긴 자리(센티널이 새어 들어갈 수 있다):")
        for v in new_violations:
            print(f"  {v.file}:{v.line} {v.func_name}() — 누락: {sorted(v.missing)}")
        return 1

    if grandfathered:
        print(f"\n(참고) 베이스라인 grandfather {len(grandfathered)}건은 실패시키지 않음(AC6 — 41건 개별수리는 이 판이 아니다):")
        for v in grandfathered:
            print(f"  {v.file}:{v.line} {v.func_name}() — 누락: {sorted(v.missing)}")

    if result.skipped:
        print(f"\n못 잡는 것(SKIPPED {len(result.skipped)}건 — story #2335 AC5, 스크립트 docstring 참조):")
        for s in result.skipped:
            print(f"  {s}")

    print("\nOK: 새 위반 0건")
    return 0


if __name__ == "__main__":
    sys.exit(main())
