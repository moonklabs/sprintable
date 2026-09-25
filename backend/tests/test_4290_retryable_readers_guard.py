"""story #4290 — «다시 시도할 수 있는가»를 읽는 자리는 모두 서버 한 판정(`human_retryable`)을 부른다. 새 자리가 자기 조건을 다시
짜면(예전 화면 `deriveFailureAction`처럼) 버튼과 서버가 다시 갈라진다.

뮤테이션: 아래 자리 중 하나가 `human_retryable` 대신 status 비교를 직접 쓰면 RED.

까디르 QA ③ · ④(PO 06:40Z) — 응답에 싣는 자리는 **보는 사람 기준** 판정(`viewer_can_retry` = 사람 · `human_retryable`)을 부른다
(재시도 엔드포인트가 사람만 받으므로). 성과 보드 행(`insights_board._command_failure_fields`)도 같은 판정.
"""
from __future__ import annotations

import ast
import pathlib

_APP = pathlib.Path(__file__).resolve().parents[1] / "app"

READERS = {
    ("services/publication_command.py", "retry_dead_letter_command"),  # 재시도 엔드포인트가 받는지
    ("services/publication_command.py", "viewer_can_retry"),  # 응답에 싣는 보는 사람 기준 판정
}

# 응답에 command_retryable을 싣는 자리 — 모두 보는 사람 기준 판정(`viewer_can_retry`)을 부른다.
VIEW_READERS = {
    ("routers/channel_posts.py", "_to_draft_list_item"),  # 글 상세 · 목록 command_retryable
    ("routers/channel_posts.py", "publish_channel_post_draft_endpoint"),  # 발행 409(needs_check)의 command_retryable
    ("routers/channel_post_comments.py", "_comment_reply_summary"),  # 댓글 목록의 답변 요약
    ("routers/channel_post_comment_replies.py", "_reply_view"),  # 답변 단건
    ("routers/site_posts.py", "_publication_command_view"),  # 블로그 글 상세(PO 05:01Z · 유나)
    ("routers/gates.py", "get_gate_endpoint"),  # 뉴스레터 발송 게이트의 발송 명령 요약
    ("services/insights_board.py", "_command_failure_fields"),  # 성과 보드 행(까디르 QA ④)
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


def test_every_response_carries_the_viewer_judgement():
    """까디르 QA ③ · ④ — 응답의 command_retryable은 보는 사람 기준(에이전트면 false) · 성과 보드 포함."""
    missing = [key for key in VIEW_READERS if "viewer_can_retry" not in _calls_in(*key)]
    assert not missing, f"command_retryable을 보는 사람 기준 판정 없이 싣는 자리: {missing}"


def test_the_viewer_judgement_is_person_and_command():
    from types import SimpleNamespace

    from app.services.publication_command import viewer_can_retry

    dead = SimpleNamespace(status="dead_letter", content_kind="channel_post", reason_code=None, failure_kind=None)
    pending = SimpleNamespace(status="pending", content_kind="channel_post", reason_code=None, failure_kind=None)
    assert viewer_can_retry(dead, viewer_is_human=True)
    assert not viewer_can_retry(dead, viewer_is_human=False)
    assert not viewer_can_retry(pending, viewer_is_human=True)


def test_the_judgement_table():
    from types import SimpleNamespace

    from app.services.publication_command import (
        NEWSLETTER_HUMAN_RETRYABLE_BLOCK_CODES,
        human_retryable,
    )

    def cmd(status, content_kind="channel_post", reason_code=None, failure_kind=None):
        return SimpleNamespace(status=status, content_kind=content_kind, reason_code=reason_code, failure_kind=failure_kind)

    assert human_retryable(cmd("dead_letter")) and human_retryable(cmd("blocked"))
    # 까디르 QA ① — 조직 일시정지로 멈춘 blocked는 사람 재시도 대상이 아니다(정지를 풀면 서버가 다시 올린다 · 화면도 숨김).
    assert not human_retryable(cmd("blocked", failure_kind="paused"))
    assert human_retryable(cmd("blocked", failure_kind="connection"))
    for status in ("pending", "in_progress", "completed", "voided", "cancelled", "blocked_unapproved"):
        assert not human_retryable(cmd(status)), status
    code = next(iter(NEWSLETTER_HUMAN_RETRYABLE_BLOCK_CODES))
    assert human_retryable(cmd("blocked_unapproved", "newsletter_send", code))
    assert not human_retryable(cmd("blocked_unapproved", "newsletter_send", "SOMETHING_ELSE"))


def test_every_builder_requires_the_viewer():
    """까디르 델타 ②(PO 08:04Z) — 응답을 조립하는 함수는 보는 쪽(`viewer_is_human`)을 **기본값 없는 키워드**로 받는다. 새 호출처가 빠뜨리면
    (예전 캠페인 상세처럼) 조용히 false가 아니라 TypeError로 바로 드러난다. 뮤테이션: 한 곳에 `= False` 기본값을 되살리면 RED."""
    import inspect

    from app.routers.channel_post_comment_replies import _reply_view
    from app.routers.channel_post_comments import _comment_reply_summary
    from app.routers.channel_posts import _to_draft_list_item
    from app.routers.site_posts import _publication_command_view
    from app.services.insights_board import _command_failure_fields, list_insights_board

    loose = []
    for fn in (_to_draft_list_item, _comment_reply_summary, _reply_view, _publication_command_view,
               _command_failure_fields, list_insights_board):
        p = inspect.signature(fn).parameters.get("viewer_is_human")
        if p is None or p.kind is not inspect.Parameter.KEYWORD_ONLY or p.default is not inspect.Parameter.empty:
            loose.append(fn.__name__)
    assert not loose, f"보는 쪽을 필수 키워드로 받지 않는 조립 함수: {loose}"

