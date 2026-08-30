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


# ─── oauth_callback() 신규 유저 경로 — register()와 동일 계약(카디르 QA, PR#3623) ───
# 카디르 지적 — register()만 pin됐고 oauth_callback() 경로는 pin 0건이라 가드 제거
# 뮤테이션에 이 경로 전체가 침묵했다(false-green). register 것과 동형으로 양방향 추가.

async def _oauth_client(session: AsyncMock):
    """story #3204 test_3204_signup_attribution.py와 동형 패턴(override_db_and_read
    경유) — 파일 독립성 유지를 위해 재구현(공유 임포트 안 함, 이 코드베이스 관례)."""
    from app.main import app
    from tests.conftest import override_db_and_read

    async def override_db():
        yield session

    override_db_and_read(app, override_db)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _mock_session_returning_none() -> AsyncMock:
    """provider_id 조회·email 조회 둘 다 None — 신규 유저 생성 분기로 진입."""
    session = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=result)
    session.add = MagicMock()
    session.flush = AsyncMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    return session


@pytest.mark.anyio
async def test_oauth_callback_invite_accept_success_overrides_cookie_derived_utm(monkeypatch):
    """A축 — OAuth 신규 가입 경로도 register()와 동일하게, invite_token 수락 성공 시
    referral/org_invite/<org_id>가 쿠키 유래 값보다 우선 적용된다."""
    from app.core.config import settings
    from app.core.security import create_oauth_state_token
    import app.routers.auth as auth_router
    from app.models.user import User

    monkeypatch.setattr(settings, "jwt_secret", "test-jwt-secret", raising=False)
    monkeypatch.setattr(
        auth_router, "_exchange_oauth_code_for_userinfo",
        AsyncMock(return_value=("google-oauth-id-1", "brand-new@example.com")),
    )
    org_id = str(uuid.uuid4())
    state = create_oauth_state_token("google")
    session = _mock_session_returning_none()
    client = await _oauth_client(session)
    try:
        with patch(
            "app.repositories.org_invite.OrgInviteRepository.accept",
            new=AsyncMock(return_value={"ok": True, "org_id": org_id, "role": "member"}),
        ):
            async with client as c:
                resp = await c.post("/api/v2/auth/oauth/callback", json={
                    "provider": "google", "code": "code-1", "state": state, "tos_accepted": True,
                    "invite_token": "tok-1",
                    "signup_utm_source": "google", "signup_utm_medium": "cpc", "signup_utm_campaign": "launch",
                })
        assert resp.status_code == 200
        assert resp.json()["data"]["is_new_user"] is True
        user = next(c.args[0] for c in session.add.call_args_list if isinstance(c.args[0], User))
        assert user.signup_utm_source == "referral"
        assert user.signup_utm_medium == "org_invite"
        assert user.signup_utm_campaign == org_id
    finally:
        from app.main import app
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_oauth_callback_invite_accept_failure_is_hands_off(monkeypatch):
    """A축 — OAuth 신규 가입에서 초대 토큰이 무효/만료면 무개입(쿠키 유래 값 보존)."""
    from app.core.config import settings
    from app.core.security import create_oauth_state_token
    import app.routers.auth as auth_router
    from app.models.user import User

    monkeypatch.setattr(settings, "jwt_secret", "test-jwt-secret", raising=False)
    monkeypatch.setattr(
        auth_router, "_exchange_oauth_code_for_userinfo",
        AsyncMock(return_value=("google-oauth-id-2", "brand-new-2@example.com")),
    )
    state = create_oauth_state_token("google")
    session = _mock_session_returning_none()
    client = await _oauth_client(session)
    try:
        with patch(
            "app.repositories.org_invite.OrgInviteRepository.accept",
            new=AsyncMock(return_value={"ok": False, "reason": "expired"}),
        ):
            async with client as c:
                resp = await c.post("/api/v2/auth/oauth/callback", json={
                    "provider": "google", "code": "code-1", "state": state, "tos_accepted": True,
                    "invite_token": "tok-expired",
                    "signup_utm_source": "google", "signup_utm_medium": "cpc", "signup_utm_campaign": "launch",
                })
        assert resp.status_code == 200
        user = next(c.args[0] for c in session.add.call_args_list if isinstance(c.args[0], User))
        assert user.signup_utm_source == "google"
        assert user.signup_utm_medium == "cpc"
        assert user.signup_utm_campaign == "launch"
    finally:
        from app.main import app
        app.dependency_overrides.clear()


# ─── authenticated accept(/api/v2/invites/accept) — 실 이메일 가입 여정의 진짜 A축 ──
# PO 착지 후 라이브 probe 발견(2026-08-30) — 이메일 가입은 register()가 invite_token을
# 받는 게 아니라: 비로그인 수락 → /login?returnUrl → 가입(invite_token 없이) →
# **이 authenticated accept**로 흘러 register() 훅이 무의미했다(OAuth 경로만 유효).
# 결정론 규칙: user.created_at >= invite_created_at(초대가 먼저·계정이 뒤=초대 유발
# 가입)이면 귀속, 계정이 초대보다 오래면(기존 유저 통상 수락) 무기록.

async def _invite_accept_client(user_created_at):
    """test_e_org_multi_s3_3_invite_accept.py와 동형 패턴(_get_repo 오버라이드)이되,
    get_db만 걸고 get_read_db를 놓치는 회귀 클래스(story #2451, PR#3617에서도 재발)를
    피해 override_db_and_read 경유로 교체 — 이 파일의 다른 헬퍼들과 동일 원칙."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from tests.conftest import override_db_and_read

    user_id = uuid.uuid4()
    mock_user = MagicMock()
    mock_user.id = user_id
    mock_user.email = "invitee@example.com"
    mock_user.is_active = True
    mock_user.created_at = user_created_at

    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = mock_user
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.commit = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        ctx = MagicMock()
        ctx.user_id = str(user_id)
        return ctx

    override_db_and_read(app, override_db)
    app.dependency_overrides[get_current_user] = override_auth
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_user, app


@pytest.mark.anyio
async def test_invite_accept_new_signup_after_invite_gets_referral_attribution():
    """계정 생성이 초대 생성 이후(초대가 유발한 신규 가입) — referral/org_invite/<org_id>
    가 실착한다."""
    from datetime import datetime, timedelta, timezone
    from app.routers.invite_accept import _get_repo

    invite_created_at = datetime(2026, 8, 1, tzinfo=timezone.utc)
    user_created_at = invite_created_at + timedelta(hours=1)  # 초대 後 가입
    org_id = str(uuid.uuid4())

    client, user, app = await _invite_accept_client(user_created_at)
    try:
        mock_repo = MagicMock()
        mock_repo.accept = AsyncMock(return_value={
            "ok": True, "org_id": org_id, "role": "member", "invite_created_at": invite_created_at,
        })
        app.dependency_overrides[_get_repo] = lambda: mock_repo

        async with client as c:
            resp = await c.post("/api/v2/invites/accept", json={"token": "tok-1"})

        assert resp.status_code == 200
        assert user.signup_utm_source == "referral"
        assert user.signup_utm_medium == "org_invite"
        assert user.signup_utm_campaign == org_id
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_invite_accept_existing_user_before_invite_is_hands_off():
    """계정이 초대보다 오래됐다(기존 유저의 통상 수락) — 귀속을 안 건드린다(무기록,
    가입 시점 기존 값 보존 — 여기선 override 호출 자체가 없었음을 signup_utm_source
    미변경 MagicMock 기본 sentinel로 확認)."""
    from datetime import datetime, timedelta, timezone
    from app.routers.invite_accept import _get_repo

    invite_created_at = datetime(2026, 8, 1, tzinfo=timezone.utc)
    user_created_at = invite_created_at - timedelta(days=30)  # 계정이 초대보다 훨씬 오래됨
    org_id = str(uuid.uuid4())

    client, user, app = await _invite_accept_client(user_created_at)
    # 가입 시점 기존 귀속값(예: 이 유저는 예전에 direct로 가입) — 무기록이면 그대로 남아야 한다.
    user.signup_utm_source = "direct"
    user.signup_utm_medium = None
    user.signup_utm_campaign = None
    try:
        mock_repo = MagicMock()
        mock_repo.accept = AsyncMock(return_value={
            "ok": True, "org_id": org_id, "role": "member", "invite_created_at": invite_created_at,
        })
        app.dependency_overrides[_get_repo] = lambda: mock_repo

        async with client as c:
            resp = await c.post("/api/v2/invites/accept", json={"token": "tok-1"})

        assert resp.status_code == 200
        assert user.signup_utm_source == "direct"
        assert user.signup_utm_medium is None
        assert user.signup_utm_campaign is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_invite_accept_without_invite_created_at_key_is_hands_off():
    """기존 accept() 성공 응답(invite_created_at 키 자체가 없는 이전 계약 — 회귀 시나리오
    시뮬레이션)에서도 크래시 없이 무기록으로 안전하게 저하한다."""
    from app.routers.invite_accept import _get_repo

    client, user, app = await _invite_accept_client(user_created_at=None)
    user.signup_utm_source = "direct"
    try:
        mock_repo = MagicMock()
        mock_repo.accept = AsyncMock(return_value={"ok": True, "org_id": str(uuid.uuid4()), "role": "member"})
        app.dependency_overrides[_get_repo] = lambda: mock_repo

        async with client as c:
            resp = await c.post("/api/v2/invites/accept", json={"token": "tok-1"})

        assert resp.status_code == 200
        assert user.signup_utm_source == "direct"
    finally:
        app.dependency_overrides.clear()


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
