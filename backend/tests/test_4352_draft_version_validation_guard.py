"""story #4352 AC3 — 가드: 초안 버전을 새로 쓰는 라우트는 전부 한 매핑(`DRAFT_VERSION_VALIDATION_ERRORS`)을 거친다.

`create_channel_post_draft_version`은 연결 · 글자 수 · YouTube 메타데이터 · 이어쓰기 검사 예외를 던진다. 예전엔 저장 라우트만 일부를 잡고
이어쓰기 셋은 아무 데서도 안 잡아 코드 없는 500이었다(3808부터). 이미지/영상 확정 · 삭제 · 순서 바꿈도 같은 함수를 거쳐 새 버전을
쓰므로(지금 어댑터 선언 아래서는 이미 통과한 값을 이어 써 도달 0이지만, 조각 한도 · 스레드 지원이 바뀌는 날 같은 500) 같은 매핑이다.

규칙(AST): 서비스에서 `create_channel_post_draft_version`을 부르는 함수(자동 수집) 또는 그 함수 자체를 부르는 라우트 핸들러는
`except DRAFT_VERSION_VALIDATION_ERRORS`를 가져야 한다. 대조: 지금 그런 라우트가 다섯이다(스캐너가 헛돌지 않음).
"""
from __future__ import annotations

import ast
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
_WRITER = "create_channel_post_draft_version"


def _called_names(node: ast.AST) -> set[str]:
    out: set[str] = set()
    for c in ast.walk(node):
        if isinstance(c, ast.Call):
            name = getattr(c.func, "id", None) or getattr(c.func, "attr", None)
            if name:
                out.add(name)
    return out


def _service_writers() -> set[str]:
    names = {_WRITER}
    for path in (_BACKEND / "app" / "services").glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name != _WRITER and _WRITER in _called_names(node):
                names.add(node.name)
    return names


def _catches_shared_mapping(fn: ast.AST) -> bool:
    for handler in ast.walk(fn):
        if isinstance(handler, ast.ExceptHandler) and isinstance(handler.type, ast.Name) and handler.type.id == "DRAFT_VERSION_VALIDATION_ERRORS":
            return True
    return False


def _routes_writing_draft_versions(source: str, writers: set[str]) -> dict[str, bool]:
    out: dict[str, bool] = {}
    for node in ast.parse(source).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and _called_names(node) & writers:
            if any(isinstance(d, ast.Call) and getattr(d.func, "attr", None) in {"get", "post", "put", "patch", "delete"} for d in node.decorator_list):
                out[node.name] = _catches_shared_mapping(node)
    return out


def test_every_route_that_writes_a_draft_version_goes_through_the_shared_mapping():
    writers = _service_writers()
    found: dict[str, bool] = {}
    for path in (_BACKEND / "app" / "routers").glob("*.py"):
        for name, ok in _routes_writing_draft_versions(path.read_text(), writers).items():
            found[f"{path.name}::{name}"] = ok
    missing = sorted(k for k, ok in found.items() if not ok)
    assert not missing, f"초안 버전을 쓰는데 `except DRAFT_VERSION_VALIDATION_ERRORS`가 없는 라우트: {missing}"
    # 대조 — 스캐너가 실제 라우트를 본다(저장 · 영상 확정 · 이미지 확정 · 이미지 삭제 · 순서 바꿈).
    assert len(found) >= 5, found


def test_guard_positive_control():
    writers = {"confirm_x"}
    bare = '@router.post("/a")\nasync def a():\n    return await confirm_x()\n'
    wrapped = (
        '@router.post("/b")\nasync def b():\n    try:\n        return await confirm_x()\n'
        '    except DRAFT_VERSION_VALIDATION_ERRORS as exc:\n        raise boom(exc)\n'
    )
    assert _routes_writing_draft_versions(bare, writers) == {"a": False}
    assert _routes_writing_draft_versions(wrapped, writers) == {"b": True}
