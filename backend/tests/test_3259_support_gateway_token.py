"""story #3259(지원v1·1경계) — POST /api/v2/support/session-token. 이 엔드포인트가 발급하는
클레임이 {org_id, user_id, exp, iat}로 딱 고정돼 있는지, 시크릿 미설정 시 fail-closed(503)인지만
검증한다 — support-gateway 쪽 검증 로직은 support-gateway/tests/에서 별도로 검증한다(물리
분리 서비스라 이 backend 테스트 스위트에서 그쪽을 import하지 않는다)."""
from __future__ import annotations

import uuid

import pytest
from jose import jwt as jose_jwt


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def _client(*, org_id: str | None, secret: str, monkeypatch):
    from app.core.config import settings
    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app

    monkeypatch.setattr(settings, "support_gateway_token_secret", secret)

    ctx = AuthContext(user_id=str(uuid.uuid4()), email=None, claims={}, org_id=org_id)

    async def override_auth():
        return ctx

    app.dependency_overrides[get_current_user] = override_auth
    from httpx import ASGITransport, AsyncClient

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.anyio
async def test_issues_token_with_exactly_expected_claims(monkeypatch):
    org_id = str(uuid.uuid4())
    secret = "test-secret-padded-to-32-bytes-min"
    async with await _client(org_id=org_id, secret=secret, monkeypatch=monkeypatch) as ac:
        resp = await ac.post("/api/v2/support/session-token")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    claims = jose_jwt.decode(body["token"], secret, algorithms=["HS256"])
    assert set(claims.keys()) == {"org_id", "user_id", "exp", "iat"}
    assert claims["org_id"] == org_id
    from app.main import app
    app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_missing_secret_fails_closed(monkeypatch):
    async with await _client(org_id=str(uuid.uuid4()), secret="", monkeypatch=monkeypatch) as ac:
        resp = await ac.post("/api/v2/support/session-token")
    assert resp.status_code == 503
    from app.main import app
    app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_no_org_context_rejected(monkeypatch):
    async with await _client(org_id=None, secret="test-secret-padded-to-32-bytes-min", monkeypatch=monkeypatch) as ac:
        resp = await ac.post("/api/v2/support/session-token")
    assert resp.status_code == 400
    from app.main import app
    app.dependency_overrides.clear()
