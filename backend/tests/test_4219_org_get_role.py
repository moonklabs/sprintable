"""story #4219 G2 — GET /organizations/{id}가 요청자 역할을 가산 필드로 돌려준다(소속 판정에 이미 구한 값 · 새 조회 0).
FE proxy가 /glance 307에 sp_resolve_cache(org·project·역할 서명 쿠키)를 심을 때 쓴다 — 역할이 없으면 안 심는다."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _org():
    now = datetime.now(UTC)
    return SimpleNamespace(
        id=uuid.uuid4(), name="Moonklabs", slug="moonklabs", plan="free", timezone=None, created_at=now, updated_at=now,
    )


@pytest.mark.anyio
async def test_get_organization_returns_requester_role():
    from app.routers.organizations import get_organization

    org = _org()
    repo = SimpleNamespace(get_member_role=AsyncMock(return_value="admin"), get=AsyncMock(return_value=org))
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))
    res = await get_organization(id=org.id, auth=auth, repo=repo)
    assert res.role == "admin"
    assert res.slug == "moonklabs"
    repo.get_member_role.assert_awaited_once()


@pytest.mark.anyio
async def test_get_organization_non_member_still_404():
    from app.routers.organizations import get_organization

    org = _org()
    repo = SimpleNamespace(get_member_role=AsyncMock(return_value=None), get=AsyncMock(return_value=org))
    with pytest.raises(HTTPException) as exc:
        await get_organization(id=org.id, auth=SimpleNamespace(user_id=str(uuid.uuid4())), repo=repo)
    assert exc.value.status_code == 404
