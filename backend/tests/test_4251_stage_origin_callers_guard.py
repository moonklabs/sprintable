"""story #4251(PO) — 발행 코어의 stage 검증 면제 인자(`stage_origin`)는 **내부 호출만** 넘긴다.

- HTTP 라우트(`publish_registry_event` — 에이전트 MCP `publish_event` · «레시피 시작» · 조직 «테스트 발행»)는 이 인자를 넘기지 않는다
  (기본 `member` = 검사).
- 면제를 넘기는 호출처는 아래 표뿐이다. 새 호출처가 면제를 넘기면 여기서 RED — 사람이 한 번 본다.
"""
from __future__ import annotations

import ast
from pathlib import Path

_APP = Path(__file__).resolve().parents[1] / "app"

# (파일, 함수) → 넘기는 값
_EXEMPT_CALLERS = {
    ("app/routers/events.py", "publish_preset_event"): "server",
    ("app/routers/events.py", "complete_recipe_stage"): "complete_stage",
    ("app/services/channel_posts.py", "_emit_recipe_published_stage_event_locked"): "server",
    ("app/services/recipe_repeat_scheduler.py", "_publish_next_collect_event"): "server",
}


def _core_calls() -> list[tuple[str, str, str | None]]:
    found = []
    for path in sorted(_APP.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for fn in ast.walk(tree):
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for node in ast.walk(fn):
                if not isinstance(node, ast.Call):
                    continue
                name = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", None)
                if name != "_publish_registry_event_core":
                    continue
                origin = next((kw.value for kw in node.keywords if kw.arg == "stage_origin"), None)
                value = origin.value if isinstance(origin, ast.Constant) else (None if origin is None else "<dynamic>")
                found.append((str(path.relative_to(_APP.parent)), fn.name, value))
    return found


def test_the_http_publish_route_never_passes_an_exemption():
    calls = [c for c in _core_calls() if c[1] == "publish_registry_event"]
    assert calls == [("app/routers/events.py", "publish_registry_event", None)], calls


def test_only_the_listed_internal_callers_pass_an_exemption():
    exempting = {(path, fn): value for path, fn, value in _core_calls() if value is not None}
    assert exempting == _EXEMPT_CALLERS
