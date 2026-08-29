"""story #3205 — 발송 메일 locale 분기 pin. mock 세션(test_register_email_delivered.py와
동형 패턴, 실PG 불요) — AC1: locale=ko 유저 → ko 메일·locale=en 유저 → en 메일."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _register_client():
    from app.main import app
    from tests.conftest import override_db_and_read

    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_result.scalars.return_value.all.return_value = []
    mock_result.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.flush = AsyncMock()
    mock_session.commit = AsyncMock()
    mock_session.add = MagicMock()

    async def override_db():
        yield mock_session

    # story #2451(§6 Phase3) — get_db만 걸고 get_read_db를 잊는 회귀 방지, 공용 헬퍼 경유.
    override_db_and_read(app, override_db)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


def _payload():
    return {
        "email": f"new-{uuid.uuid4().hex}@example.com",
        "password": "TestPass1!",
        "display_name": "Test User",
        "tos_accepted": True,
    }


@pytest.mark.anyio
async def test_register_captures_locale_from_accept_language_and_sends_en_copy(monkeypatch):
    sent = {}

    def _fake_send_email(**kwargs):
        sent.update(kwargs)
        return True

    monkeypatch.setattr("app.services.email.send_email", _fake_send_email)
    client, session, app = await _register_client()
    try:
        async with client as c:
            resp = await c.post(
                "/api/v2/auth/register",
                json=_payload(),
                headers={"Accept-Language": "en-US,en;q=0.9"},
            )
        assert resp.status_code == 201
        # session.add(user)·session.add(refresh_token) 둘 다 찍힌다 — User 인스턴스만 골라 확인.
        from app.models.user import User
        added_user = next(c.args[0] for c in session.add.call_args_list if isinstance(c.args[0], User))
        assert added_user.locale == "en"
        assert sent["subject"] == "Please verify your Sprintable email"
        assert "Verify email" in sent["html_body"]
        # 까디르 QA(2026-08-29) 재발 방지 — fallback_label이 렌더러에 ko로 하드코딩돼 있어
        # en 메일에도 "버튼이 열리지 않으면…" 한 줄이 섞이던 결함. en 메일엔 ko가 없어야 한다.
        assert "버튼이 열리지 않으면" not in sent["html_body"]
        # html.escape가 작은따옴표를 &#x27;로 바꾸므로 그 형태로 확인.
        assert "If the button doesn&#x27;t work, paste this address into your browser:" in sent["html_body"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_register_defaults_to_ko_without_accept_language_header(monkeypatch):
    sent = {}

    def _fake_send_email(**kwargs):
        sent.update(kwargs)
        return True

    monkeypatch.setattr("app.services.email.send_email", _fake_send_email)
    client, session, app = await _register_client()
    try:
        async with client as c:
            resp = await c.post("/api/v2/auth/register", json=_payload())
        assert resp.status_code == 201
        from app.models.user import User
        added_user = next(c.args[0] for c in session.add.call_args_list if isinstance(c.args[0], User))
        assert added_user.locale == "ko"
        assert sent["subject"] == "Sprintable 이메일 인증을 완료해 주세요"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_forgot_password_sends_locale_matched_copy(monkeypatch):
    from app.main import app
    from app.models.user import User
    from tests.conftest import override_db_and_read

    en_user = User(
        id=uuid.uuid4(), email="en-user@example.com", hashed_password="x",
        is_active=True, email_verified=True, locale="en",
    )
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = en_user
    mock_session.execute = AsyncMock(return_value=mock_result)

    async def override_db():
        yield mock_session

    sent = {}

    def _fake_send_email(**kwargs):
        sent.update(kwargs)
        return True

    monkeypatch.setattr("app.services.email.send_email", _fake_send_email)
    # story #2451(§6 Phase3) — get_db만 걸고 get_read_db를 잊는 회귀 방지, 공용 헬퍼 경유.
    override_db_and_read(app, override_db)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/api/v2/auth/forgot-password", json={"email": en_user.email})
        assert resp.status_code == 200
        assert sent["subject"] == "Reset your Sprintable password"
        assert "Reset password" in sent["html_body"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_send_activation_reminder_uses_user_locale(monkeypatch):
    from app.models.user import User
    from app.services.onboarding_activation import send_activation_reminder

    ko_user = User(id=uuid.uuid4(), email="ko@example.com", hashed_password="x", locale="ko")
    en_user = User(id=uuid.uuid4(), email="en@example.com", hashed_password="x", locale="en")

    sent = []

    def _fake_send_email(**kwargs):
        sent.append(kwargs)
        return True

    monkeypatch.setattr("app.services.email.send_email", _fake_send_email)
    db = AsyncMock()
    db.add = MagicMock()

    await send_activation_reminder(db, ko_user)
    await send_activation_reminder(db, en_user)

    assert sent[0]["subject"] == "Sprintable — 가입 완료까지 몇 단계 남았습니다"
    assert "이어서 진행하기" in sent[0]["html_body"]
    assert sent[1]["subject"] == "Sprintable — a few steps left to finish setup"
    assert "Continue setup" in sent[1]["html_body"]
    # story #3206(AC1) — 리마인드도 공용 셸 경유(회사정보 푸터 존재로 확認).
    assert "주식회사 뭉클랩" in sent[0]["html_body"]
    assert "주식회사 뭉클랩" in sent[1]["html_body"]


def test_send_invite_email_uses_locale_param(monkeypatch):
    from app.services.org_invite_email import send_invite_email

    sent = {}

    def _fake_send_email(**kwargs):
        sent.update(kwargs)
        return True

    monkeypatch.setattr("app.services.org_invite_email.send_email", _fake_send_email)

    err = send_invite_email(
        to="invitee@example.com", org_name="Acme", token="tok123", role="admin",
        inviter_name="Jay", locale="en",
    )
    assert err is None
    assert sent["subject"] == "[Sprintable] You've been invited to Acme"
    assert "You're invited!" in sent["html_body"]
    assert "Jay" in sent["html_body"] and "Acme" in sent["html_body"]
    assert 'lang="en"' in sent["html_body"]
    # 유나 검수 수정의견②: raw role(admin)에 관사가 붙어야 자연스러움.
    assert "as an admin" in sent["html_body"]
    # 유나 검수 수정의견①: footer 연도가 고정 2025가 아니라 동적.
    assert "© 2025 Sprintable" not in sent["html_body"]
    # story #3206 — 셸 공용 푸터가 연도/회사정보를 전담(중복 제거), 이 카피는
    # "왜 이 메일을 받았는지"만 남는다.
    assert "This email was sent automatically because you were invited." in sent["html_body"]
    # story #3206(AC1) — 초대도 공용 셸 경유(v1 자체 인디고 헤더바/tint 푸터가 아니라
    # 셸의 회사정보 푸터로 대체됐는지).
    assert "주식회사 뭉클랩" in sent["html_body"]
    assert "background:#6366f1" not in sent["html_body"]


def test_send_invite_email_defaults_to_ko(monkeypatch):
    """locale 인자 생략 시 기존 무회귀(ko) — 계정 없는 신규 피초대자 케이스."""
    from app.services.org_invite_email import send_invite_email

    sent = {}

    def _fake_send_email(**kwargs):
        sent.update(kwargs)
        return True

    monkeypatch.setattr("app.services.org_invite_email.send_email", _fake_send_email)
    err = send_invite_email(to="invitee@example.com", org_name="Acme", token="tok123", role="admin")
    assert err is None
    assert sent["subject"] == "[Sprintable] Acme 조직에 초대됐습니다"
    assert "팀에 초대됐어요!" in sent["html_body"]
