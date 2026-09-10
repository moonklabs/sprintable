"""story #3779(2층, 페드루 PO 處方 2026-09-10 08:05Z) — 1층 baseline(1308건/176파일) 중
«화면에 실제로 닿는» 부분집합을 실측한다. 이 스크립트는 CI에 물리지 않는다(카드 明示: 목록
산출물이지 재발가드가 아니다 — 재발가드는 verify_no_new_korean_user_strings.py가 이미 맡는다).

## 방법 — 휴리스틱 6종(파일/AST 패턴 기반, 페드루 判 기준 그대로)
카드 기준: "응답 본문/message/detail/이메일/챗 커맨드 출력/문서 export처럼 FE나 사람이
«그대로 그리는» 경로". 1308건 각각을 사람이 일일이 판정하는 대신, 구조적으로 식별 가능한
6개 패턴으로 파일/자리를 분류한다(보수적 — 이 6종에 안 걸리면 "닿는다"로 안 센다. 즉 이
숫자는 «최소치»다, 실제 도달 경로가 이 6종 밖에도 있을 수 있다):

  ① `HTTPException(..., detail=<한글 포함 표현식>)` — 그 detail이 HTTP 응답 바디에 그대로
     실린다(FastAPI 기본 동작). verify:no-raw-error-message가 FE 쪽에서 이미 "이런 자리가
     화면에 raw로 닿는다"를 확인한 것과 대칭.
  ② `CommandOutcome(...)` 호출의 인자 — 챗 커맨드 응답(chat_command_catalog.py:186 표본).
  ③ `email_copy.py` 전체 — 파일 자체가 "발송 메일 7종의 locale별 카피 사전"(파일 자체
     docstring, 2026-08-29 story #3205). 이메일 본문은 정의상 사람이 읽는 문장이라
     파일 전체를 닿는 것으로 센다(per-string이 아니라 file-level 예외 — 유일 사례).
  ④ dict/키워드 인자 값 중 키 이름이 HUMAN_FIELD_NAMES(message/detail/description/
     summary/reason/subject/body/text/title/label/prompt/content)에 속하는 자리 — 응답
     스키마·알림 payload에 흔히 쓰이는 사람이 읽는 필드 이름 관례.
  ⑤ **커스텀 예외 `__init__`의 `super().__init__(...)` 인자**(channel_posts.py:72
     표본 — `ChannelConnectionNotActiveError(ValueError)`) — ①만으로는 못 잡는다: 이
     레포는 라우터에서 직접 `HTTPException`을 던지지 않고 도메인 예외를 만들어 던진 뒤
     전역 핸들러(또는 각 라우터의 `except` 절)가 HTTP 응답으로 변환하는 관례가 63건
     실측됐다 — 그 예외 메시지 자체가 최종 응답 문구가 되는 경우가 흔하다.
  ⑥ **Pydantic validator(`@field_validator`/`@validator`/`@model_validator`) 안의
     `raise ValueError(...)`**(gates.py:131-132 표본) — Pydantic이 이 예외를 잡아 422
     응답의 `detail` 배열에 메시지 그대로 싣는다(FastAPI 기본 동작, 라우터 코드 개입 없음).

## 한계(⚠️이 스크립트가 «못 잡는» 것)
  ㉠ Pydantic 모델 인스턴스 생성(`FooResponse(message=...)`)에서 필드명이 HUMAN_FIELD_NAMES
     밖의 이름(예: `outcome_text`, `guidance`)이면 못 잡는다.
  ㉡ 여러 함수를 거쳐 값이 흘러가는 간접 경로(변수에 담겼다가 나중에 response에 실리는
     경우) — 정적으로 값 흐름을 안 쫓는다(AST call-site 패턴 매칭만).
  ㉢ email_copy.py를 제외한 나머지 파일은 file-level이 아니라 string-level 판정이라,
     같은 파일 안에서도 "안 닿는" 나머지 문자열(내부 로그 인접 상수·설정값 등)은 이 수에
     안 들어간다 — 그래서 파일별 합계 ≠ baseline 파일별 전체 건수.
"""
from __future__ import annotations

import ast
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify_no_new_korean_user_strings import (  # noqa: E402
    APP_DIR,
    _docstring_constant_ids,
    _is_hangul,
)

HUMAN_FIELD_NAMES = {
    "message", "detail", "description", "summary", "reason", "subject",
    "body", "text", "title", "label", "prompt", "content",
}
EMAIL_COPY_FILE = "app/services/email_copy.py"


@dataclass
class ReachableHit:
    file: str
    line: int
    text: str
    reason: str  # "http_detail" | "chat_command" | "email_copy" | "response_field"


def _build_parent_map(tree: ast.AST) -> dict[int, ast.AST]:
    parents: dict[int, ast.AST] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parents[id(child)] = parent
    return parents


def _enclosing_call(node: ast.AST, parents: dict[int, ast.AST]) -> ast.Call | None:
    cur = parents.get(id(node))
    while cur is not None:
        if isinstance(cur, ast.Call):
            return cur
        cur = parents.get(id(cur))
    return None


def _call_name(call: ast.Call) -> str | None:
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return None


def _enclosing_dict_key(node: ast.AST, parents: dict[int, ast.AST]) -> str | None:
    """node가 dict literal의 value이면 그 key 이름을(문자열 리터럴 key일 때만) 반환."""
    parent = parents.get(id(node))
    if isinstance(parent, ast.Dict):
        for k, v in zip(parent.keys, parent.values):
            if v is node and isinstance(k, ast.Constant) and isinstance(k.value, str):
                return k.value
    return None


def _enclosing_keyword_name(node: ast.AST, parents: dict[int, ast.AST]) -> str | None:
    """node가 keyword=value(함수 호출 키워드 인자)의 value이면 그 키워드 이름을 반환."""
    parent = parents.get(id(node))
    if isinstance(parent, ast.keyword) and parent.arg is not None:
        return parent.arg
    return None


def _is_super_init_call(call: ast.Call) -> bool:
    """`super().__init__(...)` 형태인지 — 커스텀 예외 클래스의 메시지 생성부(⑤)."""
    return (
        isinstance(call.func, ast.Attribute)
        and call.func.attr == "__init__"
        and isinstance(call.func.value, ast.Call)
        and isinstance(call.func.value.func, ast.Name)
        and call.func.value.func.id == "super"
    )


VALIDATOR_DECORATOR_NAMES = {"field_validator", "validator", "model_validator"}


def _decorator_name(dec: ast.expr) -> str | None:
    if isinstance(dec, ast.Name):
        return dec.id
    if isinstance(dec, ast.Attribute):
        return dec.attr
    if isinstance(dec, ast.Call):
        return _decorator_name(dec.func)
    return None


def _enclosing_function(node: ast.AST, parents: dict[int, ast.AST]) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    cur = parents.get(id(node))
    while cur is not None:
        if isinstance(cur, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return cur
        cur = parents.get(id(cur))
    return None


def _is_inside_raise(node: ast.AST, parents: dict[int, ast.AST]) -> bool:
    """node가 (함수 경계를 넘지 않는 한도 내에서) `raise ...` statement 안에 있는지."""
    cur = parents.get(id(node))
    while cur is not None:
        if isinstance(cur, ast.Raise):
            return True
        if isinstance(cur, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return False
        cur = parents.get(id(cur))
    return False


def scan_reachable(source: str, file_label: str) -> list[ReachableHit]:
    if file_label == EMAIL_COPY_FILE:
        # file-level 예외 — 파일 전체가 이메일 본문 카피 사전.
        tree = ast.parse(source)
        docstring_ids = _docstring_constant_ids(tree)
        hits: list[ReachableHit] = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                continue
            if id(node) in docstring_ids or not _is_hangul(node.value):
                continue
            hits.append(ReachableHit(file=file_label, line=node.lineno, text=node.value.strip(), reason="email_copy"))
        return hits

    tree = ast.parse(source)
    docstring_ids = _docstring_constant_ids(tree)
    parents = _build_parent_map(tree)

    hits: list[ReachableHit] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if id(node) in docstring_ids or not _is_hangul(node.value):
            continue

        text = node.value.strip()
        line = node.lineno

        kw_name = _enclosing_keyword_name(node, parents)
        if kw_name == "detail":
            call = _enclosing_call(node, parents)
            if call is not None and _call_name(call) in {"HTTPException"}:
                hits.append(ReachableHit(file=file_label, line=line, text=text, reason="http_detail"))
                continue

        call = _enclosing_call(node, parents)
        if call is not None and _call_name(call) == "CommandOutcome":
            hits.append(ReachableHit(file=file_label, line=line, text=text, reason="chat_command"))
            continue

        if call is not None and _is_super_init_call(call):
            hits.append(ReachableHit(file=file_label, line=line, text=text, reason="custom_exception"))
            continue

        if _is_inside_raise(node, parents):
            fn = _enclosing_function(node, parents)
            if fn is not None:
                dec_names = {_decorator_name(d) for d in fn.decorator_list}
                if dec_names & VALIDATOR_DECORATOR_NAMES:
                    hits.append(ReachableHit(file=file_label, line=line, text=text, reason="pydantic_validator"))
                    continue

        dict_key = _enclosing_dict_key(node, parents)
        if dict_key in HUMAN_FIELD_NAMES:
            hits.append(ReachableHit(file=file_label, line=line, text=text, reason="response_field"))
            continue
        if kw_name in HUMAN_FIELD_NAMES:
            hits.append(ReachableHit(file=file_label, line=line, text=text, reason="response_field"))
            continue

    return hits


def scan_repo(backend_root: Path) -> list[ReachableHit]:
    app_root = backend_root / APP_DIR
    files = sorted(p for p in app_root.rglob("*.py") if "__pycache__" not in p.parts)
    hits: list[ReachableHit] = []
    for f in files:
        file_label = str(f.relative_to(backend_root))
        source = f.read_text(encoding="utf-8")
        try:
            hits.extend(scan_reachable(source, file_label))
        except SyntaxError:
            continue
    return hits


def main() -> int:
    backend_root = Path(__file__).resolve().parent.parent
    hits = scan_repo(backend_root)

    by_file: dict[str, list[ReachableHit]] = {}
    for h in hits:
        by_file.setdefault(h.file, []).append(h)

    by_reason: dict[str, int] = {}
    for h in hits:
        by_reason[h.reason] = by_reason.get(h.reason, 0) + 1

    print(f"[story #3779 2층] 화면 도달 부분집합(휴리스틱 6종, 최소치) — {len(hits)}건 / {len(by_file)}파일")
    print(f"  사유별: {json.dumps(by_reason, ensure_ascii=False)}")
    print()
    for file_label in sorted(by_file):
        file_hits = by_file[file_label]
        print(f"  {file_label}: {len(file_hits)}건")

    return 0


if __name__ == "__main__":
    if "--json" in sys.argv:
        backend_root = Path(__file__).resolve().parent.parent
        hits = scan_repo(backend_root)
        print(json.dumps(
            [{"file": h.file, "line": h.line, "text": h.text, "reason": h.reason} for h in hits],
            ensure_ascii=False, indent=2,
        ))
    else:
        sys.exit(main())
