"""story #4290 — «다시 시도할 수 있는가»를 읽는 자리는 모두 서버 한 판정(`human_retryable`)을 부른다. 새 자리가 자기 조건을 다시
짜면(예전 화면 `deriveFailureAction`처럼) 버튼과 서버가 다시 갈라진다.

뮤테이션: 아래 자리 중 하나가 `human_retryable` 대신 status 비교를 직접 쓰면 RED.
"""
from __future__ import annotations

import ast
import pathlib

_APP = pathlib.Path(__file__).resolve().parents[1] / "app"

READERS = {
    ("services/publication_command.py", "retry_dead_letter_command"),  # 재시도 엔드포인트가 받는지
    ("routers/channel_posts.py", "_to_draft_list_item"),  # 글 상세 · 목록 command_retryable
    ("routers/channel_post_comments.py", "_comment_reply_summary"),  # 댓글 목록의 답변 요약
    ("routers/channel_post_comment_replies.py", "_reply_view"),  # 답변 단건
}


def _calls_in(path: str, fn_name: str) -> set[str]:
    tree = ast.parse((_APP / path).read_text(encoding="utf-8"))
    fn = next(
        n for n in ast.walk(tree)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == fn_name
    )
    return {
        getattr(n.func, "id", None) or getattr(n.func, "attr", None)
        for n in ast.walk(fn) if isinstance(n, ast.Call)
    }


def test_every_reader_uses_the_one_server_judgement():
    missing = [key for key in READERS if "human_retryable" not in _calls_in(*key)]
    assert not missing, f"«다시 시도 가능» 판정을 human_retryable 없이 읽는 자리: {missing}"


def test_the_judgement_table():
    from types import SimpleNamespace

    from app.services.publication_command import (
        NEWSLETTER_HUMAN_RETRYABLE_BLOCK_CODES,
        human_retryable,
    )

    def cmd(status, content_kind="channel_post", reason_code=None):
        return SimpleNamespace(status=status, content_kind=content_kind, reason_code=reason_code)

    assert human_retryable(cmd("dead_letter")) and human_retryable(cmd("blocked"))
    for status in ("pending", "in_progress", "completed", "voided", "cancelled", "blocked_unapproved"):
        assert not human_retryable(cmd(status)), status
    code = next(iter(NEWSLETTER_HUMAN_RETRYABLE_BLOCK_CODES))
    assert human_retryable(cmd("blocked_unapproved", "newsletter_send", code))
    assert not human_retryable(cmd("blocked_unapproved", "newsletter_send", "SOMETHING_ELSE"))
