"""story #3247 — POST /api/v2/auth/totp/disable(신설). 인벤토리(#3246) 발견 A: FE가
`/api/v2/auth/2fa/disable`를 쳤는데 BE에 해제 라우트 자체가 없어(setup/verify만 존재)
2FA를 한 번 켜면 UI로 절대 못 껐다. 이 파일은 해제가 실제로 서버까지 도달하고, AC1(재검증
필수 — 현행 TOTP 코드 또는 비밀번호)이 실제로 강제되는지, 그리고 카디르+codex QA가
실증한 우회체인(탈취 세션으로 set-password→그 비밀번호로 disable)이 막히는지 pin한다."""
from __future__ import annotations

import time
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pyotp
import pytest

USER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _make_user(
    *, totp_enabled: bool, totp_secret: str | None, hashed_password: str,
    password_set_at: datetime | None = None,
) -> MagicMock:
    user = MagicMock()
    user.id = USER_ID
    user.email = "u@example.com"
    user.totp_enabled = totp_enabled
    user.totp_secret = totp_secret
    user.hashed_password = hashed_password
    user.password_set_at = password_set_at
    return user


async def _disable_client(*, iat: int | None = None, include_iat: bool = True):
    """story #3204/#3216 동형 패턴 — override_db_and_read 경유(라우트 실경로 관통,
    라우터 함수 직접호출 아님 — 미들웨어·JSON 파싱까지 포함해 진짜 HTTP 계약 증명).

    iat 기본값은 "방금 로그인한 정상 JWT 세션"(대부분의 password 케이스가 기대하는
    상태). include_iat=False는 claims에 iat 키 자체가 없는 API키 경로를 흉내낸다."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from tests.conftest import override_db_and_read

    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=MagicMock())
    mock_session.add = MagicMock()
    mock_session.commit = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        ctx = MagicMock()
        ctx.user_id = str(USER_ID)
        ctx.claims = {} if not include_iat else {"iat": iat if iat is not None else int(time.time())}
        return ctx

    override_db_and_read(app, override_db)
    app.dependency_overrides[get_current_user] = override_auth

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


@pytest.mark.anyio
async def test_disable_with_correct_totp_code_succeeds_and_clears_secret():
    from app.core.security import hash_password
    from app.models.login_audit_log import LoginAuditLog

    secret = pyotp.random_base32()
    user = _make_user(totp_enabled=True, totp_secret=secret, hashed_password=hash_password("pw"))
    client, session, app = await _disable_client()
    try:
        with patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)):
            code = pyotp.TOTP(secret).now()
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/disable", json={"code": code})
        assert resp.status_code == 200
        assert resp.json()["data"]["totp_enabled"] is False

        audit_calls = [c.args[0] for c in session.add.call_args_list if isinstance(c.args[0], LoginAuditLog)]
        assert len(audit_calls) == 1
        assert audit_calls[0].event_type == "2fa_disabled"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_disable_with_correct_password_succeeds_when_code_unavailable():
    """AC1 — 인증기 분실 시에도 비밀번호로 해제 가능해야 한다(그게 이 스토리의 존재 이유)."""
    from app.core.security import hash_password

    user = _make_user(totp_enabled=True, totp_secret=pyotp.random_base32(), hashed_password=hash_password("correct-horse"))
    client, _session, app = await _disable_client()
    try:
        with patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)):
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/disable", json={"password": "correct-horse"})
        assert resp.status_code == 200
        assert resp.json()["data"]["totp_enabled"] is False
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_disable_with_wrong_totp_code_rejected():
    from app.core.security import hash_password

    user = _make_user(totp_enabled=True, totp_secret=pyotp.random_base32(), hashed_password=hash_password("pw"))
    client, _session, app = await _disable_client()
    try:
        with patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)):
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/disable", json={"code": "000000"})
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "INVALID_TOTP"
        assert user.totp_enabled is True  # 상태 무변경(방어 실증)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_disable_with_wrong_password_rejected():
    from app.core.security import hash_password

    user = _make_user(totp_enabled=True, totp_secret=pyotp.random_base32(), hashed_password=hash_password("correct"))
    client, _session, app = await _disable_client()
    try:
        with patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)):
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/disable", json={"password": "wrong"})
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "WRONG_PASSWORD"
        assert user.totp_enabled is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_disable_with_password_when_no_password_set_rejected_not_500():
    """PO QA 지적(PR#3634) — OAuth 가입 유저(hashed_password="")가 password 경로로 해제
    시도하면 passlib UnknownHashError(→500)로 새지 않고 명시 403으로 거부돼야 한다."""
    user = _make_user(totp_enabled=True, totp_secret=pyotp.random_base32(), hashed_password="")
    client, _session, app = await _disable_client()
    try:
        with patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)):
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/disable", json={"password": "anything"})
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "PASSWORD_NOT_SET"
        assert user.totp_enabled is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_disable_password_path_blocked_for_api_key_auth():
    """카디르+codex 우회체인 최소방어선① — API키(sk_live_/hu_live_) claims엔 iat이 없어
    "얼마나 오래된 비밀번호인가"를 판별할 수 없다. password 분기 자체를 불허(맞는
    비밀번호를 제출해도 거부돼야 함)."""
    from app.core.security import hash_password

    user = _make_user(totp_enabled=True, totp_secret=pyotp.random_base32(), hashed_password=hash_password("correct"))
    client, _session, app = await _disable_client(include_iat=False)
    try:
        with patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)):
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/disable", json={"password": "correct"})
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "PASSWORD_REVERIFICATION_REQUIRES_SESSION"
        assert user.totp_enabled is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_disable_with_password_set_after_session_started_rejected():
    """카디르+codex 우회체인 최소방어선② — 실증된 공격 그대로: 탈취 세션(iat=T0) 안에서
    set-password로 방금(T1>T0) 비밀번호를 심고 그걸로 해제 시도 → 거부돼야 한다."""
    from app.core.security import hash_password

    session_started_at = int(time.time()) - 3600  # T0: 1시간 전 로그인
    password_set_at = datetime.now(timezone.utc)  # T1: 방금(세션보다 나중)
    user = _make_user(
        totp_enabled=True, totp_secret=pyotp.random_base32(),
        hashed_password=hash_password("just-planted"), password_set_at=password_set_at,
    )
    client, _session, app = await _disable_client(iat=session_started_at)
    try:
        with patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)):
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/disable", json={"password": "just-planted"})
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "PASSWORD_TOO_RECENT"
        assert user.totp_enabled is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_disable_with_password_set_before_session_started_succeeds():
    """양성대조 — password_set_at이 세션 iat보다 먼저면(정상적으로 오래 전에 설정된
    비밀번호) 해제가 정상 성공해야 한다(위 거부 로직이 과잉차단이 아님을 증명)."""
    from app.core.security import hash_password

    password_set_at = datetime.now(timezone.utc) - timedelta(days=30)  # 한 달 전
    session_started_at = int(time.time())  # 방금 로그인
    user = _make_user(
        totp_enabled=True, totp_secret=pyotp.random_base32(),
        hashed_password=hash_password("long-standing"), password_set_at=password_set_at,
    )
    client, _session, app = await _disable_client(iat=session_started_at)
    try:
        with patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)):
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/disable", json={"password": "long-standing"})
        assert resp.status_code == 200
        assert resp.json()["data"]["totp_enabled"] is False
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_disable_without_reverification_rejected():
    """양성대조(§AC3) — code·password 둘 다 없으면 400, 무인증 해제는 서버가 거부한다."""
    from app.core.security import hash_password

    user = _make_user(totp_enabled=True, totp_secret=pyotp.random_base32(), hashed_password=hash_password("pw"))
    client, _session, app = await _disable_client()
    try:
        with patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)):
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/disable", json={})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "REVERIFICATION_REQUIRED"
        assert user.totp_enabled is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_disable_when_not_enabled_rejected():
    from app.core.security import hash_password

    user = _make_user(totp_enabled=False, totp_secret=None, hashed_password=hash_password("pw"))
    client, _session, app = await _disable_client()
    try:
        with patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)):
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/disable", json={"password": "pw"})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "TOTP_NOT_ENABLED"
    finally:
        app.dependency_overrides.clear()
