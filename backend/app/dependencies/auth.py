from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import JWTError, decode_jwt, hash_token
from app.dependencies.database import get_db

bearer_scheme = HTTPBearer(auto_error=False)


@dataclass
class AuthContext:
    user_id: str
    email: str | None
    claims: dict
    org_id: str | None = field(default=None)


async def _resolve_api_key(raw_key: str, db: AsyncSession) -> AuthContext:
    """sk_live_* API key를 DB에서 조회하여 AuthContext 반환."""
    from app.models.api_key import ApiKey
    from app.models.team import TeamMember

    key_hash = hash_token(raw_key)
    now = datetime.now(timezone.utc)

    result = await db.execute(
        select(ApiKey)
        .where(ApiKey.key_hash == key_hash)
        .where(ApiKey.revoked_at.is_(None))
        .where((ApiKey.expires_at.is_(None)) | (ApiKey.expires_at > now))
    )
    api_key = result.scalar_one_or_none()
    if not api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key")

    member_result = await db.execute(
        select(TeamMember)
        .where(TeamMember.id == api_key.team_member_id)
        .where(TeamMember.is_active.is_(True))
    )
    member = member_result.scalar_one_or_none()
    if not member:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="API key member not found")

    # fire-and-forget last_used_at 업데이트
    api_key.last_used_at = now

    scope: list[str] = api_key.scope or ["read", "write"]
    org_id = str(member.org_id)
    project_id = str(member.project_id)

    return AuthContext(
        user_id=str(member.id),
        email=None,
        claims={
            "sub": str(member.id),
            "app_metadata": {
                "org_id": org_id,
                "project_id": project_id,
                "scope": scope,
                "api_key_id": str(api_key.id),
            },
        },
        org_id=org_id,
    )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> AuthContext:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Authorization header")

    token = credentials.credentials

    # sk_live_* prefix → API key 경로 (DB 조회)
    if token.startswith("sk_live_"):
        return await _resolve_api_key(token, db)

    # JWT 경로 (기존)
    try:
        payload = decode_jwt(token)
    except JWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc

    user_id: str | None = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token missing sub claim")

    org_id: str | None = payload.get("app_metadata", {}).get("org_id")

    return AuthContext(
        user_id=user_id,
        email=payload.get("email"),
        claims=payload,
        org_id=org_id,
    )


# ─── Scope dependencies ───────────────────────────────────────────────────────

async def _verify_org_membership(
    user_id: str,
    org_id: uuid.UUID,
    db: AsyncSession,
    request: Request,
) -> None:
    """caller가 org 멤버인지 DB 조회 — request.state 캐시로 N+1 방지."""
    cache_key = f"_org_mbr_{user_id}_{org_id}"
    cached = getattr(request.state, cache_key, None)
    if cached is True:
        return
    if cached is False:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="해당 조직의 멤버가 아닌",
        )

    from app.models.project import OrgMember

    result = await db.execute(
        select(OrgMember.id).where(
            OrgMember.org_id == org_id,
            OrgMember.user_id == uuid.UUID(user_id),
            OrgMember.deleted_at.is_(None),
        )
    )
    is_member = result.scalar_one_or_none() is not None
    setattr(request.state, cache_key, is_member)
    if not is_member:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="해당 조직의 멤버가 아닌",
        )


_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _check_api_key_scope(auth: AuthContext, method: str) -> None:
    """API Key 경로일 때만 scope 체크 — JWT 사용자(웹 UI)는 미적용."""
    if not auth.claims.get("app_metadata", {}).get("api_key_id"):
        return  # JWT 경로 → 스킵
    scope: list[str] = auth.claims.get("app_metadata", {}).get("scope", ["read", "write"])
    required = "write" if method.upper() in _WRITE_METHODS else "read"
    if required not in scope:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"API Key scope '{required}' required",
        )


def require_api_scope(required_scope: str):
    """특정 scope를 명시적으로 요구하는 dependency factory."""
    def _check(auth: AuthContext = Depends(get_current_user)) -> None:
        if not auth.claims.get("app_metadata", {}).get("api_key_id"):
            return  # JWT 사용자 → 스킵
        scope: list[str] = auth.claims.get("app_metadata", {}).get("scope", ["read", "write"])
        if required_scope not in scope:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"API Key scope '{required_scope}' required",
            )
    return _check


async def get_verified_org_id(
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
    x_project_id: str | None = Header(default=None, alias="X-Project-Id"),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
) -> uuid.UUID:
    """org_id 추출 — X-Org-Id 헤더 fallback 시 DB membership 검증, X-Project-Id 헤더 시 project 소속 검증.
    API Key 경로는 HTTP method 기반 scope 자동 체크."""
    # API Key scope 체크 (request 있을 때만 — 직접 단위 테스트 호출 시 스킵)
    if request is not None:
        _check_api_key_scope(auth, request.method)

    jwt_org_id = auth.claims.get("app_metadata", {}).get("org_id")
    raw = jwt_org_id or x_org_id
    if not raw:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="org_id required (X-Org-Id header or JWT app_metadata)",
        )
    try:
        org_id = uuid.UUID(str(raw))
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid org_id format")

    if not jwt_org_id and x_org_id:
        # 헤더 fallback 사용 시에만 membership 검증 — JWT org_id는 발급 시 검증됨
        await _verify_org_membership(auth.user_id, org_id, db, request)

    jwt_project_id = auth.claims.get("app_metadata", {}).get("project_id")
    if not jwt_project_id and x_project_id:
        # X-Project-Id 헤더 fallback 사용 시 해당 project가 org에 속하는지 검증
        try:
            project_id = uuid.UUID(x_project_id)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid X-Project-Id format")
        await _verify_project_in_org(project_id, org_id, db, request)

    return org_id


def get_org_scope(
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> uuid.UUID:
    """org_id를 JWT app_metadata 또는 X-Org-Id 헤더에서 추출. 없으면 400."""
    raw = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not raw:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="org_id required (JWT app_metadata.org_id or X-Org-Id header)",
        )
    try:
        return uuid.UUID(str(raw))
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid org_id format")


RoleType = Literal["admin", "member", "viewer"]


def require_role(*allowed_roles: RoleType):
    """JWT app_metadata.role이 허용 역할 중 하나인지 검증하는 dependency factory."""
    def _check(auth: AuthContext = Depends(get_current_user)) -> AuthContext:
        role = auth.claims.get("app_metadata", {}).get("role", "member")
        if role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{role}' not allowed. Required: {list(allowed_roles)}",
            )
        return auth
    return _check


def require_admin(auth: AuthContext = Depends(get_current_user)) -> AuthContext:
    """admin role 전용 엔드포인트 가드."""
    role = auth.claims.get("app_metadata", {}).get("role", "member")
    if role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required",
        )
    return auth


def require_project_access(
    project_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
) -> uuid.UUID:
    """JWT app_metadata.project_ids에 project_id가 포함되어 있는지 검증.
    project_ids 클레임이 없으면(레거시 토큰) 통과 — Phase C 전환 기간 호환."""
    project_ids = auth.claims.get("app_metadata", {}).get("project_ids")
    if project_ids is not None:
        if str(project_id) not in [str(pid) for pid in project_ids]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Access to project {project_id} denied",
            )
    return project_id


async def _verify_project_in_org(
    project_id: uuid.UUID,
    org_id: uuid.UUID,
    db: AsyncSession,
    request: Request,
) -> None:
    """project가 org에 속하는지 DB 조회 — request.state 캐시로 N+1 방지."""
    cache_key = f"_proj_in_org_{project_id}_{org_id}"
    cached = getattr(request.state, cache_key, None)
    if cached is True:
        return
    if cached is False:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="해당 조직에 속하지 않는 프로젝트인",
        )

    from app.models.project import Project

    result = await db.execute(
        select(Project.id).where(
            Project.id == project_id,
            Project.org_id == org_id,
            Project.deleted_at.is_(None),
        )
    )
    exists = result.scalar_one_or_none() is not None
    setattr(request.state, cache_key, exists)
    if not exists:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="해당 조직에 속하지 않는 프로젝트인",
        )


async def get_scope_context(
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
    x_project_id: str | None = Header(default=None, alias="X-Project-Id"),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
) -> dict:
    """org_id + project_id 컨텍스트를 한번에 추출 — 헤더 fallback 시 membership/소속 검증."""
    # x_project_id를 get_verified_org_id에 전달해서 project 소속 검증도 위임
    org_id = await get_verified_org_id(auth=auth, x_org_id=x_org_id, x_project_id=x_project_id, db=db, request=request)
    jwt_project_id = auth.claims.get("app_metadata", {}).get("project_id")
    project_id_raw = jwt_project_id or x_project_id
    project_id = uuid.UUID(str(project_id_raw)) if project_id_raw else None
    return {"org_id": org_id, "project_id": project_id, "user_id": auth.user_id}
