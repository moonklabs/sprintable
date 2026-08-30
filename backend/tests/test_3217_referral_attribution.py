"""story #3217(AARRR·Referral 계측) — invite_token 수락 성공 시 결정론적 referral
귀속(A축)이 users.signup_utm_*에 실착하는지, 실패 시 무개입인지(쿠키 유래 값 보존)
양방향 pin. + 초대 메일 accept_link에 utm 3종이 부착되는지(B축)."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _register_client():
    """story #3204/#3216 동형 패턴 — override_db_and_read 경유(카디르 QA #2451 재발
    방지, PR#3617에서 이미 한 번 지적됨)."""
    from app.main import app
    from app.dependencies.auth import get_current_user
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

    async def override_auth():
        ctx = MagicMock()
        ctx.user_id = str(uuid.uuid4())
        return ctx

    override_db_and_read(app, override_db)
    app.dependency_overrides[get_current_user] = override_auth
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


def _register_payload(**overrides) -> dict:
    return {
        "email": f"new-{uuid.uuid4().hex}@example.com",
        "password": "TestPass1!",
        "display_name": "Test User",
        "tos_accepted": True,
        **overrides,
    }


def _added_user(session):
    from app.models.user import User
    return next(c.args[0] for c in session.add.call_args_list if isinstance(c.args[0], User))


@pytest.mark.anyio
async def test_register_invite_accept_success_overrides_cookie_derived_utm():
    """A축 — invite_token 수락 성공 시 referral/org_invite/<org_id>가 쿠키 유래 값(있어도)
    보다 우선 적용된다(override 명시)."""
    org_id = str(uuid.uuid4())
    client, session, app = await _register_client()
    try:
        with patch(
            "app.repositories.org_invite.OrgInviteRepository.accept",
            new=AsyncMock(return_value={"ok": True, "org_id": org_id, "role": "member"}),
        ):
            async with client as c:
                resp = await c.post("/api/v2/auth/register", json=_register_payload(
                    invite_token="tok-1",
                    # 쿠키 유래 값(존재해도 override 대상) — first-touch가 먼저 세팅됐던 시나리오.
                    signup_utm_source="google", signup_utm_medium="cpc", signup_utm_campaign="launch",
                ))
        assert resp.status_code == 201
        user = _added_user(session)
        assert user.signup_utm_source == "referral"
        assert user.signup_utm_medium == "org_invite"
        assert user.signup_utm_campaign == org_id
    finally:
        from app.main import app as _app
        _app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_register_invite_accept_failure_is_hands_off_keeps_cookie_derived_utm():
    """무효/만료 토큰(수락 실패) — signup_utm_*는 기존 쿠키 경로 그대로(무개입)."""
    client, session, app = await _register_client()
    try:
        with patch(
            "app.repositories.org_invite.OrgInviteRepository.accept",
            new=AsyncMock(return_value={"ok": False, "reason": "expired"}),
        ):
            async with client as c:
                resp = await c.post("/api/v2/auth/register", json=_register_payload(
                    invite_token="tok-expired",
                    signup_utm_source="google", signup_utm_medium="cpc", signup_utm_campaign="launch",
                ))
        assert resp.status_code == 201
        user = _added_user(session)
        assert user.signup_utm_source == "google"
        assert user.signup_utm_medium == "cpc"
        assert user.signup_utm_campaign == "launch"
    finally:
        from app.main import app as _app
        _app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_register_without_invite_token_is_unaffected():
    """invite_token 자체가 없으면 이 스토리의 로직 경로를 아예 안 탄다(회귀 없음)."""
    client, session, app = await _register_client()
    try:
        async with client as c:
            resp = await c.post("/api/v2/auth/register", json=_register_payload(
                signup_utm_source="direct",
            ))
        assert resp.status_code == 201
        user = _added_user(session)
        assert user.signup_utm_source == "direct"
    finally:
        from app.main import app as _app
        _app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_apply_referral_attribution_sets_exact_three_fields():
    """_apply_referral_attribution 단위 — 정확히 이 3값(문자열 그대로)을 세팅한다."""
    from app.routers.auth import _apply_referral_attribution

    user = MagicMock()
    org_id = str(uuid.uuid4())
    _apply_referral_attribution(user, {"ok": True, "org_id": org_id})
    assert user.signup_utm_source == "referral"
    assert user.signup_utm_medium == "org_invite"
    assert user.signup_utm_campaign == org_id


@pytest.mark.anyio
async def test_auto_accept_invitation_now_returns_accept_result_dict():
    """카디르류 회귀가드 — _auto_accept_invitation이 이전엔 반환값을 버렸다(None). 이제
    accept()의 dict를 그대로 전달해야 호출부의 A축 분기가 작동한다."""
    from app.routers.auth import _auto_accept_invitation

    user = MagicMock()
    user.id = uuid.uuid4()
    user.email = "a@b.com"
    session = AsyncMock()
    accept_mock = AsyncMock(return_value={"ok": True, "org_id": "org-1"})
    with patch("app.repositories.org_invite.OrgInviteRepository.accept", new=accept_mock):
        result = await _auto_accept_invitation(session, user, "tok-1")
    assert result == {"ok": True, "org_id": "org-1"}


# ─── B축 — 초대 메일 accept_link의 utm 부착 ─────────────────────────────────────

def test_send_invite_email_appends_utm_when_org_id_given(monkeypatch):
    from app.services import org_invite_email

    captured: dict = {}

    def fake_send_email(*, to, subject, html_body):
        captured["html_body"] = html_body
        return True

    monkeypatch.setattr(org_invite_email, "send_email", fake_send_email)
    org_id = str(uuid.uuid4())
    error = org_invite_email.send_invite_email(
        to="invitee@example.com", org_name="테스트조직", token="tok-1", role="member",
        org_id=org_id, inviter_name="누군가", locale="ko",
    )
    assert error is None
    assert f"utm_source=referral&utm_medium=org_invite&utm_campaign={org_id}" in captured["html_body"]
    assert "token=tok-1" in captured["html_body"]


def test_send_invite_email_without_org_id_omits_utm_params(monkeypatch):
    """org_id 미전달(하위호환 — 다른 호출자가 있을 가능성) 시 utm 파라미터를 안 붙인다
    (지어내지 않음)."""
    from app.services import org_invite_email

    captured: dict = {}

    def fake_send_email(*, to, subject, html_body):
        captured["html_body"] = html_body
        return True

    monkeypatch.setattr(org_invite_email, "send_email", fake_send_email)
    org_invite_email.send_invite_email(
        to="invitee@example.com", org_name="테스트조직", token="tok-1", role="member", locale="ko",
    )
    assert "utm_source" not in captured["html_body"]


def test_org_invites_router_passes_org_id_to_send_invite_email():
    """소스 레벨 — create/resend 두 호출부 모두 org_id=str(id)를 넘긴다(누락 회귀 방지)."""
    import inspect
    import app.routers.org_invites as mod
    source = inspect.getsource(mod)
    assert source.count("org_id=str(id)") == 2
