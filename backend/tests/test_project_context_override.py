"""프로젝트 컨텍스트 mutation 안전(d802da27/85614dd9): get_verified_org_id 가 멤버십 검증된
X-Project-Id 를 JWT project_id 보다 우선(override) 적용하는지 + 권한상승 차단(403)."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth(org_id, project_id=None, user_id=None):
    from app.dependencies.auth import AuthContext

    meta = {"org_id": str(org_id)}
    if project_id is not None:
        meta["project_id"] = str(project_id)
    return AuthContext(
        user_id=str(user_id or uuid.uuid4()), email=None, claims={"app_metadata": meta}
    )


def _access_result(member: bool):
    """has_project_access 의 row.scalar_one_or_none() is not None 판정용."""
    r = MagicMock()
    r.scalar_one_or_none.return_value = 1 if member else None
    return r


@pytest.mark.anyio
async def test_x_project_id_overrides_jwt_when_member():
    """헤더 프로젝트 멤버십 OK → effective project 가 헤더로 override(JWT project_id 덮어씀)."""
    from app.dependencies.auth import get_verified_org_id

    org = uuid.uuid4()
    jwt_proj = uuid.uuid4()
    header_proj = uuid.uuid4()
    auth = _auth(org, project_id=jwt_proj)

    db = AsyncMock()
    db.execute = AsyncMock(return_value=_access_result(True))

    out = await get_verified_org_id(
        auth=auth, x_org_id=None, x_project_id=str(header_proj), db=db, request=None
    )
    assert out == org
    # downstream(48 라우트)이 읽는 app_metadata.project_id 가 헤더 프로젝트로 교체됨
    assert auth.claims["app_metadata"]["project_id"] == str(header_proj)


@pytest.mark.anyio
async def test_x_project_id_non_member_403_no_override():
    """헤더 프로젝트 멤버십 미달 → 403(권한상승 차단)·override 안 함."""
    from fastapi import HTTPException

    from app.dependencies.auth import get_verified_org_id

    org = uuid.uuid4()
    jwt_proj = uuid.uuid4()
    auth = _auth(org, project_id=jwt_proj)

    db = AsyncMock()
    db.execute = AsyncMock(return_value=_access_result(False))

    with pytest.raises(HTTPException) as ei:
        await get_verified_org_id(
            auth=auth, x_org_id=None, x_project_id=str(uuid.uuid4()), db=db, request=None
        )
    assert ei.value.status_code == 403
    assert auth.claims["app_metadata"]["project_id"] == str(jwt_proj)  # 미override


@pytest.mark.anyio
async def test_no_x_project_id_keeps_jwt_project_id():
    """헤더 없음 → JWT project_id 유지·멤버십 쿼리 미실행(무회귀)."""
    from app.dependencies.auth import get_verified_org_id

    org = uuid.uuid4()
    jwt_proj = uuid.uuid4()
    auth = _auth(org, project_id=jwt_proj)

    db = AsyncMock()
    db.execute = AsyncMock()

    out = await get_verified_org_id(
        auth=auth, x_org_id=None, x_project_id=None, db=db, request=None
    )
    assert out == org
    assert auth.claims["app_metadata"]["project_id"] == str(jwt_proj)
    db.execute.assert_not_called()


def test_has_project_access_has_toplevel_org_scope():
    """QA RC HIGH① 회귀 가드: has_project_access 최상위 WHERE 에 p.org_id 스코프 — team_members
    분기 cross-org 누수 차단(X-Project-Id 로 cross-org 주입 방지). 실 PG 로 cross-org 0행 실증함."""
    import inspect

    from app.services import project_auth

    src = inspect.getsource(project_auth.has_project_access)
    assert "p.org_id = :org_id" in src


@pytest.mark.anyio
async def test_x_project_id_invalid_format_400():
    from fastapi import HTTPException

    from app.dependencies.auth import get_verified_org_id

    org = uuid.uuid4()
    auth = _auth(org, project_id=uuid.uuid4())
    db = AsyncMock()
    db.execute = AsyncMock()

    with pytest.raises(HTTPException) as ei:
        await get_verified_org_id(
            auth=auth, x_org_id=None, x_project_id="not-a-uuid", db=db, request=None
        )
    assert ei.value.status_code == 400
