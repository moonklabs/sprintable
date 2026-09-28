"""story #4352 AC3 — 가드: 초안 버전을 새로 쓰는 라우트는 전부 한 매핑(`DRAFT_VERSION_VALIDATION_ERRORS`)을 거친다.

`create_channel_post_draft_version`은 연결 · 글자 수 · YouTube 메타데이터 · 이어쓰기 검사 예외를 던진다. 예전엔 저장 라우트만 일부를 잡고
이어쓰기 셋은 아무 데서도 안 잡아 코드 없는 500이었다(3808부터). 이미지/영상 확정 · 삭제 · 순서 바꿈도 같은 함수를 거쳐 새 버전을
쓰므로(지금 어댑터 선언 아래서는 이미 통과한 값을 이어 써 도달 0이지만, 조각 한도 · 스레드 지원이 바뀌는 날 같은 500) 같은 매핑이다.

규칙(AST): 서비스에서 `create_channel_post_draft_version`에 **닿는** 함수(전이 수집 — writer를 부르는 함수를 부르는 함수 …, 까디르 P2:
한 겹만 모으면 가져오기 → 확정 → writer 같은 도우미 사슬을 놓쳤다)를 부르는 라우트 핸들러는 매핑을 거쳐야 한다: 자기 안에
`except DRAFT_VERSION_VALIDATION_ERRORS`가 있거나, 그 except를 가진 같은 모듈 도우미(`_confirm_image_upload_or_raise` 등)를 부른다.
대조: 가져오기 라우트가 표에 들어오고 · 지금 그런 라우트가 여섯 이상이다(스캐너가 헛돌지 않음).
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


def _reaching_writers(functions: dict[str, set[str]]) -> set[str]:
    """이름 → 그 함수가 부르는 이름들. writer에 (몇 겹을 거쳐서든) 닿는 함수 이름 전부(고정점)."""
    names = {_WRITER}
    changed = True
    while changed:
        changed = False
        for name, calls in functions.items():
            if name not in names and calls & names:
                names.add(name)
                changed = True
    return names


def _service_writers() -> set[str]:
    functions: dict[str, set[str]] = {}
    for path in (_BACKEND / "app" / "services").glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                functions.setdefault(node.name, set()).update(_called_names(node))
    return _reaching_writers(functions)


def _catches_shared_mapping(fn: ast.AST) -> bool:
    for handler in ast.walk(fn):
        if isinstance(handler, ast.ExceptHandler) and isinstance(handler.type, ast.Name) and handler.type.id == "DRAFT_VERSION_VALIDATION_ERRORS":
            return True
    return False


def _routes_writing_draft_versions(source: str, writers: set[str]) -> dict[str, bool]:
    top = [n for n in ast.parse(source).body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    mapping_helpers = {n.name for n in top if _catches_shared_mapping(n)}
    out: dict[str, bool] = {}
    for node in top:
        calls = _called_names(node)
        if calls & writers:
            if any(isinstance(d, ast.Call) and getattr(d.func, "attr", None) in {"get", "post", "put", "patch", "delete"} for d in node.decorator_list):
                out[node.name] = _catches_shared_mapping(node) or bool(calls & mapping_helpers)
    return out


def test_every_route_that_writes_a_draft_version_goes_through_the_shared_mapping():
    writers = _service_writers()
    found: dict[str, bool] = {}
    for path in (_BACKEND / "app" / "routers").glob("*.py"):
        for name, ok in _routes_writing_draft_versions(path.read_text(), writers).items():
            found[f"{path.name}::{name}"] = ok
    missing = sorted(k for k, ok in found.items() if not ok)
    assert not missing, f"초안 버전을 쓰는데 `except DRAFT_VERSION_VALIDATION_ERRORS`가 없는 라우트: {missing}"
    # 대조 — 스캐너가 실제 라우트를 본다(저장 · 이미지 확정 · 이미지 가져오기 · 이미지 삭제 · 순서 바꿈). story #4336 PR2 — 영상 확정은
    # 작업화돼 라우트가 writer에 닿지 않는다(검사만 하고 작업을 넣음) — writer에 닿는 곳은 워커 처리기라 아래 테스트가 따로 본다.
    assert "channel_posts.py::post_channel_post_image_import" in found, "가져오기 → 확정 → writer(두 겹) 사슬을 못 모은다"
    assert "channel_posts.py::post_channel_post_video_confirm" not in found, "영상 확정 라우트가 다시 writer에 닿는다 — 작업화가 풀렸는지"
    assert len(found) >= 5, found


def _router_mappers_checking_shared_errors() -> set[str]:
    """라우터 모듈의 함수 중 `isinstance(exc, DRAFT_VERSION_VALIDATION_ERRORS)`로 같은 매핑을 거치는 것(워커 처리기가 빌려 쓰는 자리)."""
    out: set[str] = set()
    for path in (_BACKEND / "app" / "routers").glob("*.py"):
        for node in ast.parse(path.read_text()).body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for c in ast.walk(node):
                if (
                    isinstance(c, ast.Call) and getattr(c.func, "id", None) == "isinstance" and len(c.args) == 2
                    and isinstance(c.args[1], ast.Name) and c.args[1].id == "DRAFT_VERSION_VALIDATION_ERRORS"
                ):
                    out.add(node.name)
    return out


def _worker_handlers_unmapped(source: str, writers: set[str], mappers: set[str]) -> dict[str, bool]:
    """워커 처리기(`_run_<종류>`)가 writer에 닿으면 짝 `_<종류>_error_body`가 매핑 함수를 불러야 한다. 이름 → 덮였는지."""
    fns = {n.name: n for n in ast.parse(source).body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    out: dict[str, bool] = {}
    for name, fn in fns.items():
        if not name.startswith("_run_") or not (_called_names(fn) & writers):
            continue
        body_fn = fns.get(f"_{name[len('_run_'):]}_error_body")
        out[name] = body_fn is not None and bool(_called_names(body_fn) & mappers)
    return out


def test_background_job_handlers_that_write_a_draft_version_map_errors_the_same_way():
    """story #4336 PR2 — 작업화된 영상 확정: writer에 닿는 곳이 워커 처리기다. 실패 본문이 라우트와 같은 매핑(`_video_confirm_http_error` →
    `DRAFT_VERSION_VALIDATION_ERRORS`)을 거쳐야 화면이 같은 문장을 고른다."""
    writers = _service_writers()
    mappers = _router_mappers_checking_shared_errors()
    assert "_video_confirm_http_error" in mappers
    handlers = _worker_handlers_unmapped((_BACKEND / "app" / "services" / "background_jobs.py").read_text(), writers, mappers)
    assert handlers.get("_run_channel_video_confirm") is True, handlers
    assert all(handlers.values()), handlers


def test_worker_handler_guard_positive_control():
    writers = {"finish_x"}
    mappers = {"_map"}
    bare = "async def _run_k(db, job):\n    return await finish_x()\ndef _k_error_body(exc, job):\n    return None\n"
    mapped = "async def _run_k(db, job):\n    return await finish_x()\ndef _k_error_body(exc, job):\n    return _map(exc)\n"
    assert _worker_handlers_unmapped(bare, writers, mappers) == {"_run_k": False}
    assert _worker_handlers_unmapped(mapped, writers, mappers) == {"_run_k": True}


def test_guard_positive_control():
    writers = {"confirm_x"}
    bare = '@router.post("/a")\nasync def a():\n    return await confirm_x()\n'
    wrapped = (
        '@router.post("/b")\nasync def b():\n    try:\n        return await confirm_x()\n'
        '    except DRAFT_VERSION_VALIDATION_ERRORS as exc:\n        raise boom(exc)\n'
    )
    assert _routes_writing_draft_versions(bare, writers) == {"a": False}
    assert _routes_writing_draft_versions(wrapped, writers) == {"b": True}
    # 도우미가 매핑을 품으면 그 도우미를 부르는 라우트도 덮인다
    via_helper = (
        'async def _map(c):\n    try:\n        return await c\n    except DRAFT_VERSION_VALIDATION_ERRORS as exc:\n        raise boom(exc)\n'
        '@router.post("/c")\nasync def c():\n    return await _map(confirm_x())\n'
    )
    assert _routes_writing_draft_versions(via_helper, writers) == {"c": True}


def test_writer_collection_is_transitive():
    """까디르 P2 대조 — 두 겹 사슬(import → confirm → writer)도 닿는 함수로 모인다."""
    functions = {"import_x": {"confirm_x", "put"}, "confirm_x": {_WRITER}, "other": {"put"}}
    assert _reaching_writers(functions) == {_WRITER, "confirm_x", "import_x"}
