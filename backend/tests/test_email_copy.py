"""story #3205 — email_copy.py 사전 형태 pin. DB 불요(순수 dict)."""
from __future__ import annotations

from app.services.email_copy import (
    AU_WARN_COPY,
    INVITE_COPY,
    REMINDER_COPY,
    STORAGE_WARN_COPY,
    TRANSACTIONAL_COPY,
)

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
        footer = copy["footer"].format(year=2026)
        assert "Acme" in subject
        assert "Jay" in body and "admin" in body
        assert "2026" in footer
        assert copy["html_lang"] == locale


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
