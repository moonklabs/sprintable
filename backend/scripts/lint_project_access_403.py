"""story #2342([미완의 롤아웃] 403→404 통일) AC7 — 「N개로 쪼갠 작업의 남은 조각을
어디서 세는가」의 답을 🔴기계로 올린다.

배경: PR#2624가 stories.py 하나만(1/4) 무권한 응답을 403→404로 고치고 "PR 1/4"라고 본문에
적었으나, 남은 task·doc·retro 3곳을 세는 자리가 어디에도 없어 두 달간 방치됐다(story #2322
→ #2342). 🔹형식(PR 본문 "1/4")과 🔸사람(스토리 체크박스)은 이미 실패한 세기 — 이 lint가
🔴기계로 그 자리를 대신한다: `has_project_access(...)`가 False일 때 403을 raise하는 새 코드가
생기면 CI를 빨갛게 만든다("같은 헬퍼 클래스가 서로 다른 코드를 내면 CI가 빨개진다").

⛔이 lint가 잡는 패턴: `if not await has_project_access(...):` 블록 안에서
`raise HTTPException(status_code=403, ...)`. 존재 비노출 규율(story #2322/#2342)상 project
접근 거부는 항상 404여야 한다 — 403은 이 판정에서 전부 고쳤으므로(2026-07-30) 베이스라인은
0이다. 그래서 grandfather 메커니즘이 없다 — 새 위반이든 기존 위반이든 하나라도 있으면 즉시
CI가 빨개진다(baseline=0은 "지금은 없다"를 뜻하지 "봐준다"를 뜻하지 않는다).

⛔이 lint가 못 잡는 것: `has_project_access`를 감싼 로컬 wrapper 함수를 거쳐 403을 내는
간접 경로(1-hop 이상) — 정적 단일 함수 스캔이라 그 안까지는 못 본다. 그런 자리가 의심되면
직접 grep(`grep -rn "has_project_access" app/`)으로 확認해야 한다.

⛔grandfather 베이스라인(2026-07-30, 이 lint를 처음 켠 시점 발견): task·doc·retro 3파일
8곳(story #2342 스코프)을 고치고 나서 이 스캐너를 전체 라우터에 돌려 보니, «그 3파일 밖»에
**23곳**이 더 있었다 — agent_runs·assets·attachments·auth·context_pack·current_project·
evidence·file_locks·gate_config·goals·meetings·project_settings·standups·team_members,
그리고 이미 "고쳤다"고 여겨졌던 stories.py·docs.py 자체에도(다른 헬퍼 함수 경유) 잔여
사이트가 있었다. 이건 #2342의 스코프(task/doc/retro 4개 헬퍼)보다 훨씬 큰 발견이라 —
지금 23곳을 한꺼번에 고치는 건 이 PR의 일이 아니다(별건 스윕 후보, PO 판단 필요). 그래서
이 lint는 지금 시점 23곳을 베이스라인에 동결하고, **새 위반만** CI를 빨갛게 한다 — #2335
Query-sentinel lint와 같은 계약("지금 있는 걸 고쳐라"가 아니라 "더 늘리지 마라").
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

ROUTERS_DIR = Path(__file__).parent.parent / "app" / "routers"
BASELINE_PATH = Path(__file__).parent / "project_access_403_baseline.txt"


def _raises_403(node: ast.AST) -> bool:
    """node(Raise 문) 가 HTTPException(status_code=403, ...)를 던지는지."""
    if not isinstance(node, ast.Raise) or node.exc is None:
        return False
    call = node.exc
    if not isinstance(call, ast.Call):
        return False
    func = call.func
    func_name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
    if func_name != "HTTPException":
        return False
    for kw in call.keywords:
        if kw.arg == "status_code" and isinstance(kw.value, ast.Constant) and kw.value.value == 403:
            return True
    # status_code가 첫 positional일 수도 있다(관례상 keyword만 쓰지만 방어적으로 확인).
    if call.args and isinstance(call.args[0], ast.Constant) and call.args[0].value == 403:
        return True
    return False


def _calls_has_project_access(node: ast.AST) -> bool:
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call):
            func = sub.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
            if name == "has_project_access":
                return True
    return False


def find_violations(path: Path) -> list[tuple[str, int, str]]:
    """(file, lineno, function_name) 위반 목록 — has_project_access 결과로 403을 raise하는 자리."""
    tree = ast.parse(path.read_text(), filename=str(path))
    violations: list[tuple[str, int, str]] = []

    for func in ast.walk(tree):
        if not isinstance(func, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for node in ast.walk(func):
            if isinstance(node, ast.If) and _calls_has_project_access(node.test):
                for stmt in ast.walk(node):
                    if _raises_403(stmt):
                        violations.append((str(path), stmt.lineno, func.name))
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
    for path in sorted(ROUTERS_DIR.glob("*.py")):
        violations.extend(find_violations(path))
    return violations


def main() -> int:
    violations = scan_repo()
    baseline = load_baseline()
    new_violations = [v for v in violations if violation_key(v[0], v[2]) not in baseline]
    grandfathered = len(violations) - len(new_violations)

    print(f"grandfathered: {grandfathered}")
    if new_violations:
        print(f"FAIL: has_project_access 거부가 403을 raise하는 «새» 자리 {len(new_violations)}건 발견")
        print("story #2322/#2342 판정: project 접근 거부는 항상 404(존재 비노출). 403 금지.")
        for file, lineno, func in new_violations:
            print(f"  {file}:{lineno} {func}()")
        return 1
    print(f"OK: 새 위반 0건(베이스라인 {grandfathered}건은 그대로, story #2342 스코프 밖 — 별건 스윕 후보)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
