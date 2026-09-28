"""story #4264(유나 4632 CHANGES · PO 처방) — 채널 글 어댑터(`publish_channel_post_draft`)를 부르는 모든 자리의 표.

«나갔는지 모름»(needs_check)으로 멈춘 명령에 새 발행 요청이 들어오면 어댑터를 다시 부르지 않는다. 새 요청을 받는 동기 진입점은
어댑터를 부르기 전에 `raise_if_needs_check`를 지나야 하고, 워커만 예외다(pending만 집는다 — needs_check 명령은 dead_letter로
멈추고, 사람의 «확인했어요 · 다시 시도»가 failure_kind를 비운 뒤에야 pending으로 돌아온다).

새 호출처가 생기면 이 표가 RED — 가드를 붙이거나 예외 사유를 적어 표에 올린다.

story #4336 — 즉시 발행 · 레시피 자동 발행은 이제 어댑터를 부르지 않고 명령을 «지금 due»로 대기열에 둔다
(`requeue_for_human_publish`). 어댑터를 부르는 자리는 워커 하나뿐이고, «새 요청이 needs_check 명령을 다시 보내지 않는다»는
약속은 대기열에 넣는 두 진입점이 넣기 **전에** `raise_if_needs_check`를 지나는 것으로 지킨다.
"""
from __future__ import annotations

import ast
import pathlib

_APP = pathlib.Path(__file__).resolve().parents[1] / "app"

# 어댑터(`publish_channel_post_draft`)를 부르는 자리 — 워커 하나(pending만 집는다 · needs_check 명령은 dead_letter로 멈춘다).
ADAPTER_CALLERS = {("services/publication_command.py", "_process_one_command")}
# 새 발행 요청을 대기열에 넣는 진입점 — 넣기 전에 needs_check 가드.
QUEUE_ENTRY_POINTS = {
    ("routers/channel_posts.py", "publish_channel_post_draft_endpoint"),  # 즉시 발행 — 사람 화면 · 사람 세션 API → 409
    ("services/channel_posts.py", "publish_recipe_approved_draft"),  # 레시피 자동 발행 → 게이트 결과 publish_failed:needs_check
}


def _calls(fn: ast.AST, name: str) -> list[int]:
    out = []
    for n in ast.walk(fn):
        if isinstance(n, ast.Call):
            f = n.func
            if (getattr(f, "id", None) or getattr(f, "attr", None)) == name:
                out.append(n.lineno)
    return out


def _callers(name: str) -> dict[tuple[str, str], ast.AST]:
    found = {}
    for path in _APP.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for fn in ast.walk(tree):
            if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) and _calls(fn, name):
                found[(path.relative_to(_APP).as_posix(), fn.name)] = fn
    return found


def test_every_adapter_caller_is_in_the_table():
    """story #4336 — 요청 안에서 어댑터를 부르는 자리가 다시 생기면 RED(즉시 발행 · 승인 전이가 공급자를 기다리던 길)."""
    assert set(_callers("publish_channel_post_draft")) == ADAPTER_CALLERS, "어댑터를 부르는 새 자리 — 워커 밖에서 부르지 않는다"


def test_every_queue_entry_point_checks_needs_check_before_queueing():
    """뮤테이션: 라우터나 레시피 경로에서 `raise_if_needs_check`를 빼거나 대기열 넣기 뒤로 옮기면 RED."""
    callers = _callers("requeue_for_human_publish")
    assert set(callers) == QUEUE_ENTRY_POINTS, "대기열에 넣는 새 자리 — needs_check 가드를 붙이고 표에 올린다"
    for key in QUEUE_ENTRY_POINTS:
        guard_lines = _calls(callers[key], "raise_if_needs_check")
        queue_lines = _calls(callers[key], "requeue_for_human_publish")
        assert guard_lines, f"{key} — 대기열 앞 needs_check 가드 없음"
        assert min(guard_lines) < min(queue_lines), f"{key} — 가드가 대기열 넣기 뒤에 있다"


def test_the_recipe_verdict_line_for_needs_check_sends_to_the_post_screen_not_re_approval():
    """레시피 자동 발행이 needs_check 앞에서 섰을 때 verdict 채팅 문장 — 링크 없는 자리라 «글 화면에서» 긴 형(유나 조건 · PO 23:40Z).
    예전 폴백(unknown_failure)은 «다시 승인»이라 새 명령으로 한 번 더 나갈 수 있었다. 뮤테이션: 사유 표에서 needs_check를 빼면 RED."""
    from app.routers.events import _recipe_auto_publish_outcome_line
    from app.services.i18n_catalog import t

    for locale in ("ko", "en"):
        line = _recipe_auto_publish_outcome_line("publish_failed:needs_check", locale)
        assert t("events.gate_verdict_recipe_auto_publish_reason_needs_check", locale) in line
        assert t("events.gate_verdict_recipe_auto_publish_reason_unknown_failure", locale) not in line
