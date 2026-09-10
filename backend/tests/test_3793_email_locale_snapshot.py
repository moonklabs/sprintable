"""story #3793(email_copy 82건 그라운딩 후속, 페드루 PO 재가 2026-09-10 12:51Z) — #3205가
이미 완성한 7개 메일 템플릿(verify_email·reset_password·set_password_confirm·
payment_receipt·storage_warn·au_warn·reminder)에 en 전용 더미-트랜스포트(실발송 0) 렌더
스냅샷이 없던 갭을 채운다.

"email_copy 82→0"은 3786 EXEMPT_FILES와 동형인 구조적 바닥(2층 스크립트 자기 docstring
패턴③이 파일 전체를 human-read 텍스트로 file-level 세는 설계) — PO 그라운딩 재확認 후
카드 목표에서 이미 걷어냈다. 이 파일의 계약은 그 대신 PO가 재가한 두 가지뿐이다:
① en 렌더 결과에 한글 문자가 0인지, ② 그 단언이 실제로 걸리는(tautological pass가
아닌) 뮤테이션 양성대조.

_is_hangul은 verify_no_new_korean_user_strings.py의 기존 판정을 그대로 재사용한다(새
기전 발명 금지) — 뮤테이션은 en 필드를 대응하는 ko 필드 값으로 스왑하는 방식만 쓴다
(placeholder 이름이 ko/en 간 동일해 .format()이 안 깨지고, 임의로 지어낸 문자열도 아니다).

⚠️스코프 경계(그라운딩 중 발견, 별도 보고 済 — 페드루 PO 판단 대기, 2026-09-10 12:54Z):
`render_email_shell()`의 공용 푸터(회사정보+약관 링크 라벨)는 `locale` 파라미터와 무관하게
항상 한글이다 — email_copy.py 밖(app/services/email.py) 문제라 이 스토리 스코프가 아니다.
`_strip_shell_footer()`로 그 자리를 제외한 content 영역만 zero-korean 단언 대상으로
좁힌다(발견을 감추는 게 아니라 이 슬라이스가 책임질 자리만 정확히 그은 것)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from verify_no_new_korean_user_strings import _is_hangul  # noqa: E402

from app.services.email import render_action_email, render_email_shell
from app.services.email_copy import (
    AU_WARN_COPY,
    REMINDER_COPY,
    STORAGE_WARN_COPY,
    TRANSACTIONAL_COPY,
    resolve_urgent_contact_note,
)
from app.services.onboarding_activation import _reminder_email_body


_SHELL_FOOTER_MARKER = 'border-top:1px solid #ececec;padding:16px 32px'


def _strip_shell_footer(html_body: str) -> str:
    """render_email_shell()의 공용 푸터(회사정보+약관 라벨, locale 무관 항상 한글 —
    스코프 경계 주석 참고)를 잘라내고 그 앞(헤더+content_html) 부분만 남긴다."""
    idx = html_body.find(_SHELL_FOOTER_MARKER)
    assert idx != -1, "render_email_shell 구조가 바뀌어 footer marker를 못 찾음 — 이 헬퍼도 갱신 필요"
    return html_body[:idx]


def _render_action_template(copy: dict, *, locale: str, security_note: str | None = None) -> str:
    return render_action_email(
        intro_lines=copy["intro_lines"],
        cta_label=copy["cta_label"],
        cta_url="https://app.sprintable.ai/action?token=dummy",
        expiry_note=copy["expiry_note"],
        security_note=security_note if security_note is not None else copy["security_note"],
        fallback_label=copy["fallback_label"],
        locale=locale,
    )


def _render_payment_receipt(*, locale: str) -> str:
    copy = TRANSACTIONAL_COPY["payment_receipt"][locale]
    amount_display = "12,000원" if locale == "ko" else "₩12,000"
    intro_lines = [line.format(amount=amount_display) for line in copy["intro_lines"]]
    return render_action_email(
        intro_lines=intro_lines,
        cta_label=copy["cta_label"],
        cta_url="https://app.sprintable.ai/receipt/dummy",
        expiry_note=copy["expiry_note"],
        security_note=resolve_urgent_contact_note("payment_receipt", locale),
        fallback_label=copy["fallback_label"],
        locale=locale,
    )


def _render_storage_warn(*, locale: str) -> str:
    copy = STORAGE_WARN_COPY[locale]
    content = copy["body"].format(pct=82.5, used_mb=8250, cap_mb=10000)
    return render_email_shell(content, locale=locale)


def _render_au_warn(*, locale: str) -> str:
    copy = AU_WARN_COPY[locale]
    content = copy["body"].format(pct=91.0, current=910, au_limit=1000)
    return render_email_shell(content, locale=locale)


def _render_reminder(*, locale: str) -> str:
    return _reminder_email_body(
        app_url="https://app.sprintable.ai",
        unsub_link="https://app.sprintable.ai/unsubscribe?token=dummy",
        locale=locale,
    )


# (템플릿명, render(locale)->body, 뮤테이션 대상 dict/필드 — en 값을 ko 값으로 스왑할 자리)
TEMPLATE_CASES = [
    (
        "verify_email",
        lambda locale: _render_action_template(TRANSACTIONAL_COPY["verify_email"][locale], locale=locale),
        TRANSACTIONAL_COPY["verify_email"],
        "cta_label",
    ),
    (
        "reset_password",
        lambda locale: _render_action_template(TRANSACTIONAL_COPY["reset_password"][locale], locale=locale),
        TRANSACTIONAL_COPY["reset_password"],
        "cta_label",
    ),
    (
        "set_password_confirm",
        lambda locale: _render_action_template(TRANSACTIONAL_COPY["set_password_confirm"][locale], locale=locale),
        TRANSACTIONAL_COPY["set_password_confirm"],
        "cta_label",
    ),
    ("payment_receipt", lambda locale: _render_payment_receipt(locale=locale), TRANSACTIONAL_COPY["payment_receipt"], "cta_label"),
    ("storage_warn", lambda locale: _render_storage_warn(locale=locale), STORAGE_WARN_COPY, "body"),
    ("au_warn", lambda locale: _render_au_warn(locale=locale), AU_WARN_COPY, "body"),
    ("reminder", lambda locale: _render_reminder(locale=locale), REMINDER_COPY, "cta_label"),
]

TEMPLATE_IDS = [c[0] for c in TEMPLATE_CASES]


@pytest.mark.parametrize("name,render,_copy,_field", TEMPLATE_CASES, ids=TEMPLATE_IDS)
def test_en_render_has_zero_korean(name, render, _copy, _field):
    body = _strip_shell_footer(render("en"))
    assert not _is_hangul(body), f"{name} en 렌더 결과(셸 푸터 제외)에 한글 문자가 섞여 있음(#3205 QA가 잡은 fallback_label류 반회귀 클래스)"


@pytest.mark.parametrize("name,render,_copy,_field", TEMPLATE_CASES, ids=TEMPLATE_IDS)
def test_ko_render_has_korean(name, render, _copy, _field):
    """양성대조① sanity — ko 경로가 실제로 한글을 담는지(빈 렌더·폴백 오염이면 위 zero-korean
    단언이 en도 ko도 전부 통과하는 무의미한 상태가 된다)."""
    body = render("ko")
    assert _is_hangul(body), f"{name} ko 렌더 결과에 한글이 없음 — 렌더 경로 자체가 깨졌을 가능성"


@pytest.mark.parametrize("name,render,copy,field", TEMPLATE_CASES, ids=TEMPLATE_IDS)
def test_mutation_hangul_leak_into_en_would_be_caught(name, render, copy, field, monkeypatch):
    """양성대조② — en 카피의 실제 렌더 대상 필드를 대응 ko 값으로 스왑하면(플레이스홀더
    이름이 ko/en 동일해 .format()도 안 깨짐) 위 zero-korean 단언이 진짜로 RED가 되는지.
    tautological pass(항상 통과하는 무의미한 단언)가 아님을 고정한다."""
    monkeypatch.setitem(copy["en"], field, copy["ko"][field])
    body = _strip_shell_footer(render("en"))
    assert _is_hangul(body), f"{name} — en 필드를 ko 값으로 바꿨는데도 한글이 안 잡힘, zero-korean 단언이 무력화된 상태"
