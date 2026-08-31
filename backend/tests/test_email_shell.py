"""story #3206(유나 v2 시안, 아티팩트 afaeca1f) — render_email_shell() 공용 브랜드 셸 pin.

v2 원칙(실기기 반증 반영, 선생님 갤럭시 Gmail 다크)만 순수 단위테스트로 고정:
색-fill 위계 대신 구분선/굵기, 버튼은 bg+테두리 병용, 로고=텍스트 워드마크,
회사정보는 apps/web/src/lib/legal/business-info.ts와 자구 일치.
"""
from __future__ import annotations

from app.services.email import render_email_shell


def test_wraps_content_with_wordmark_header_and_divider():
    html_body = render_email_shell("<p>본문</p>")
    assert "본문" in html_body
    # 로고=텍스트 워드마크(이미지 아님) — 실기기서 이미지 미표시 확認.
    assert "Sprintable" in html_body
    assert "<img" not in html_body
    # 헤더 구분선(색 fill 헤더 바가 아니라 border-bottom) — v1(색 헤더 바)은 실기기 반증으로 폐기.
    assert "border-bottom:1px solid #ececec" in html_body


def test_footer_matches_business_info_ssot_verbatim():
    """apps/web/src/lib/legal/business-info.ts와 글자 단위 일치 확認(story #2741 SSOT 규율,
    이 파일은 import 못 하는 별도 런타임이라 값을 손으로 맞춰 유지 — 그 파일이 바뀌면
    이 assertion과 email.py 상수 둘 다 같이 갱신해야 한다)."""
    html_body = render_email_shell("<p>본문</p>")
    assert "주식회사 뭉클랩" in html_body
    assert "대표이사 윤도선" in html_body
    assert "488-88-02579" in html_body
    assert "경기도 고양시 일산동구 무궁화로 20-38, 5층 502호" in html_body
    assert "070-8098-5775" in html_body


def test_footer_has_dynamic_year_not_stale_literal():
    import datetime
    html_body = render_email_shell("<p>본문</p>")
    this_year = datetime.datetime.now(datetime.timezone.utc).year
    assert f"© {this_year} Sprintable" in html_body


def test_footer_links_to_real_routes_only_no_invented_help_page():
    """grounding 확認 — apps/web에 /help 라우트가 없다. 시안엔 "도움말" 링크가 있지만
    실제 목적지가 없어 넣지 않는다(추측 URL 금지) — 실존 라우트(이용약관·개인정보처리방침)만."""
    html_body = render_email_shell("<p>본문</p>")
    assert "/terms" in html_body
    assert "/privacy" in html_body
    assert "도움말" not in html_body
    assert "/help" not in html_body


def test_declares_color_scheme_meta_for_dark_mode_aware_clients():
    """PO 리뷰 지적(2026-08-29, doc email-brand-shell-proposal-3206 ④) — 다크 클라이언트가
    팔레트 판단에 쓰는 신호. color-scheme(표준)과 supported-color-schemes(Apple Mail 등
    구현체 페어)를 함께 선언한다."""
    html_body = render_email_shell("<p>x</p>")
    assert '<meta name="color-scheme" content="light dark">' in html_body
    assert '<meta name="supported-color-schemes" content="light dark">' in html_body


def test_locale_sets_html_lang_attribute():
    assert 'lang="ko"' in render_email_shell("<p>x</p>", locale="ko")
    assert 'lang="en"' in render_email_shell("<p>x</p>", locale="en")


def test_no_flexbox_or_grid_for_email_client_compat():
    html_body = render_email_shell("<p>본문</p>")
    assert "display:flex" not in html_body
    assert "display:grid" not in html_body


def test_no_color_fill_header_bar_v1_pattern_stays_gone():
    """v1(색 헤더 바·#6366f1 인디고 배경)이 실기기 반증으로 폐기됐다 — 헤더 <td>에
    background色 채움이 없어야 한다(border-bottom 구분선만)."""
    html_body = render_email_shell("<p>본문</p>")
    header_section = html_body.split("border-bottom:1px solid #ececec")[0]
    assert "background:#6366f1" not in header_section
    assert "background:#3157FF" not in header_section  # 헤더도 색 fill 없음, 워드마크만 색.


def test_render_action_email_button_uses_border_plus_bg_v2_pattern():
    from app.services.email import render_action_email
    html_body = render_action_email(
        intro_lines=["줄"], cta_label="버튼", cta_url="https://x",
        expiry_note="만료", security_note="보안", fallback_label="폴백",
    )
    # v2 — bg 소실(Gmail 다크)돼도 테두리 상자로 여전히 버튼 식별 가능해야 한다.
    assert "border:2px solid #3157FF" in html_body
    assert "background:#3157FF" in html_body
    # 셸을 통과했는지(헤더 워드마크+푸터 회사정보 존재).
    assert "주식회사 뭉클랩" in html_body


def test_fallback_link_word_breaks_long_tokens_no_mobile_overflow():
    """까디르 QA 지적(2026-08-29, PR#3606 qa:changes) — 초대 폴백 링크의
    word-break:break-all이 셸 전환 중 탈락(develop 대조 확定, 모바일 넘침+CTA 실패
    시 복구 경로 기능 영향). 트랜잭셔널 3종 폴백 링크(긴 JWT 토큰 URL, 공백 없음)도
    같은 위험이라 동시에 넣는다 — pin으로 재발 방지."""
    from app.services.email import render_action_email
    from app.services.org_invite_email import _build_invite_html

    action_html = render_action_email(
        intro_lines=["줄"], cta_label="버튼", cta_url="https://x?token=abc",
        expiry_note="만료", security_note="보안", fallback_label="폴백",
    )
    assert "word-break:break-all" in action_html

    invite_html = _build_invite_html(
        org_name="Acme", inviter_name="Jay", accept_link="https://x?token=abc",
        role="admin", locale="ko",
    )
    assert "word-break:break-all" in invite_html
