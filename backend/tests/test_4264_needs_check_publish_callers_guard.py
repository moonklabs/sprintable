"""story #4264(유나 4632 CHANGES · PO 처방) — 채널 글 어댑터(`publish_channel_post_draft`)를 부르는 모든 자리의 표.

«나갔는지 모름»(needs_check)으로 멈춘 명령에 새 발행 요청이 들어오면 어댑터를 다시 부르지 않는다. 새 요청을 받는 동기 진입점은
어댑터를 부르기 전에 `raise_if_needs_check`를 지나야 하고, 워커만 예외다(pending만 집는다 — needs_check 명령은 dead_letter로
멈추고, 사람의 «확인했어요 · 다시 시도»가 failure_kind를 비운 뒤에야 pending으로 돌아온다).

새 호출처가 생기면 이 표가 RED — 가드를 붙이거나 예외 사유를 적어 표에 올린다.
"""
from __future__ import annotations

import ast
import pathlib

_APP = pathlib.Path(__file__).resolve().parents[1] / "app"

# (파일, 함수) → 가드 여부. False는 사유가 있는 예외.
ENTRY_POINTS = {
    ("routers/channel_posts.py", "publish_channel_post_draft_endpoint"): True,  # 즉시 발행 — 사람 화면 · MCP 발행 도구 → 409
    ("services/channel_posts.py", "publish_recipe_approved_draft"): True,  # 레시피 자동 발행 → 게이트 결과 publish_failed:needs_check
    ("services/publication_command.py", "_process_one_command"): False,  # 워커 — pending만 집는다
}


def _calls(fn: ast.AST, name: str) -> list[int]:
    out = []
    for n in ast.walk(fn):
        if isinstance(n, ast.Call):
            f = n.func
            if (getattr(f, "id", None) or getattr(f, "attr", None)) == name:
                out.append(n.lineno)
    return out


def _callers() -> dict[tuple[str, str], ast.AST]:
    found = {}
    for path in _APP.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for fn in ast.walk(tree):
            if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) and _calls(fn, "publish_channel_post_draft"):
                found[(path.relative_to(_APP).as_posix(), fn.name)] = fn
    return found


def test_every_adapter_caller_is_in_the_table():
    assert set(_callers()) == set(ENTRY_POINTS), "어댑터를 부르는 새 자리 — 가드를 붙이고 표에 올린다"


def test_every_guarded_entry_point_checks_before_calling_the_adapter():
    """뮤테이션: 라우터나 레시피 경로에서 `raise_if_needs_check`를 빼거나 어댑터 호출 뒤로 옮기면 RED."""
    callers = _callers()
    for key, guarded in ENTRY_POINTS.items():
        guard_lines = _calls(callers[key], "raise_if_needs_check")
        adapter_lines = _calls(callers[key], "publish_channel_post_draft")
        if not guarded:
            assert not guard_lines, f"{key} 표에선 예외인데 가드가 있다 — 표를 고친다"
            continue
        assert guard_lines, f"{key} — 어댑터 앞 needs_check 가드 없음"
        assert min(guard_lines) < min(adapter_lines), f"{key} — 가드가 어댑터 호출 뒤에 있다"


def test_the_recipe_verdict_line_for_needs_check_sends_to_the_post_screen_not_re_approval():
    """레시피 자동 발행이 needs_check 앞에서 섰을 때 verdict 채팅 문장 — 링크 없는 자리라 «글 화면에서» 긴 형(유나 조건 · PO 23:40Z).
    예전 폴백(unknown_failure)은 «다시 승인»이라 새 명령으로 한 번 더 나갈 수 있었다. 뮤테이션: 사유 표에서 needs_check를 빼면 RED."""
    from app.routers.events import _recipe_auto_publish_outcome_line
    from app.services.i18n_catalog import t

    for locale in ("ko", "en"):
        line = _recipe_auto_publish_outcome_line("publish_failed:needs_check", locale)
        assert t("events.gate_verdict_recipe_auto_publish_reason_needs_check", locale) in line
        assert t("events.gate_verdict_recipe_auto_publish_reason_unknown_failure", locale) not in line
