"""story #4255(PO 10:14Z) — 서버가 레시피 stage를 내는 입구 `emit_recipe_published_stage_event`의 호출처 전수 가드.

레시피 게이트를 거친 발행이 그 게이트 id(`trigger_gate_id`) 없이 이벤트를 내면, 마지막 서버 stage의 수신자 해소가 «그 시점 최신
승인 게이트»로 폴백해 같은 작업 항목의 다음 회차와 경합한다(까디르 4617 P1). 호출처는 지금 네 곳이고(채널 워커 · 외부 블로그 워커 ·
뉴스레터 발송 · 자사 블로그 발행) 모두 촉발 게이트를 넘긴다. 새 호출처가 id 없이 생기면 여기서 RED.

story #4336 — 다섯 → 넷: 레시피 승인 전이의 «즉시 채널 발행» 자리가 사라졌다(승인은 대기열에만 넣고, 채널 발행과 그 published
stage 이벤트는 워커 한 곳이 즉시 · 예약 둘 다 낸다).
"""
from __future__ import annotations

import ast
from pathlib import Path

_APP = Path(__file__).resolve().parents[1] / "app"
_EXPECTED_CALLERS = 4


def _calls() -> list[tuple[str, int, set[str]]]:
    found = []
    for path in sorted(_APP.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else None
            if name == "emit_recipe_published_stage_event":
                found.append((str(path.relative_to(_APP.parent)), node.lineno, {kw.arg for kw in node.keywords}))
    return found


def test_every_recipe_stage_emit_caller_passes_the_trigger_gate():
    calls = _calls()
    missing = [f"{path}:{line}" for path, line, keywords in calls if "trigger_gate_id" not in keywords]
    assert missing == [], f"촉발 게이트 id 없이 레시피 stage를 내는 호출처: {missing}"


def test_caller_census_is_pinned():
    """호출처 수가 바뀌면(새 경로 · 삭제) 이 표를 사람이 한 번 본다."""
    assert len(_calls()) == _EXPECTED_CALLERS, _calls()
