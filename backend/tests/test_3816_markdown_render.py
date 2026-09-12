"""story #3816(Phase3·3-6 PR2, 페드루 PO 確定 2026-09-12) — `render_markdown_html`
단위 테스트. Ghost `?source=html`이 HTML 계약이라 마크다운 문법이 실제로 HTML
태그로 바뀌는지가 이 테스트의 전부(라이브러리 위임 — 변환 세부 알고리즘은
검증 대상이 아니다)."""
from __future__ import annotations

from app.services.markdown_render import render_markdown_html


def test_heading_converts_to_h1_tag():
    assert "<h1>제목</h1>" in render_markdown_html("# 제목")


def test_list_converts_to_ul_li_tags():
    html = render_markdown_html("- a\n- b\n")
    assert "<ul>" in html
    assert "<li>a</li>" in html
    assert "<li>b</li>" in html


def test_link_converts_to_a_tag():
    html = render_markdown_html("[클릭](https://example.com)")
    assert '<a href="https://example.com">클릭</a>' in html


def test_image_url_converts_to_img_tag():
    html = render_markdown_html("![대체텍스트](https://example.com/x.png)")
    assert "<img" in html
    assert 'src="https://example.com/x.png"' in html
    assert 'alt="대체텍스트"' in html


def test_fenced_code_block_converts_to_pre_code_tags():
    html = render_markdown_html("```\nprint('hi')\n```")
    assert "<pre>" in html
    assert "<code>" in html
    assert "print(&#39;hi&#39;)" in html or "print('hi')" in html


def test_raw_html_block_passes_through_unchanged():
    """story #3816 — Ghost가 최종 sanitize를 하므로 여기서 별도 escape·필터링 0.
    라이브러리 기본 동작(원본에 이미 있는 HTML 블록은 그대로 통과)만 확認."""
    html = render_markdown_html('<div class="custom">이미 HTML</div>')
    assert '<div class="custom">이미 HTML</div>' in html


def test_empty_input_returns_empty_string():
    assert render_markdown_html("") == ""


def test_mutation_target_plain_text_is_not_wrapped_without_conversion():
    """뮤테이션 대상(스토리 본문 明示) — `render_markdown_html`이 `markdown.markdown()`
    호출을 안 거치고 원문을 그대로 반환하도록 되돌리면, 이 테스트가 반드시
    RED여야 한다(마크다운 문법이 변환 없이 그대로 남기 때문)."""
    html = render_markdown_html("# 제목\n\n- a\n")
    assert "# 제목" not in html
    assert "- a" not in html
