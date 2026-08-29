"""story #3210 — 발송 경로(Resend→SES 추정, 정확한 홉은 우리 쪽에서 재현 불가)가
리터럴 「=[hex][hex]」를 quoted-printable 이스케이프로 오해석해 그 두 글자를 삼킨다.
실착 확인: 셸 viewport meta의 「width=device-width」 중 「=de」가 「width�vice-width」로
손상(=de → 0xDE 단일바이트), 「initial-scale=1」은 「=1"」이 유효 hex쌍이 아니라 무사.

`send_email()`이 발송 직전 html_body의 모든 「=hex」를 `&#61;`로 엔티티화해 전수 방어한다
— 정적 viewport meta뿐 아니라 향후 동적 콘텐츠(쿠폰 코드·해시 등)에도 같은 클래스가
재발하지 않도록. AC2(«=hex» 포함 본문 표본 1건 무손상)의 단위 pin.
"""
from __future__ import annotations

from app.services.email import _neutralize_qp_hex_collisions, render_email_shell


def test_viewport_meta_de_sequence_neutralized():
    """실착 재현분과 정확히 같은 시퀀스 — width=device-width의 «=de».
    가드는 render_email_shell()이 아니라 send_email() 발송 직전 단일 지점에 있다
    (호출부마다 알아서 피하게 하지 않는다는 설계 — 여기선 그 지점을 직접 호출해 고정)."""
    shell = render_email_shell("<p>본문</p>")
    assert "width=device-width" in shell  # 셸 자체는 원문 그대로(가드 적용 전)
    guarded = _neutralize_qp_hex_collisions(shell)
    assert "width&#61;device-width" in guarded
    assert "width=device-width" not in guarded


def test_non_hex_following_equals_left_untouched():
    """실착에서 무사했던 자리(=1", ="600" 등) — =뒤 2글자가 hex가 아니면 그대로 둔다."""
    result = _neutralize_qp_hex_collisions('initial-scale=1" width="600"')
    assert 'initial-scale=1"' in result
    assert 'width="600"' in result


def test_dynamic_content_hex_looking_sequence_neutralized_and_recoverable():
    """AC2 양성대조 — 쿠폰 코드/해시류 동적 콘텐츠에 우연히 «=AB» 모양이 섞여도
    엔티티화되고, HTML 엔티티 디코딩(브라우저 렌더 단계)으로 원문이 그대로 복원된다."""
    import html as html_module

    content = "<p>쿠폰 코드: SAVE=de20</p>"
    result = _neutralize_qp_hex_collisions(content)
    assert "SAVE&#61;de20" in result
    assert "SAVE=de20" not in result
    assert html_module.unescape(result) == content


def test_structural_attribute_equals_never_matched():
    """구조적 `=`(속성 대입)는 항상 따옴표가 뒤따라 hex와 매치되지 않는다 — 가드를 셸
    전체(실 발송 페이로드)에 적용해도 HTML 파싱을 깨뜨리지 않음을 확認."""
    guarded = _neutralize_qp_hex_collisions(render_email_shell("<p>본문</p>"))
    assert 'name="viewport"' in guarded
    assert 'charset="utf-8"' in guarded
    assert 'lang="ko"' in guarded


def test_href_query_value_hex_sequence_neutralized_and_link_still_resolves_after_decode():
    """href 속성값 안의 =hex도 동일 보호 — 엔티티 디코딩 후 URL 자체는 원문 그대로라
    링크 기능에 영향이 없다."""
    import html as html_module

    href = '<a href="https://x.example/verify?token=ab12cd">go</a>'
    result = _neutralize_qp_hex_collisions(href)
    assert "token&#61;ab12cd" in result
    assert html_module.unescape(result) == href


def test_send_email_actually_applies_guard_before_dispatch(monkeypatch):
    """단위 helper가 옳아도 send_email()이 실제로 호출 안 하면 무의미 — 배선 자체를 고정.
    resend 발송 함수로 실제 전달되는 html_body가 가드 통과분인지 직접 확認."""
    from app import services

    captured: dict[str, str] = {}

    def _fake_send_via_resend(*, to, subject, html_body, api_key):
        captured["html_body"] = html_body

    monkeypatch.setenv("RESEND_API_KEY", "fake-key-for-test")
    monkeypatch.setattr(services.email, "_send_via_resend", _fake_send_via_resend)

    services.email.send_email("to@example.com", "제목", "<p>width=device-width</p>")

    assert "width&#61;device-width" in captured["html_body"]
    assert "width=device-width" not in captured["html_body"]
