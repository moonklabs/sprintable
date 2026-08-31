"""story #3205 — email_copy.py 사전 형태 pin. DB 불요(순수 dict)."""
from __future__ import annotations

from app.services.email_copy import (
    AU_WARN_COPY,
    INVITE_COPY,
    REMINDER_COPY,
    STORAGE_WARN_COPY,
    TRANSACTIONAL_COPY,
    resolve_urgent_contact_note,
)
from app.core.config import settings

_LOCALES = ("ko", "en")


def test_transactional_copy_has_both_locales_and_required_fields():
    for kind in ("verify_email", "reset_password"):
        for locale in _LOCALES:
            copy = TRANSACTIONAL_COPY[kind][locale]
            assert copy["subject"]
            assert copy["intro_lines"] and isinstance(copy["intro_lines"], list)
            assert copy["cta_label"]
            assert copy["expiry_note"]
            assert copy["security_note"]
            assert copy["fallback_label"]


def test_reminder_copy_has_both_locales():
    for locale in _LOCALES:
        copy = REMINDER_COPY[locale]
        assert copy["subject"] and copy["intro"] and copy["cta_label"] and copy["unsub_label"]


def test_invite_copy_formats_without_error_both_locales():
    for locale in _LOCALES:
        copy = INVITE_COPY[locale]
        subject = copy["subject"].format(org_name="Acme")
        body = copy["body"].format(inviter_name="Jay", org_name="Acme", role="admin", role_display="an admin")
        assert "Acme" in subject
        assert "Jay" in body and "admin" in body
        # story #3206 — 연도/회사정보 footer는 render_email_shell이 전담(중복 제거),
        # 이 필드는 "왜 이 메일을 받았는지"만 남는다.
        assert copy["auto_generated_note"]


def test_storage_warn_copy_formats_without_error_both_locales():
    for locale in _LOCALES:
        copy = STORAGE_WARN_COPY[locale]
        subject = copy["subject"].format(pct=82.3)
        body = copy["body"].format(pct=82.3, used_mb=800, cap_mb=1000)
        assert "82.3" in subject
        assert "800" in body and "1000" in body


def test_au_warn_copy_formats_without_error_both_locales():
    for locale in _LOCALES:
        copy = AU_WARN_COPY[locale]
        subject = copy["subject"].format(pct=91.0)
        body = copy["body"].format(pct=91.0, current=910, au_limit=1000)
        assert "91.0" in subject
        assert "910" in body and "1000" in body


def test_ko_transactional_copy_unchanged_from_pre_3205_wording():
    """무회귀 — #3196-⑤에서 확定된 ko 문구가 그대로인지(문자열 리터럴 그대로 이전)."""
    verify = TRANSACTIONAL_COPY["verify_email"]["ko"]
    assert verify["subject"] == "Sprintable 이메일 인증을 완료해 주세요"
    assert verify["cta_label"] == "이메일 인증하기"
    reset = TRANSACTIONAL_COPY["reset_password"]["ko"]
    assert reset["subject"] == "Sprintable 비밀번호 재설정 안내"
    reminder = REMINDER_COPY["ko"]
    assert reminder["subject"] == "Sprintable — 가입 완료까지 몇 단계 남았습니다"
    invite = INVITE_COPY["ko"]
    assert invite["heading"] == "팀에 초대됐어요!"


# story #3263(지원v1·5에스컬레이션) — payment_receipt/subscription_downgrade_reserved/
# subscription_cancel_reserved 3종의 옛 security_note("즉시 고객센터로 문의해 주세요")는
# 실재하지 않는 표면(고객센터)을 가리키는 fiction이었다(발단 story #3214). 이 3종은 이제
# TRANSACTIONAL_COPY에 정적 security_note가 없다(resolve_urgent_contact_note로 env-분기
# 해소) — AC3 검산은 "옛 값의 부재"다: 두 모드 어느 쪽으로도 "고객센터" 문자열이 절대
# 나오면 안 된다.
_ESCALATION_TEMPLATES = ("payment_receipt", "subscription_downgrade_reserved", "subscription_cancel_reserved")


def test_transactional_copy_no_longer_has_static_security_note_for_urgent_contact_templates():
    """3종은 정적 security_note가 없다(resolve_urgent_contact_note로만 해소) — 다른 소비부가
    실수로 copy["security_note"]를 다시 읽으면 KeyError로 즉시 드러난다(조용한 stale fallback
    금지)."""
    for kind in _ESCALATION_TEMPLATES:
        for locale in _LOCALES:
            assert "security_note" not in TRANSACTIONAL_COPY[kind][locale]


def test_resolve_urgent_contact_note_widget_off_removes_the_directive_not_just_the_destination(monkeypatch):
    """페드루 PO 확定(2026-08-31) — false(기본값·prod 현재값)면 이행처를 지어내지 않고
    지시문 자체를 지운다. "고객센터"·"위젯"·"지원 채팅" 어느 것도 언급하지 않고, 발신
    전용이라는 사실만 고지한다."""
    monkeypatch.setattr(settings, "support_contact_surface_widget", False)
    for kind in _ESCALATION_TEMPLATES:
        for locale in _LOCALES:
            note = resolve_urgent_contact_note(kind, locale)
            assert note
            assert "고객센터" not in note and "support" not in note.lower()
            assert "위젯" not in note and "widget" not in note.lower()


def test_resolve_urgent_contact_note_widget_on_points_to_the_real_surface(monkeypatch):
    """true(dev 현재값·prod는 위젯 승격 시 같은 커밋으로 함께 true)면 실재하는 지원 위젯을
    가리킨다 — 옛 "고객센터" 값은 여전히 어디에도 없다."""
    monkeypatch.setattr(settings, "support_contact_surface_widget", True)
    for kind in _ESCALATION_TEMPLATES:
        for locale in _LOCALES:
            note = resolve_urgent_contact_note(kind, locale)
            assert note
            assert "고객센터" not in note
            if locale == "ko":
                assert "지원" in note and "로그인" in note
            else:
                assert "support" in note.lower() and "log in" in note.lower()


def test_resolve_urgent_contact_note_defaults_to_widget_off_matching_prod_current_value():
    """Settings 기본값(오버라이드 없음)이 곧 prod 현재값과 일치해야 한다 — 위젯 prod 미노출
    상태에서 배포되는 실 코드가 이 함수를 그대로 쓴다."""
    assert settings.support_contact_surface_widget is False
