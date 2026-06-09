"""740e3b7e: enforce_body_context를 has_project_access SSOT로 — grant/admin 멀티프로젝트
create(epic/task/meeting/story/doc) 403 제거. JWT project_id 핀과 무관하게 접근권만 있으면 통과.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

ORG = uuid.uuid4()
USER = uuid.uuid4()
PROJ = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_grant_access_passes_despite_jwt_pin_mismatch():
    """db+user_id 전달 + has_project_access TRUE → JWT project_id가 달라도 403 없음(grant/admin)."""
    from app.dependencies.auth import enforce_body_context

    db = AsyncMock()
    with patch("app.services.project_auth.has_project_access", new=AsyncMock(return_value=True)):
        # auth_project_id(JWT 핀)는 전혀 다른 프로젝트지만 통과해야
        await enforce_body_context(
            auth_org_id=ORG, body_org_id=ORG, body_project_id=PROJ,
            auth_project_id=str(uuid.uuid4()), db=db, user_id=USER,
        )
    # 예외 없이 통과 = PASS


@pytest.mark.anyio
async def test_no_access_raises_403():
    """db+user_id + has_project_access FALSE → 403."""
    from app.dependencies.auth import enforce_body_context

    db = AsyncMock()
    with patch("app.services.project_auth.has_project_access", new=AsyncMock(return_value=False)):
        with pytest.raises(HTTPException) as ei:
            await enforce_body_context(
                auth_org_id=ORG, body_org_id=ORG, body_project_id=PROJ,
                auth_project_id=str(PROJ), db=db, user_id=USER,
            )
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_org_mismatch_403():
    from app.dependencies.auth import enforce_body_context

    with pytest.raises(HTTPException) as ei:
        await enforce_body_context(
            auth_org_id=ORG, body_org_id=uuid.uuid4(), body_project_id=None,
        )
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_legacy_no_db_falls_back_to_jwt_pin():
    """db 미전달(레거시/단위테스트) → 기존 JWT project_id 정확일치 폴백 유지."""
    from app.dependencies.auth import enforce_body_context

    # 일치 → OK
    await enforce_body_context(auth_org_id=ORG, body_project_id=PROJ, auth_project_id=str(PROJ))
    # 불일치 → 403
    with pytest.raises(HTTPException) as ei:
        await enforce_body_context(auth_org_id=ORG, body_project_id=PROJ, auth_project_id=str(uuid.uuid4()))
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_no_project_id_only_org_check():
    """body_project_id 없으면 org 체크만(예: task)."""
    from app.dependencies.auth import enforce_body_context

    db = AsyncMock()
    # has_project_access 호출 안 되어야(project_id None)
    with patch("app.services.project_auth.has_project_access", new=AsyncMock(side_effect=AssertionError("should not call"))):
        await enforce_body_context(auth_org_id=ORG, body_org_id=ORG, body_project_id=None, db=db, user_id=USER)
