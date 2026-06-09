"""bacefe2c 건1: register 201 응답에 email_delivered 플래그 노출 — 인증메일 발송실패 가시화.

register는 이메일 발송이 콘솔 폴백(미발송)이어도 201을 반환한다. 과거엔 logger.warning만 남기고
응답엔 아무 신호가 없어 FE가 "201인데 인증메일 안 옴"을 감지할 수 없었다(데모 signup 치명 경로).
이제 응답 data.email_delivered(bool)로 노출 — True=실발송, False=콘솔 폴백/미발송.
"""
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    mock_session = AsyncMock()
    mock_result = MagicMock()
    # 신규 가입 경로: _get_user_by_email/_build_app_metadata 조회 모두 None → 빈 메타데이터.
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

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


def _payload():
    # 충돌 방지용 유니크 이메일 — 가입 성공(201) 경로.
    return {
        "email": f"new-{uuid.uuid4().hex}@example.com",
        "password": "TestPass1!",
        "display_name": "Test User",
        "tos_accepted": True,
    }


@pytest.mark.anyio
async def test_register_email_delivered_true(monkeypatch):
    """send_email True(실발송) → 201 + data.email_delivered is True."""
    # register 내부 `from app.services.email import send_email` → patch 대상은 원본 모듈 심볼.
    monkeypatch.setattr("app.services.email.send_email", lambda **kwargs: True)
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.post("/api/v2/auth/register", json=_payload())
        assert resp.status_code == 201
        assert resp.json()["data"]["email_delivered"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_register_email_delivered_false(monkeypatch):
    """send_email False(콘솔 폴백·미발송) → 201 + data.email_delivered is False.

    silent swallow가 아니라 플래그로 미발송이 명시 노출됨을 확인(FE 감지·안내 가능).
    """
    monkeypatch.setattr("app.services.email.send_email", lambda **kwargs: False)
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.post("/api/v2/auth/register", json=_payload())
        assert resp.status_code == 201
        assert resp.json()["data"]["email_delivered"] is False
    finally:
        app.dependency_overrides.clear()
