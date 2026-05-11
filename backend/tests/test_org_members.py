"""S22 AC: OrgMember router + repository 단위 테스트 (6건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()
CALLER_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()


def _mock_member(role: str = "member", user_id: uuid.UUID | None = None) -> MagicMock:
    m = MagicMock()
    m.id = MEMBER_ID
    m.org_id = ORG_ID
    m.user_id = user_id or USER_ID
    m.role = role
    m.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    m.deleted_at = None
    return m


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client(caller_role: str = "admin"):
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(CALLER_ID)
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

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app, ctx


@pytest.mark.anyio
async def test_list_org_members_200():
    client, session, app, _ = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_mock_member()]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/org-members")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["role"] == "member"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_org_member_201():
    client, session, app, _ = await _client()
    try:
        caller_admin = _mock_member("admin", user_id=CALLER_ID)
        new_member = _mock_member("member")

        with (
            patch("app.repositories.org_member.OrgMemberRepository.get_by_user", new_callable=AsyncMock) as mock_get_by_user,
            patch("app.repositories.org_member.OrgMemberRepository.create", new_callable=AsyncMock) as mock_create,
        ):
            mock_get_by_user.return_value = caller_admin
            mock_create.return_value = new_member

            async with client as c:
                resp = await c.post("/api/v2/org-members", json={
                    "org_id": str(ORG_ID),
                    "user_id": str(USER_ID),
                    "role": "member",
                })

        assert resp.status_code == 201
        assert resp.json()["user_id"] == str(USER_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_org_member_403_non_admin():
    """일반 멤버는 새 멤버 추가 불가."""
    client, session, app, _ = await _client()
    try:
        caller_member = _mock_member("member", user_id=CALLER_ID)

        with patch("app.repositories.org_member.OrgMemberRepository.get_by_user", new_callable=AsyncMock) as mock_get_by_user:
            mock_get_by_user.return_value = caller_member

            async with client as c:
                resp = await c.post("/api/v2/org-members", json={
                    "org_id": str(ORG_ID),
                    "user_id": str(USER_ID),
                    "role": "member",
                })

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_org_member_200():
    client, session, app, _ = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_member()
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/org-members/{MEMBER_ID}")

        assert resp.status_code == 200
        assert resp.json()["id"] == str(MEMBER_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_org_member_404():
    client, session, app, _ = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/org-members/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_role_200():
    client, session, app, _ = await _client()
    try:
        caller_admin = _mock_member("admin", user_id=CALLER_ID)
        updated = _mock_member("admin")

        with patch("app.repositories.org_member.OrgMemberRepository.get_by_user", new_callable=AsyncMock) as mock_get_by_user:
            mock_get_by_user.return_value = caller_admin

            mock_result = MagicMock()
            mock_result.scalar_one_or_none.return_value = updated
            session.execute = AsyncMock(return_value=mock_result)

            async with client as c:
                resp = await c.patch(f"/api/v2/org-members/{MEMBER_ID}", json={"role": "admin"})

        assert resp.status_code == 200
        assert resp.json()["role"] == "admin"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_role_403_non_admin():
    """일반 멤버는 role 변경 불가."""
    client, session, app, _ = await _client()
    try:
        caller_member = _mock_member("member", user_id=CALLER_ID)

        with patch("app.repositories.org_member.OrgMemberRepository.get_by_user", new_callable=AsyncMock) as mock_get_by_user:
            mock_get_by_user.return_value = caller_member

            async with client as c:
                resp = await c.patch(f"/api/v2/org-members/{MEMBER_ID}", json={"role": "admin"})

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_invalid_role_400():
    client, session, app, _ = await _client()
    try:
        caller_admin = _mock_member("admin", user_id=CALLER_ID)

        with patch("app.repositories.org_member.OrgMemberRepository.get_by_user", new_callable=AsyncMock) as mock_get_by_user:
            mock_get_by_user.return_value = caller_admin

            async with client as c:
                resp = await c.patch(f"/api/v2/org-members/{MEMBER_ID}", json={"role": "superuser"})

        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_soft_delete_200():
    client, session, app, _ = await _client()
    try:
        caller_admin = _mock_member("admin", user_id=CALLER_ID)

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            # call 1: router get(id) for existing check
            # call 2: revoke refresh tokens (UPDATE)
            # call 3: soft_delete internal get(id)
            # call 4: soft_delete UPDATE deleted_at
            result.scalar_one_or_none.return_value = _mock_member() if call_count in (1, 3) else None
            result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        with patch("app.repositories.org_member.OrgMemberRepository.get_by_user", new_callable=AsyncMock) as mock_get_by_user:
            mock_get_by_user.return_value = caller_admin

            async with client as c:
                resp = await c.delete(f"/api/v2/org-members/{MEMBER_ID}")

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_soft_delete_403_non_admin():
    """일반 멤버는 다른 멤버 삭제 불가."""
    client, session, app, _ = await _client()
    try:
        caller_member = _mock_member("member", user_id=CALLER_ID)

        with patch("app.repositories.org_member.OrgMemberRepository.get_by_user", new_callable=AsyncMock) as mock_get_by_user:
            mock_get_by_user.return_value = caller_member

            async with client as c:
                resp = await c.delete(f"/api/v2/org-members/{MEMBER_ID}")

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()
