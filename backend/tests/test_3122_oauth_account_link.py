"""story #3122(계정·후속) — 수동 «계정 연결(link)».

#3118(Sign in with Apple) 그라운딩: Apple private relay 이메일이면 자동 이메일 병합이
원천 불가해 항상 신규 계정이 생긴다. PO 확定 정책: 자동 병합에 안 기댄다 — 병합은
사용자 주도 수동 연결로. 이 파일은 그 link rail 3개 엔드포인트를 검증한다.

- oauth_link_authorize: 인증 필수, state에 link_user_id(현재 로그인 유저) 클레임을 싣는다.
- oauth_link_callback: 로그인 mint 없음(AC4) — state의 link_user_id가 콜백 시점 유저와
  일치해야 하고(계정전환 방어), 다른 유저에 이미 묶인 provider_id면 명시 거부(AC2, 병합
  아님 — 계정 탈취 방지), 자기 자신에 이미 연결돼 있으면 멱등 200.
- oauth_unlink: 로그인 수단이 이거 하나뿐이면 거부(AC3).

httpx 프로토콜 단계(_exchange_oauth_code_for_userinfo)는 test_auth_security.py가 이미
Apple JWKS 검증 등 크립토 축을 실키페어로 검증했다 — 이 파일은 그 함수 자체를 monkeypatch로
대체하고, 이 스토리가 신설한 "state 대조·충돌 거부·최소수단 가드·감사기록" 로직만 본다."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.security import JWTError, create_oauth_state_token, decode_oauth_state_token


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── security.py: state token link_user_id 왕복 ───────────────────────────────

def test_oauth_state_token_carries_link_user_id():
    uid = str(uuid.uuid4())
    token = create_oauth_state_token("apple", link_user_id=uid)
    payload = decode_oauth_state_token(token, "apple")
    assert payload["link_user_id"] == uid
    assert payload["provider"] == "apple"


def test_oauth_state_token_without_link_user_id_has_no_claim():
    """로그인 rail(oauth_authorize)이 여전히 link_user_id 없이 부르는 기존 경로 — 무회귀."""
    token = create_oauth_state_token("google")
    payload = decode_oauth_state_token(token, "google")
    assert "link_user_id" not in payload


def test_oauth_state_token_expired_or_forged_raises():
    with pytest.raises(JWTError):
        decode_oauth_state_token("not-a-real-jwt", "google")


# ─── me.py: _linked_providers 순수 함수 ────────────────────────────────────────

def test_linked_providers_lists_only_set_columns():
    from app.routers.me import _linked_providers

    user = MagicMock()
    user.google_id = "g-123"
    user.apple_id = None
    assert _linked_providers(user) == ["google"]

    user.apple_id = "a-456"
    assert _linked_providers(user) == ["google", "apple"]

    user.google_id = None
    user.apple_id = None
    assert _linked_providers(user) == []


# ─── oauth_link_authorize ──────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_oauth_link_authorize_requires_auth():
    """인증 없이 부르면 401 — 로그인 rail(oauth_authorize)과 달리 이 엔드포인트는
    "이미 로그인된 유저"가 전제다."""
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.get("/api/v2/auth/oauth/google/link/authorize")
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_oauth_link_authorize_state_binds_current_user(monkeypatch):
    from app.core.config import settings
    from app.dependencies.auth import get_current_user
    from app.main import app

    monkeypatch.setattr(settings, "jwt_secret", "test-jwt-secret", raising=False)
    monkeypatch.setattr(settings, "google_client_id", "test-google-client-id", raising=False)

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())

    async def _override_auth():
        return ctx

    app.dependency_overrides[get_current_user] = _override_auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/auth/oauth/google/link/authorize")
        assert resp.status_code == 200
        body = resp.json()["data"]
        assert "test-google-client-id" in body["url"]
        payload = decode_oauth_state_token(body["state"], "google")
        assert payload["link_user_id"] == ctx.user_id
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_oauth_link_authorize_invalid_provider_rejected(monkeypatch):
    from app.dependencies.auth import get_current_user
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())

    async def _override_auth():
        return ctx

    app.dependency_overrides[get_current_user] = _override_auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/auth/oauth/github/link/authorize")
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "INVALID_PROVIDER"
    finally:
        app.dependency_overrides.clear()


# ─── oauth_link_callback ────────────────────────────────────────────────────────

def _mock_session_returning(scalar_value) -> AsyncMock:
    session = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = scalar_value
    session.execute = AsyncMock(return_value=result)
    session.add = MagicMock()
    session.commit = AsyncMock()
    return session


async def _link_callback_client(app, session: AsyncMock, ctx: MagicMock):
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    async def _override_db():
        yield session

    async def _override_auth():
        return ctx

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_current_user] = _override_auth
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.anyio
async def test_oauth_link_callback_rejects_invalid_state():
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    session = _mock_session_returning(None)

    client = await _link_callback_client(app, session, ctx)
    try:
        async with client as c:
            resp = await c.post(
                "/api/v2/auth/oauth/google/link/callback",
                json={"provider": "google", "code": "irrelevant", "state": "garbage"},
            )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "INVALID_STATE"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_oauth_link_callback_rejects_session_mismatch(monkeypatch):
    """state 발급 시점 유저 ≠ 콜백 시점 유저 — 계정 전환/탈취 방어(AC 근접 §4)."""
    from app.core.config import settings
    from app.main import app

    monkeypatch.setattr(settings, "jwt_secret", "test-jwt-secret", raising=False)

    issuing_user_id = str(uuid.uuid4())
    calling_user_id = str(uuid.uuid4())
    state = create_oauth_state_token("google", link_user_id=issuing_user_id)

    ctx = MagicMock()
    ctx.user_id = calling_user_id
    session = _mock_session_returning(None)

    client = await _link_callback_client(app, session, ctx)
    try:
        async with client as c:
            resp = await c.post(
                "/api/v2/auth/oauth/google/link/callback",
                json={"provider": "google", "code": "code-1", "state": state},
            )
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "LINK_SESSION_MISMATCH"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_oauth_link_callback_success_new_link(monkeypatch):
    from app.core.config import settings
    import app.routers.auth as auth_router
    from app.main import app

    monkeypatch.setattr(settings, "jwt_secret", "test-jwt-secret", raising=False)
    monkeypatch.setattr(
        auth_router, "_exchange_oauth_code_for_userinfo",
        AsyncMock(return_value=("google-oauth-id-1", "user@example.com")),
    )

    uid = str(uuid.uuid4())
    state = create_oauth_state_token("google", link_user_id=uid)

    ctx = MagicMock()
    ctx.user_id = uid
    session = _mock_session_returning(None)  # 기존 매칭 유저 없음 → 신규 연결

    client = await _link_callback_client(app, session, ctx)
    try:
        async with client as c:
            resp = await c.post(
                "/api/v2/auth/oauth/google/link/callback",
                json={"provider": "google", "code": "code-1", "state": state},
            )
        assert resp.status_code == 200
        assert resp.json()["data"] == {"provider": "google", "linked": True}
        session.commit.assert_awaited()
        # select(existing) + update(link) — 정확히 2회.
        assert session.execute.await_count == 2
        # audit log가 성공 이벤트로 기록됐는지(2번째 add 호출이 감사행).
        assert any(
            getattr(call.args[0], "event_type", None) == "oauth_link"
            for call in session.add.call_args_list
        )
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_oauth_link_callback_rejects_conflict_different_user(monkeypatch):
    """AC2 — 이미 다른 계정에 묶인 provider_id는 병합이 아니라 명시 거부(계정 탈취 방지)."""
    from app.core.config import settings
    import app.routers.auth as auth_router
    from app.main import app

    monkeypatch.setattr(settings, "jwt_secret", "test-jwt-secret", raising=False)
    monkeypatch.setattr(
        auth_router, "_exchange_oauth_code_for_userinfo",
        AsyncMock(return_value=("google-oauth-id-1", "other@example.com")),
    )

    uid = str(uuid.uuid4())
    other_user = MagicMock()
    other_user.id = uuid.uuid4()  # ≠ uid — 다른 계정에 이미 연결됨

    state = create_oauth_state_token("google", link_user_id=uid)
    ctx = MagicMock()
    ctx.user_id = uid
    session = _mock_session_returning(other_user)

    client = await _link_callback_client(app, session, ctx)
    try:
        async with client as c:
            resp = await c.post(
                "/api/v2/auth/oauth/google/link/callback",
                json={"provider": "google", "code": "code-1", "state": state},
            )
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "PROVIDER_ALREADY_LINKED"
        # UPDATE(User.google_id 배선)가 절대 실행되지 않아야 한다 — select 1회뿐.
        assert session.execute.await_count == 1
        assert any(
            getattr(call.args[0], "event_type", None) == "oauth_link_rejected_conflict"
            for call in session.add.call_args_list
        )
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_oauth_link_callback_idempotent_when_already_self_linked(monkeypatch):
    from app.core.config import settings
    import app.routers.auth as auth_router
    from app.main import app

    monkeypatch.setattr(settings, "jwt_secret", "test-jwt-secret", raising=False)
    monkeypatch.setattr(
        auth_router, "_exchange_oauth_code_for_userinfo",
        AsyncMock(return_value=("google-oauth-id-1", "user@example.com")),
    )

    uid = str(uuid.uuid4())
    self_user = MagicMock()
    self_user.id = uuid.UUID(uid)

    state = create_oauth_state_token("google", link_user_id=uid)
    ctx = MagicMock()
    ctx.user_id = uid
    session = _mock_session_returning(self_user)

    client = await _link_callback_client(app, session, ctx)
    try:
        async with client as c:
            resp = await c.post(
                "/api/v2/auth/oauth/google/link/callback",
                json={"provider": "google", "code": "code-1", "state": state},
            )
        assert resp.status_code == 200
        assert resp.json()["data"] == {"provider": "google", "linked": True}
        # 이미 본인 계정에 연결돼있으니 쓰기 자체가 없다 — select 1회뿐, commit 없음.
        assert session.execute.await_count == 1
        session.commit.assert_not_awaited()
    finally:
        app.dependency_overrides.clear()


# ─── oauth_unlink ───────────────────────────────────────────────────────────────

def _user_with(*, hashed_password: str = "", google_id: str | None = None, apple_id: str | None = None) -> MagicMock:
    user = MagicMock()
    user.id = uuid.uuid4()
    user.hashed_password = hashed_password
    user.google_id = google_id
    user.apple_id = apple_id
    return user


@pytest.mark.anyio
async def test_oauth_unlink_rejects_last_login_method():
    from app.main import app

    user = _user_with(hashed_password="", google_id=None, apple_id="apple-id-1")  # 로그인 수단 1개뿐
    ctx = MagicMock()
    ctx.user_id = str(user.id)
    session = _mock_session_returning(user)

    client = await _link_callback_client(app, session, ctx)
    try:
        async with client as c:
            resp = await c.post("/api/v2/auth/oauth/apple/unlink")
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "LAST_LOGIN_METHOD"
        session.commit.assert_not_awaited()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_oauth_unlink_succeeds_with_password_remaining():
    from app.main import app

    user = _user_with(hashed_password="hash", google_id=None, apple_id="apple-id-1")
    ctx = MagicMock()
    ctx.user_id = str(user.id)
    session = _mock_session_returning(user)

    client = await _link_callback_client(app, session, ctx)
    try:
        async with client as c:
            resp = await c.post("/api/v2/auth/oauth/apple/unlink")
        assert resp.status_code == 200
        assert resp.json()["data"] == {"provider": "apple", "linked": False}
        session.commit.assert_awaited()
        assert any(
            getattr(call.args[0], "event_type", None) == "oauth_unlink"
            for call in session.add.call_args_list
        )
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_oauth_unlink_succeeds_with_other_provider_remaining():
    from app.main import app

    user = _user_with(hashed_password="", google_id="g-1", apple_id="apple-id-1")
    ctx = MagicMock()
    ctx.user_id = str(user.id)
    session = _mock_session_returning(user)

    client = await _link_callback_client(app, session, ctx)
    try:
        async with client as c:
            resp = await c.post("/api/v2/auth/oauth/apple/unlink")
        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_oauth_unlink_rejects_not_linked():
    from app.main import app

    user = _user_with(hashed_password="hash", google_id=None, apple_id=None)
    ctx = MagicMock()
    ctx.user_id = str(user.id)
    session = _mock_session_returning(user)

    client = await _link_callback_client(app, session, ctx)
    try:
        async with client as c:
            resp = await c.post("/api/v2/auth/oauth/apple/unlink")
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "PROVIDER_NOT_LINKED"
    finally:
        app.dependency_overrides.clear()
