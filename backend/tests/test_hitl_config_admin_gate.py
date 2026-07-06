"""prod 핫픽스(S20 전수스캔 HIGH, expire-stale 동형): hitl_config.py의 mutating 엔드포인트
전부가 org-admin 게이트 없이(``_auth`` 선언만) 열려있었다 — org 내 임의 멤버가 org 전체 HITL
gate posture를 바꾸거나 타 멤버의 override를 조작할 수 있었다. 각 엔드포인트에 admin 게이트를
추가 — 이 테스트는 그 게이트가 실제로 403을 내는지만 확인한다(200 경로는 기존 테스트가 커버).
"""
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
ROLE_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client_not_admin():
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


@pytest.mark.anyio
async def test_upsert_org_policy_403_when_not_org_admin():
    client, session, app = await _client_not_admin()
    try:
        with patch("app.routers.hitl_config._is_org_admin", new_callable=AsyncMock, return_value=False):
            async with client as c:
                resp = await c.put("/api/v2/gate-config/policy", json={"posture": "conservative"})
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_upsert_org_override_403_when_not_org_admin():
    client, session, app = await _client_not_admin()
    try:
        with patch("app.routers.hitl_config._is_org_admin", new_callable=AsyncMock, return_value=False):
            async with client as c:
                resp = await c.post("/api/v2/gate-config/overrides/org", json={
                    "role_id": str(ROLE_ID), "gate_type": "pr_review", "disposition": "allow_auto",
                })
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_org_override_403_when_not_org_admin():
    client, session, app = await _client_not_admin()
    try:
        with patch("app.routers.hitl_config._is_org_admin", new_callable=AsyncMock, return_value=False):
            async with client as c:
                resp = await c.delete(f"/api/v2/gate-config/overrides/org/{uuid.uuid4()}")
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_upsert_member_override_403_when_not_org_admin():
    client, session, app = await _client_not_admin()
    try:
        with patch("app.routers.hitl_config._is_org_admin", new_callable=AsyncMock, return_value=False):
            async with client as c:
                resp = await c.post("/api/v2/gate-config/overrides/member", json={
                    "member_id": str(MEMBER_ID), "gate_type": "pr_review", "disposition": "allow_auto",
                })
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_member_override_403_when_not_org_admin():
    client, session, app = await _client_not_admin()
    try:
        with patch("app.routers.hitl_config._is_org_admin", new_callable=AsyncMock, return_value=False):
            async with client as c:
                resp = await c.delete(f"/api/v2/gate-config/overrides/member/{uuid.uuid4()}")
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_upsert_org_policy_200_when_org_admin():
    from datetime import datetime, timezone

    client, session, app = await _client_not_admin()
    try:
        mock_r = MagicMock()
        mock_r.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_r)
        session.flush = AsyncMock()

        async def _fake_refresh(obj):
            obj.created_at = datetime.now(timezone.utc)
            obj.updated_at = datetime.now(timezone.utc)

        session.refresh = AsyncMock(side_effect=_fake_refresh)
        with patch("app.routers.hitl_config._is_org_admin", new_callable=AsyncMock, return_value=True):
            async with client as c:
                resp = await c.put("/api/v2/gate-config/policy", json={"posture": "conservative"})
        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()
