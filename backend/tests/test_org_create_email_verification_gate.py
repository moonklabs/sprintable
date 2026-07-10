"""SPR-13: org 생성의 email verification 요구를 설정으로 완화.

fresh 셀프호스트(이메일 provider 미설정)에서 org 생성이 403 "Email verification required"로
무조건 막히고, 콘솔 폴백은 인증 링크를 로그에 안 찍어 복구 경로가 없었다(온보딩 데드엔드).
`require_verified_email_for_org_create`(기본 True=호스티드 동작 보존)를 False 로 내리면
미인증 사용자도 org 를 만들 수 있다 — compose 가 False 를 기본 제공.
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_org():
    org = MagicMock()
    org.id = uuid.uuid4()
    org.name = "Fresh Org"
    org.slug = "fresh-org"
    org.plan = "free"
    org.created_at = datetime(2026, 7, 10, tzinfo=timezone.utc)
    org.updated_at = datetime(2026, 7, 10, tzinfo=timezone.utc)
    return org


async def _post_org(*, email_verified: bool, require_flag: bool):
    from app.core.config import settings
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from app.main import app
    from app.routers.organizations import _get_repo

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "unverified@test.local"
    ctx.claims = {"app_metadata": {}}

    user = MagicMock()
    user.email_verified = email_verified

    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(
        return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=user))
    )

    mock_repo = MagicMock()
    mock_repo.create = AsyncMock(return_value=_mock_org())

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    app.dependency_overrides[_get_repo] = lambda: mock_repo
    try:
        with patch.object(settings, "require_verified_email_for_org_create", require_flag):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                # owner_member_id 전달 → OSS bootstrap(org_members insert) 분기 미진입(단위 격리).
                return await client.post(
                    "/api/v2/organizations",
                    json={"name": "Fresh Org", "slug": "fresh-org",
                          "owner_member_id": str(uuid.uuid4())},
                )
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_unverified_blocked_when_flag_on():
    """기본값(True): 미인증 사용자는 403 — 호스티드/prod 동작 보존."""
    res = await _post_org(email_verified=False, require_flag=True)
    assert res.status_code == 403
    assert "Email verification required" in res.text


@pytest.mark.anyio
async def test_unverified_allowed_when_flag_off():
    """셀프호스트 완화(False): 미인증 사용자도 org 생성 가능 — 온보딩 데드엔드 해소."""
    res = await _post_org(email_verified=False, require_flag=False)
    assert res.status_code == 201, res.text
    assert res.json()["slug"] == "fresh-org"


@pytest.mark.anyio
async def test_verified_allowed_when_flag_on():
    """인증 사용자는 플래그와 무관하게 통과(회귀 가드)."""
    res = await _post_org(email_verified=True, require_flag=True)
    assert res.status_code == 201, res.text
