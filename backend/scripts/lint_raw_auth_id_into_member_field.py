"""story #3370 회귀 원천봉쇄(페드루 PO 지시 2026-09-11) — 「auth.user_id(JWT는 users.id·
API키는 team_member.id 그대로)를 영속 멤버-id 칼럼/kwarg 자리에 원시로 쓰던」 결함 클래스가
#3370 정정 커밋들(583c2bd1c·bcf9bed0c·3e337a938·e2d5b3569)로 10여 곳 고쳐졌다 — 그 클래스가
「고치고 나면 끝」이 아니라 새 코드가 같은 실수를 반복할 수 있는 자리라 CI로 원천봉쇄한다
(verify_no_new_korean_user_strings.py와 동형 AST·정규식 아님 기전, 이유 주석 관례 — 새 기전
발명 금지).

## 잡는 패턴
`*_member_id=`·`resolver_id=`·`actor_id=` kwarg의 값이:
  ①직접 `uuid.UUID(<expr>.user_id)` 호출이거나(`uuid.UUID(...)` 또는 `from uuid import UUID`
    형 `UUID(...)` 둘 다 인식),
  ②같은 함수 안에서 그 호출로 대입된 변수를 그대로 경유(1단계, 예: `raw = uuid.UUID(auth.
    user_id); foo(created_by_member_id=raw)`)
하는 경우 — `resolve_member()`/`resolve_member_db_verified()`가 반환하는 영속 멤버 id
(`resolved.id`)를 거치지 않고 raw auth 클레임을 그대로 영속 필드에 흘려보내는 자리다.

## 스캔 범위
`app/routers`·`app/services`·`ee`(lint_commit_before_validate.py와 동일 3디렉터리 — 같은
층위의 결함 클래스).

## grandfather 베이스라인 없음
2026-09-11 도입 시점(#3370 정정 e2d5b3569 위) 스캔 대상 3디렉터리에 위반 0건 확認(#3370
자신이 발견한 자리를 전부 고친 결과) — lint_commit_before_validate.py(story #2459)와 동일
계약: 처음부터 0건이라 grandfather 관용이 불필요, 위반이 하나라도 있으면 즉시 FAIL한다.

## 인라인 예외(페드루 PO 지시 2026-09-11 — 「칸의 뜻」이 원래 users.id인 자리)
2026-09-11 사후 감사에서 도입 시점 baseline이 실제로는 14건이었다(agent_deployments 5·
agent_personas 2·agent_routing_rules 1·agents 1·billing_keys 1은 칸이 org 멤버 id를
기대해(FK/소비처가 member로 이름 해소) genuine으로 판정돼 이 PR에서 함께 고쳤다 —
dependencies.py 3·agent_sessions.py 1은 칸 자체가 SSE 이벤트 payload/JSON 감사 블롭처럼
"이 값으로 사람 이름을 해소하는 소비처가 없는" 자리라 코드는 그대로 두고, 그 줄에
정확히 `# member-id-lint: user-id-field — <이유>` 트레일링 주석을 달아 이 가드를 지나가게
한다(중앙 allowlist 파일 없음 — 이유가 그 코드 옆에 그대로 붙어야 다음 사람이 맥락 없이
읽을 수 있다). 마커 문자열 자체(`_EXEMPTION_MARKER`)만 찾고 `<이유>` 내용은 검증하지
않는다 — 리뷰가 그 이유의 타당성을 본다.

## 이 lint가 «못 잡는» 것(정직하게 적어둔다 — story #2335/#2459 AC5와 같은 원칙)
  ①간접 호출 — 헬퍼 함수나 classmethod 뒤에 숨어 `uuid.UUID(auth.user_id)`를 계산해 돌려주면
    (`def _raw_actor(auth): return uuid.UUID(auth.user_id)`) 이 함수는 호출부만 보므로 못 잡는다.
  ②2단 이상 변수 경유(`raw = uuid.UUID(auth.user_id); tmp = raw; foo(actor_id=tmp)`) — 1단
    alias까지만 추적한다.
  ③다른 이름의 "member 칸"(예: `assignee_id=`·`owner_member_id=`처럼 목표 kwarg 3종 접미사/
    이름과 다른 이름으로 선언된 영속 멤버-id 필드) — 카드에 명시된 3종(`*_member_id`·
    `resolver_id`·`actor_id`)만 목표로 한다, 새 필드명이 생기면 이 목록에 추가해야 한다.
  ④`.user_id` 말고 다른 속성명으로 같은 raw 값을 얻는 자리(레포 관례상 전부 `auth.user_id`
    이지만, 변수명이 `auth`가 아니어도 속성명 `.user_id`이기만 하면 잡는다 — 반대로 속성명
    자체가 `user_id`가 아니면 못 잡는다).
  ⑤`str(uuid.UUID(auth.user_id))`처럼 한 겹 더 감싼 표현식 — kwarg 값이 정확히 그 Call
    노드이거나 그 Call로 대입된 단순 Name이어야 매치한다.
"""
from __future__ import annotations

import ast
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
SCAN_ROOTS = ["app/routers", "app/services", "ee"]

# story #3370 카드 明示 3종 — 새 필드명이 생기면 여기 추가.
_EXACT_KWARGS = {"resolver_id", "actor_id"}

# story #3370(페드루 PO 지시 2026-09-11) — 칸의 뜻이 애초에 users.id인 자리(사람 이름을
# 해소하는 소비처가 없음)의 인라인 예외. 그 줄(트레일링 주석)에 이 마커+이유가 있으면
# 조용히 넘긴다 — 중앙 allowlist 파일 없음(모듈 docstring 참고).
_EXEMPTION_MARKER = "# member-id-lint: user-id-field"


def _is_target_kwarg(name: str) -> bool:
    return name.endswith("_member_id") or name in _EXACT_KWARGS


def _is_uuid_ctor(func: ast.expr) -> bool:
    if isinstance(func, ast.Attribute):
        return func.attr == "UUID"
    if isinstance(func, ast.Name):
        return func.id == "UUID"
    return False


def _is_user_id_attr(node: ast.expr) -> bool:
    return isinstance(node, ast.Attribute) and node.attr == "user_id"


def _is_tainted_call(node: ast.expr | None) -> bool:
    """`uuid.UUID(<expr>.user_id)`(또는 bare `UUID(...)`) 형 호출인지."""
    return (
        isinstance(node, ast.Call)
        and _is_uuid_ctor(node.func)
        and len(node.args) == 1
        and not node.keywords
        and _is_user_id_attr(node.args[0])
    )


class _Event:
    __slots__ = ("lineno", "kind", "payload")

    def __init__(self, lineno: int, kind: str, payload: str) -> None:
        self.lineno = lineno
        self.kind = kind  # "taint" | "violation_direct" | "check_var"
        self.payload = payload


def scan_function(fn: ast.AST) -> list[tuple[int, str, str]]:
    """(lineno, kwarg, 사유) 목록. lint_commit_before_validate.py(story #2459)와 동일하게
    이벤트를 모아 lineno로 정렬한 뒤 순서대로 재생 — 트리 순회 순서가 아니라 소스 순서로
    "assign이 use보다 먼저" 판정을 안정화한다."""
    events: list[_Event] = []

    class Visitor(ast.NodeVisitor):
        def visit_Assign(self, node: ast.Assign) -> None:
            if _is_tainted_call(node.value):
                for t in node.targets:
                    if isinstance(t, ast.Name):
                        events.append(_Event(node.lineno, "taint", t.id))
            self.generic_visit(node)

        def visit_Call(self, node: ast.Call) -> None:
            for kw in node.keywords:
                if kw.arg is None or not _is_target_kwarg(kw.arg):
                    continue
                if _is_tainted_call(kw.value):
                    events.append(_Event(kw.value.lineno, "violation_direct", kw.arg))
                elif isinstance(kw.value, ast.Name):
                    events.append(_Event(kw.value.lineno, "check_var", f"{kw.arg}::{kw.value.id}"))
            self.generic_visit(node)

    Visitor().visit(fn)
    events.sort(key=lambda e: e.lineno)

    findings: list[tuple[int, str, str]] = []
    tainted_vars: set[str] = set()
    for e in events:
        if e.kind == "taint":
            tainted_vars.add(e.payload)
        elif e.kind == "violation_direct":
            findings.append((e.lineno, e.payload, "직접 uuid.UUID(<expr>.user_id)"))
        elif e.kind == "check_var":
            kwarg, varname = e.payload.split("::", 1)
            if varname in tainted_vars:
                findings.append((e.lineno, kwarg, f"변수 `{varname}` 경유(1단계)"))
    return findings


def _is_exempted_line(line: str) -> bool:
    return _EXEMPTION_MARKER in line


def findings_for_source(source: str) -> list[tuple[int, str, str, str]]:
    """(lineno, func, kwarg, reason) — 파일 경로 없이 소스 문자열만으로 스캔+예외적용까지
    끝내는 축(단위테스트가 실 파일 I/O·BACKEND_ROOT 상대경로 없이 이 마커 로직을 직접
    검증할 수 있게 scan_file에서 분리)."""
    tree = ast.parse(source)
    lines = source.splitlines()
    out: list[tuple[int, str, str, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
            for lineno, kwarg, reason in scan_function(node):
                if 1 <= lineno <= len(lines) and _is_exempted_line(lines[lineno - 1]):
                    continue
                out.append((lineno, node.name, kwarg, reason))
    return out


def scan_file(path: Path) -> list[tuple[str, int, str, str, str]]:
    try:
        source = path.read_text(encoding="utf-8")
        findings = findings_for_source(source)
    except SyntaxError:
        return []
    rel = str(path.relative_to(BACKEND_ROOT))
    return [(rel, lineno, func, kwarg, reason) for lineno, func, kwarg, reason in findings]


def scan_repo() -> list[tuple[str, int, str, str, str]]:
    findings: list[tuple[str, int, str, str, str]] = []
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
            f"FAIL: raw auth.user_id가 영속 멤버-id kwarg에 그대로 흘러든 자리 {len(findings)}건 "
            "발견(story #3370 회귀 클래스):"
        )
        for file, lineno, func, kwarg, reason in findings:
            print(f"  {file}:{lineno} in {func}() — {kwarg}=... ({reason})")
        print(
            "\n고치는 법: resolve_member() 또는 resolve_member_db_verified()(agent 판정을 DB 실측"
            "으로 하는 축이 필요하면)를 먼저 불러 그 결과의 `.id`(영속 멤버 id)를 대신 쓸 것 — "
            "member_resolver.py 기존 호출부 참고. 간접 호출·2단 이상 변수 경유·다른 이름의 "
            "member 칸은 이 lint의 알려진 사각지대(스크립트 docstring 참조) — 새로 짤 때 직접 "
            "주의할 것."
        )
        return 1
    print("OK: raw auth.user_id → 영속 멤버-id kwarg 직접/1단계 대입 0건")
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main())
