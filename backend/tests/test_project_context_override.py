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
    """QA RC HIGH① 회귀 가드: has_project_access 최상위 WHERE 에 org 스코프 — team_members 분기
    cross-org 누수 차단(X-Project-Id 로 cross-org 주입 방지). 실 PG 로 cross-org 0행 실증함.

    story #1994 §5회차: `has_project_access`가 raw text() SQL(`"p.org_id = :org_id"` 리터럴
    소스 문자열 매칭 가능)에서 SQLAlchemy Core `_project_access_predicate`(atom-level SSOT,
    `project_access_valid_correlated`와 공유)로 이식됐다 — 소스 텍스트 grep 대신 컴파일된 SQL을
    직접 검사해 같은 불변식(org 스코프가 team_member 분기를 포함한 **모든 4개 EXISTS 분기보다
    앞선 최상위 WHERE**에 있다 — 특정 분기 안에만 있는 게 아니다)을 구조적으로 증명한다."""
    import uuid as _uuid

    from sqlalchemy.dialects import postgresql

    from app.services.project_auth import _project_access_predicate

    org_id = _uuid.uuid4()
    predicate = _project_access_predicate(_uuid.uuid4(), user_id=_uuid.uuid4(), org_id=org_id)
    compiled = predicate.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})
    sql = str(compiled)

    # 전체 predicate 자체가 최상위 `EXISTS(SELECT 1 FROM projects WHERE ...)` 래퍼이므로
    # sql은 "EXISTS"로 시작한다 — 그 최상위 WHERE 본문은 1번째와 2번째 "EXISTS"(첫 분기
    # 서브쿼리 진입) 사이 구간이다. org 스코프가 거기 있어야 "모든 분기 공통 가드"다(특정
    # 분기의 nested EXISTS 안에만 있으면 다른 분기는 여전히 무방비).
    top_level_where = sql.split("EXISTS")[1]
    assert "projects.org_id" in top_level_where, (
        "top-level(첫 EXISTS 분기 진입 전) WHERE에 projects.org_id 스코프가 없음 — QA RC HIGH① "
        f"회귀(team_members 분기 cross-org 누수 재발 위험) — {sql}"
    )


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
