"""story #3196-⑤(유나 카피·톤 제안 배선) — render_action_email() 공용 렌더러 pin.

트랜잭셔널 메일 3종(가입 인증·인증 재발송·비밀번호 재설정)이 전부 이 함수를 쓴다 — 골격
(인사/맥락→CTA 버튼→만료→폴백 링크→보안 안내)과 escape 정직성만 순수 단위테스트로 고정.
"""
from __future__ import annotations

from app.services.email import render_action_email


def test_renders_all_sections_in_order():
    html_body = render_action_email(
        intro_lines=["첫 줄", "둘째 줄"],
        cta_label="버튼 라벨",
        cta_url="https://app.sprintable.ai/verify-email?token=abc",
        expiry_note="24시간 유효",
        security_note="요청 안 했으면 무시하세요",
    )
    for expected in ("첫 줄", "둘째 줄", "버튼 라벨", "24시간 유효", "요청 안 했으면 무시하세요"):
        assert expected in html_body
    # cta_url이 버튼 href·폴백 링크 href·폴백 링크의 가시 텍스트 3곳에 실린다(버튼이 안
    # 뜨는 클라이언트 대비 — 폴백은 href뿐 아니라 사람이 직접 복사할 수 있게 텍스트로도 보임).
    assert html_body.count("https://app.sprintable.ai/verify-email?token=abc") == 3
    # 순서: intro가 버튼보다 먼저, 버튼이 만료 안내보다 먼저, 만료가 보안 안내보다 먼저.
    idx_intro = html_body.index("첫 줄")
    idx_cta = html_body.index("버튼 라벨")
    idx_expiry = html_body.index("24시간 유효")
    idx_security = html_body.index("요청 안 했으면 무시하세요")
    assert idx_intro < idx_cta < idx_expiry < idx_security


def test_escapes_html_in_user_facing_text_but_not_url():
    """intro_lines/cta_label/expiry_note/security_note는 이 레포 내부 리터럴이지만, 이 함수
    자체가 «신뢰 못 할 입력이 들어와도 마크업 주입이 안 된다»는 계약을 지켜야 한다 — cta_url은
    서버가 만든 토큰 URL이라 escape 대상이 아니다(계약 그대로: URL은 원문 유지)."""
    html_body = render_action_email(
        intro_lines=["<script>alert(1)</script>"],
        cta_label="<b>버튼</b>",
        cta_url="https://app.sprintable.ai/x?token=a&b=1",
        expiry_note="<i>만료</i>",
        security_note="<u>보안</u>",
    )
    assert "<script>" not in html_body
    assert "&lt;script&gt;" in html_body
    assert "<b>버튼</b>" not in html_body
    assert "&lt;b&gt;버튼&lt;/b&gt;" in html_body
    # URL 자체는 그대로(escape로 깨지면 안 됨 — & 등이 %26으로 변형되지 않는다).
    assert "https://app.sprintable.ai/x?token=a&b=1" in html_body


def test_no_flexbox_or_grid_inline_style_for_email_client_compat():
    html_body = render_action_email(
        intro_lines=["줄"], cta_label="라벨", cta_url="https://x", expiry_note="만료", security_note="보안",
    )
    assert "display:flex" not in html_body
    assert "display:grid" not in html_body
