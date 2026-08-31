"""story #3204(acquisition 계측) — 가입 시점 utm/referrer 영속화(register()/oauth_callback())
+ oauth_callback() 응답의 is_new_user 플래그(FE sign_up 전환 이벤트 발화 신호)."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── register() — signup_utm_*/signup_referrer 영속화 ──────────────────────────

async def _register_client():
    """카디르 QA(PR#3612) — raw get_db 오버라이드는 get_read_db를 놓치는 회귀 클래스
    (story #2451 §6 Phase3, 4차 재발). override_db_and_read 경유로 두 dependency key를
    구조적으로 함께 건다."""
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
async def test_register_persists_signup_attribution_fields():
    client, session, app = await _register_client()
    try:
        async with client as c:
            resp = await c.post("/api/v2/auth/register", json=_register_payload(
                signup_utm_source="google", signup_utm_medium="cpc",
                signup_utm_campaign="launch", signup_referrer="https://twitter.com/x",
            ))
        assert resp.status_code == 201
        user = _added_user(session)
        assert user.signup_utm_source == "google"
        assert user.signup_utm_medium == "cpc"
        assert user.signup_utm_campaign == "launch"
        assert user.signup_referrer == "https://twitter.com/x"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_register_without_attribution_fields_leaves_them_none():
    """direct 가입(캠페인 링크 없음) — 지어내지 않고 None으로 남는다."""
    client, session, app = await _register_client()
    try:
        async with client as c:
            resp = await c.post("/api/v2/auth/register", json=_register_payload())
        assert resp.status_code == 201
        user = _added_user(session)
        assert user.signup_utm_source is None
        assert user.signup_referrer is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_register_clamps_oversized_attribution_fields():
    """카디르 QA(PR#3612) — UTM/referrer는 유저(브라우저)가 URL 쿼리로 완전히 통제하는
    값이라 무제한 저장 금지. 422 거부가 아니라 클램프(가입 자체는 막지 않는다)."""
    import app.routers.auth as auth_router

    client, session, app = await _register_client()
    try:
        async with client as c:
            resp = await c.post("/api/v2/auth/register", json=_register_payload(
                signup_utm_source="x" * 500,
                signup_referrer="https://example.com/" + ("y" * 2000),
            ))
        assert resp.status_code == 201
        user = _added_user(session)
        assert len(user.signup_utm_source) == auth_router._ATTRIBUTION_UTM_MAX_LEN
        assert len(user.signup_referrer) == auth_router._ATTRIBUTION_REFERRER_MAX_LEN
    finally:
        app.dependency_overrides.clear()


# ─── oauth_callback() — is_new_user + signup_utm_*/signup_referrer 영속화 ──────

async def _oauth_client(session: AsyncMock):
    """카디르 QA(PR#3612) — _register_client와 동일 fix(override_db_and_read 경유)."""
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


def _mock_session_returning_existing_user() -> AsyncMock:
    """provider_id 조회에서 기존 유저가 바로 잡힘 — 로그인(신규 아님). spec 없는 순수
    MagicMock — _build_app_metadata의 후속 member 조회도 같은 mock 결과를 재사용하므로
    (session.execute가 단일 return_value) 임의 속성 접근(member.user_id 등)이 모두
    통과해야 한다(spec을 걸면 User에 없는 속성에서 AttributeError)."""
    existing = MagicMock()
    existing.id = uuid.uuid4()
    existing.email = "existing@example.com"
    existing.locale = None
    # MagicMock은 getattr(user, "last_org_id", None)의 default가 절대 안 먹는다(속성이
    # "항상 존재"하니 Mock을 돌려줌) — 명시로 None을 박아야 _build_app_metadata가 실제
    # None 분기(org_id 미지정)를 탄다. 안 박으면 Mock이 JWT payload까지 새 나가
    # "Object of type MagicMock is not JSON serializable"로 죽는다.
    existing.last_org_id = None
    existing.last_project_id = None

    session = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = existing
    # _build_app_metadata의 후속 member/org 조회가 리스트류(scalars().all())를 읽는
    # 경로면 빈 리스트로 떨어뜨려 org_id/project_id 등 미확定 상태로 메타데이터가
    # 안전(JSON 직렬화 가능)하게 비게 한다 — 이 테스트의 관심사는 is_new_user뿐이라
    # 메타데이터 내용 자체는 검증 대상이 아니다.
    result.scalars.return_value.all.return_value = []
    result.all.return_value = []
    session.execute = AsyncMock(return_value=result)
    session.add = MagicMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    return session


@pytest.mark.anyio
async def test_oauth_callback_new_user_returns_is_new_user_true_and_persists_attribution(monkeypatch):
    from app.core.config import settings
    from app.core.security import create_oauth_state_token
    import app.routers.auth as auth_router

    monkeypatch.setattr(settings, "jwt_secret", "test-jwt-secret", raising=False)
    monkeypatch.setattr(
        auth_router, "_exchange_oauth_code_for_userinfo",
        AsyncMock(return_value=("google-oauth-id-1", "brand-new@example.com")),
    )
    state = create_oauth_state_token("google")
    session = _mock_session_returning_none()
    client = await _oauth_client(session)
    try:
        async with client as c:
            resp = await c.post("/api/v2/auth/oauth/callback", json={
                "provider": "google", "code": "code-1", "state": state, "tos_accepted": True,
                "signup_utm_source": "google", "signup_referrer": "https://twitter.com/x",
            })
        assert resp.status_code == 200
        assert resp.json()["data"]["is_new_user"] is True

        from app.models.user import User
        user = next(c.args[0] for c in session.add.call_args_list if isinstance(c.args[0], User))
        assert user.signup_utm_source == "google"
        assert user.signup_referrer == "https://twitter.com/x"
    finally:
        from app.main import app
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_oauth_callback_existing_user_login_returns_is_new_user_false(monkeypatch):
    """카디르류 검산 포인트 — provider_id로 기존 유저를 바로 찾은 로그인은 신규 가입이
    아니다. is_new_user=False라 FE가 재로그인마다 sign_up 이벤트를 중복 발화하지 않는다.

    _build_app_metadata는 org/project 해소 체인이 깊어(member/invite/first_accessible
    등 다단 폴백) 이 테스트의 관심사(is_new_user) 밖이라 고정 dict로 대체한다 — 메타데이터
    내용 자체는 이 테스트가 검증할 축이 아니다(다른 기존 테스트들의 몫)."""
    from app.core.config import settings
    from app.core.security import create_oauth_state_token
    import app.routers.auth as auth_router

    monkeypatch.setattr(settings, "jwt_secret", "test-jwt-secret", raising=False)
    monkeypatch.setattr(
        auth_router, "_exchange_oauth_code_for_userinfo",
        AsyncMock(return_value=("google-oauth-id-1", "existing@example.com")),
    )
    monkeypatch.setattr(auth_router, "_build_app_metadata", AsyncMock(return_value={}))
    state = create_oauth_state_token("google")
    session = _mock_session_returning_existing_user()
    client = await _oauth_client(session)
    try:
        async with client as c:
            resp = await c.post("/api/v2/auth/oauth/callback", json={
                "provider": "google", "code": "code-1", "state": state,
            })
        assert resp.status_code == 200
        assert resp.json()["data"]["is_new_user"] is False
    finally:
        from app.main import app
        app.dependency_overrides.clear()
