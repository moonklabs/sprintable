"""story #4182 — 사용자 본문을 잘라 미리보기로 내보내는 서버 자리에서 내부 HTML 주석
(`<!-- linear-comment-id … -->`)이 새지 않는지.

- 공용 함수(text_preview.plain_text_preview·strip_html_comments): 닫힌·안 닫힌·절삭 경계에
  걸친 주석.
- 순수 함수 자리 3곳(_build_message_summary·build_content_snippet·_doc_excerpt): 실제 호출.
- 엔드포인트/훅 안의 인라인 자리 4곳(활동 content_preview·코멘트 알림 body 2곳·게이트 문서
  요약): 소스 pin — 그 식이 공용 함수를 거치는지. 코멘트 알림 body는 실 PG 왕복을
  test_e_canvas_c0_s1_comment_events_realdb.py에서도 잰다.
"""
from __future__ import annotations

from pathlib import Path

from app.services.text_preview import plain_text_preview, strip_html_comments

_APP = Path(__file__).resolve().parents[1] / "app"


def test_closed_comment_removed_text_kept():
    assert plain_text_preview("<!-- linear-comment-id: abc -->\n\n댓글 본문", 80) == "댓글 본문"


def test_unclosed_comment_removed_to_end():
    assert plain_text_preview("본문 앞부분 <!-- linear-comment-id: f4", 80) == "본문 앞부분"


def test_comment_crossing_truncation_boundary_leaves_no_fragment():
    # 주석이 절삭 지점(20자)을 가로지른다 — 제거가 절삭보다 먼저라 조각이 안 남는다.
    raw = "앞" * 10 + "<!-- linear-comment-id: " + "x" * 40 + " -->" + "뒤" * 30
    out = plain_text_preview(raw, 20)
    assert "<!--" not in out and "linear-comment-id" not in out
    assert out == "앞" * 10 + "뒤" * 10 + "…"


def test_multiple_comments_and_whitespace_normalized():
    assert plain_text_preview("<!-- a -->첫 줄\n\n<!-- b -->둘째   줄", 80) == "첫 줄 둘째 줄"


def test_short_text_no_ellipsis_and_empty_input():
    assert plain_text_preview("짧다", 80) == "짧다"
    assert plain_text_preview(None, 80) == ""
    assert plain_text_preview("<!-- only -->", 80) == ""


def test_strip_html_comments_keeps_line_breaks():
    assert strip_html_comments("<!-- x -->첫 줄\n둘째 줄") == "첫 줄\n둘째 줄"


# ── 순수 함수 자리 ──────────────────────────────────────────────────────────────

def test_message_summary_has_no_comment():
    from app.routers.conversations import _build_message_summary

    assert _build_message_summary("<!-- linear-comment-id: abc -->\n답장 내용", "유나", False) == "유나: 답장 내용"


def test_message_summary_attachment_only_after_comment_strip():
    from app.routers.conversations import _build_message_summary

    assert _build_message_summary("<!-- linear-comment-id: abc -->", "유나", True) == "유나: 📎"


def test_backlink_snippet_has_no_comment():
    from app.services.backlinks import build_content_snippet

    assert build_content_snippet("<!-- linear-comment-id: abc -->참조 본문") == "참조 본문"


def test_doc_excerpt_has_no_comment():
    from app.services.doc import _doc_excerpt

    assert _doc_excerpt("<!-- meta -->\n# 제목\n\n본문 **강조**") == "제목 본문 강조"


# ── 인라인 자리 소스 pin ─────────────────────────────────────────────────────────

def _src(rel: str) -> str:
    return (_APP / rel).read_text(encoding="utf-8")


def test_activity_content_preview_uses_plain_text_preview():
    assert '"content_preview": plain_text_preview(msg.content, _SUMMARY_PREVIEW_MAX)' in _src("routers/conversations.py")


def test_story_comment_notification_body_uses_plain_text_preview():
    assert "body=plain_text_preview(content, COMMENT_NOTIFICATION_PREVIEW_MAX)" in _src("routers/stories.py")


def test_artifact_comment_notification_body_uses_plain_text_preview():
    assert "body=plain_text_preview(body.content, COMMENT_NOTIFICATION_PREVIEW_MAX)" in _src("routers/visual_artifacts.py")


def test_recipe_gate_draft_doc_summary_strips_comments():
    assert 'facts["draft_doc_summary"] = strip_html_comments(doc_content)[:300]' in _src("services/recipe_gate_hooks.py")
