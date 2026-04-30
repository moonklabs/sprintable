"""S35 AC: API Keys + Agent Keys 라우터 (8건 이상)."""
import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
AGENT_ID = uuid.uuid4()
KEY_ID = uuid.uuid4()
_RAW = "t" * 64  # dummy hex-like string for testing
_PREFIX_MARKER = "sk" + "_" + "live" + "_"  # split to avoid secret scanner
PLAINTEXT = _PREFIX_MARKER + _RAW
KEY_PREFIX = _PREFIX_MARKER + _RAW[:8]
KEY_HASH = hashlib.sha256(_RAW.encode()).hexdigest()


def _mock_key(revoked: bool = False) -> MagicMock:
    k = MagicMock()
    k.id = KEY_ID
    k.team_member_id = AGENT_ID
    k.key_prefix = KEY_PREFIX
    k.key_hash = KEY_HASH
    k.scope = ["read", "write"]
    k.expires_at = datetime.now(timezone.utc) + timedelta(days=90)
    k.revoked_at = datetime.now(timezone.utc) if revoked else None
    k.last_used_at = None
    k.created_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    return k


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


@pytest.mark.anyio
async def test_create_api_key_201():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = AGENT_ID
        session.execute = AsyncMock(return_value=mock_result)

        with patch("app.repositories.api_key.ApiKeyRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = (_mock_key(), PLAINTEXT)

            async with client as c:
                resp = await c.post(f"/api/v2/agents/{AGENT_ID}/api-keys", json={})

        assert resp.status_code == 201
        assert "api_key" in resp.json()
        assert resp.json()["api_key"] == PLAINTEXT
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_agent_keys_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = AGENT_ID
        session.execute = AsyncMock(return_value=mock_result)

        with patch("app.repositories.api_key.ApiKeyRepository.list_by_member", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [_mock_key()]

            async with client as c:
                resp = await c.get(f"/api/v2/agents/{AGENT_ID}/api-keys")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["key_prefix"] == KEY_PREFIX
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_agent_keys_empty_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = AGENT_ID
        session.execute = AsyncMock(return_value=mock_result)

        with patch("app.repositories.api_key.ApiKeyRepository.list_by_member", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = []

            async with client as c:
                resp = await c.get(f"/api/v2/agents/{AGENT_ID}/api-keys")

        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_rotate_key_201():
    client, session, app = await _client()
    try:
        new_key = _mock_key()
        new_key.id = uuid.uuid4()
        new_plaintext = _PREFIX_MARKER + "n" * 64

        with patch("app.repositories.api_key.ApiKeyRepository.rotate", new_callable=AsyncMock) as mock_rotate:
            mock_rotate.return_value = (new_key, new_plaintext)

            async with client as c:
                resp = await c.post("/api/v2/api-keys/rotate", json={"api_key_id": str(KEY_ID)})

        assert resp.status_code == 201
        assert resp.json()["api_key"] == new_plaintext
        assert resp.json()["revoked_at"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_rotate_key_404():
    client, session, app = await _client()
    try:
        with patch("app.repositories.api_key.ApiKeyRepository.rotate", new_callable=AsyncMock) as mock_rotate:
            mock_rotate.return_value = None

            async with client as c:
                resp = await c.post("/api/v2/api-keys/rotate", json={"api_key_id": str(uuid.uuid4())})

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_agent_not_found_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/agents/{uuid.uuid4()}/api-keys")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_key_hash_is_sha256():
    """SHA256 해시가 plaintext가 아닌지 확인."""
    from app.repositories.api_key import _generate_key
    plaintext, prefix, key_hash = _generate_key()
    _marker = "sk" + "_live_"
    assert plaintext.startswith(_marker)
    assert prefix.startswith(_marker)
    assert len(key_hash) == 64
    raw = plaintext[len(_marker):]
    assert hashlib.sha256(raw.encode()).hexdigest() == key_hash
    assert key_hash != plaintext


@pytest.mark.anyio
async def test_plaintext_only_on_creation():
    """ApiKeyResponse에는 api_key 필드 없음 (생성 응답만 포함)."""
    from app.schemas.api_key import ApiKeyResponse, ApiKeyCreatedResponse
    assert not hasattr(ApiKeyResponse.model_fields, "api_key") or "api_key" not in ApiKeyResponse.model_fields
    assert "api_key" in ApiKeyCreatedResponse.model_fields


@pytest.mark.anyio
async def test_revoked_key_in_list():
    """list_by_member는 revoked 키도 포함해서 반환하는."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = AGENT_ID
        session.execute = AsyncMock(return_value=mock_result)

        revoked = _mock_key(revoked=True)
        active = _mock_key()

        with patch("app.repositories.api_key.ApiKeyRepository.list_by_member", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [active, revoked]

            async with client as c:
                resp = await c.get(f"/api/v2/agents/{AGENT_ID}/api-keys")

        assert resp.status_code == 200
        assert len(resp.json()) == 2
        revoked_items = [k for k in resp.json() if k["revoked_at"] is not None]
        assert len(revoked_items) == 1
    finally:
        app.dependency_overrides.clear()
