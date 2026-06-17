from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal

from fastapi import Depends, Header, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session_factory
from app.core.security import JWTError, decode_jwt, hash_token
from app.dependencies.database import get_db

logger = logging.getLogger(__name__)

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

    # fire-and-forget last_used_at 업데이트
    api_key.last_used_at = now
    scope: list[str] = api_key.scope or ["read", "write"]

    # AC3-1: 신원 해소를 플래그로 cut. ⚠️ 생명선 — 0075 1:1(member.id=team_member.id)로
    # user_id 동일 = 무중단. 기본 off(레거시), 실 에이전트 무중단 실증 후 단계 on.
    from app.core.config import settings as _settings
    if _settings.member_ssot_apikey_cut:
        # anchor cut: members.id 기반. project_id는 agent_project_profiles 경유(ORDER BY 결정성).
        from app.models.member import AgentProjectProfile, Member
        m = (await db.execute(
            select(Member).where(
                Member.id == api_key.member_id,
                Member.type == "agent",
                Member.is_active.is_(True),
                Member.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
        if not m:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="API key member not found")
        proj = (await db.execute(
            select(AgentProjectProfile.project_id)
            .where(AgentProjectProfile.member_id == m.id)
            .order_by(AgentProjectProfile.created_at.asc())
            .limit(1)
        )).scalar_one_or_none()
        member_id = m.id
        org_id = str(m.org_id)
        project_id = str(proj) if proj else None
    else:
        # 레거시: team_members 경로.
        # team_members 는 0088 이후 projection VIEW라 멀티프로젝트 에이전트(org-level grant)는
        # 같은 id 로 프로젝트 수만큼 행을 낸다 → 무필터 scalar_one_or_none 은 MultipleResultsFound
        # 로 크래시. .limit(1)(order_by project_id 로 결정성)로 한 행만 취해 scalar_one_or_none 이
        # 절대 raise 하지 않게 한다(identity 해소). 단일 프로젝트 에이전트는 1행이라 거동 동일.
        # 실제 접근 가능 프로젝트 집합은 아래 accessible 로 별도 산출한다.
        member = (await db.execute(
            select(TeamMember)
            .where(TeamMember.id == api_key.team_member_id)
            .where(TeamMember.is_active.is_(True))
            .order_by(TeamMember.project_id)
            .limit(1)
        )).scalar_one_or_none()
        if not member:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="API key member not found")
        member_id = member.id
        org_id = str(member.org_id)
        project_id = str(member.project_id)

    # S1 (org-level 멀티프로젝트 에이전트): 키를 단일 project 에 핀하지 않는다. grant SSOT
    # (project_access)에서 접근 가능한 전 프로젝트 집합을 project_ids claim 으로 싣어, 키 1개가
    # org 내 허용 프로젝트 어디서든 인가받게 한다(has_project_access 와 lockstep SSOT). project_id
    # (단수)는 MCP 자동주입·레거시 호환을 위한 **기본 프로젝트**로만 유지(없으면 첫 accessible 폴백).
    # require_project_access 는 이 project_ids 를 읽어 정확히 게이트한다(현재 사용처 0 → 순수 additive).
    #
    # ⚠️ 생명선 보호: project_ids 산출은 **순수 additive** 이므로 어떤 이유로든(org_id 비-UUID·
    # 쿼리 실패 등) 예외가 나도 API key 인증 자체를 깨면 안 된다. try/except 로 격리하고 실패 시
    # 기본 project_id 만으로 폴백. 단일 project_id 핀(레거시)과 동치 → 무중단.
    project_ids: list[str] = []
    try:
        from app.services.project_auth import accessible_project_ids_in_org
        accessible = await accessible_project_ids_in_org(db, member_id, uuid.UUID(org_id))
        project_ids = [str(pid) for pid in accessible]
    except Exception:
        logger.warning("_resolve_api_key: project_ids 산출 실패 — 기본 project_id 폴백", exc_info=True)
    if project_id is None and project_ids:
        project_id = project_ids[0]
    # 방어(백필 갭·산출 실패): 기본 project_id 가 집합에 없더라도 자기 기본 프로젝트는 항상 포함 —
    # project_ids=[] 인데 project_id 가 set 인 모순(require_project_access 자기차단)을 차단.
    if project_id and project_id not in project_ids:
        project_ids.append(project_id)

    return AuthContext(
        user_id=str(member_id),
        email=None,
        claims={
            "sub": str(member_id),
            "app_metadata": {
                "org_id": org_id,
                "project_id": project_id,
                "project_ids": project_ids,
                "scope": scope,
                "api_key_id": str(api_key.id),
            },
        },
        org_id=org_id,
    )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    x_agent_api_key: str | None = Header(default=None, alias="x-agent-api-key"),
    db: AsyncSession = Depends(get_db),
) -> AuthContext:
    # x-agent-api-key 헤더 우선 처리 (SSE 브릿지 직접 연결용)
    if x_agent_api_key and x_agent_api_key.startswith("sk_live_"):
        return await _resolve_api_key(x_agent_api_key, db)

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


def _check_api_key_scope(auth: AuthContext, method: str, path: str | None = None) -> None:
    """API Key 경로일 때만 scope 체크 — JWT 사용자(웹 UI)는 미적용.

    1) Stage 1=레거시 scope(read/write) 한정 coarse read/write 게이팅. 툴그룹 scope 키
       (예 ['stories'])는 'write' 토큰이 없어 coarse 게이팅이 모든 write 를 잘못 403하므로
       (1d109a96 BYOA), 레거시 scope 를 보유한 키에만 적용한다. 툴그룹 키의 write 경계는
       Stage 2(path) 가 강제한다.
    2) 7b63c226: Stage 2=path→toolset group 서버사이드 강제 — 키 scope 외 그룹 엔드포인트 직접
       호출 차단(MCP 클라 우회 방어·진짜 boundary). always-allowed/미매핑 면제·일반키 무회귀.
    """
    if not auth.claims.get("app_metadata", {}).get("api_key_id"):
        return  # JWT 경로 → 스킵
    scope: list[str] = auth.claims.get("app_metadata", {}).get("scope", ["read", "write"])
    from app.services.mcp_toolset import _LEGACY_SCOPES
    # Stage 1: 레거시(read/write) scope 키에만 coarse 게이팅. 툴그룹 scope 키는 Stage 2(path)가 강제.
    if set(scope) & _LEGACY_SCOPES:
        required = "write" if method.upper() in _WRITE_METHODS else "read"
        if required not in scope:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"API Key scope '{required}' required",
            )
    if path is not None:
        from app.services.mcp_toolset import path_allowed_for_scope, path_to_tool_group
        if not path_allowed_for_scope(path, scope):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"API Key scope does not permit '{path_to_tool_group(path)}' tools",
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
        _check_api_key_scope(auth, request.method, request.url.path)

    jwt_org_id = auth.claims.get("app_metadata", {}).get("org_id")
    # X-Org-Id 헤더 우선 — org 전환 프리뷰(unified-switcher) 지원. 항상 membership 검증.
    raw = x_org_id or jwt_org_id
    if not raw:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="org_id required (X-Org-Id header or JWT app_metadata)",
        )
    try:
        org_id = uuid.UUID(str(raw))
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid org_id format")

    if x_org_id:
        # 헤더 사용 시 항상 membership 검증 (JWT org_id와 다를 수 있음)
        await _verify_org_membership(auth.user_id, org_id, db, request)

    # X-Project-Id 헤더 = per-request 프로젝트 스코프 **override**(d802da27/85614dd9).
    # JWT project_id 는 탭 공유라, 같은 유저가 여러 프로젝트 탭을 열어도 mutation 이 JWT 의 단일
    # project 로 잘못 바인딩된다(48 mutation 라우트가 app_metadata.project_id 를 직접 읽음). FE 가
    # 탭별로 보내는 X-Project-Id 를 JWT project_id 보다 **우선** 적용해 effective project 를
    # 교체한다 — 헤더 프로젝트를 app_metadata.project_id 에 써 downstream 전 라우트에 1점 반영.
    #
    # ⚠️ 보안 critical: 헤더 프로젝트는 **반드시 has_project_access 멤버십 검증**(team_member ∪
    # grant ∪ owner/admin). 미검증 시 헤더로 org 내 임의 프로젝트를 mutation 하는 권한상승 취약점.
    # (기존 코드는 JWT project_id 부재 시에만·_verify_project_in_org=project∈org 만 봐서 멤버 아닌
    # 프로젝트도 통과하던 갭.) 멤버십 미달이면 403.
    if x_project_id:
        try:
            header_project_id = uuid.UUID(x_project_id)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid X-Project-Id format")
        from app.services.project_auth import has_project_access
        if not await has_project_access(db, uuid.UUID(auth.user_id), header_project_id, org_id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="No access to the specified project",
            )
        auth.claims.setdefault("app_metadata", {})["project_id"] = str(header_project_id)

    return org_id


async def get_project_scoped_org_id(
    project_id: uuid.UUID | None = Query(default=None),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
) -> uuid.UUID:
    """project_id query param 으로 project 스코프 org_id를 해소.

    cross-org 접근(project 가 현재 스코프 org 와 다른 org 소속)은 **명시적으로 요청된 경우에만**
    허용한다: X-Org-Id 헤더가 그 org 를 지정하면 get_verified_org_id 가 base_org_id 를 해당
    org 로 멤버십 검증해 해소하므로 project_org_id 와 일치한다. 헤더 없이 들어온 cross-org
    project_id(JWT 스코프와 불일치)는 거부한다(403).

    has_project_access(team_member ∪ grant ∪ owner/admin) 로 project 멤버십 검증.
    project_id 가 없으면 get_verified_org_id 동작과 동일."""
    base_org_id = await get_verified_org_id(
        auth=auth, x_org_id=x_org_id, x_project_id=None, db=db, request=request
    )
    if not project_id:
        return base_org_id

    from app.models.project import Project
    result = await db.execute(
        select(Project.org_id).where(Project.id == project_id)
    )
    project_org_id = result.scalar_one_or_none()
    if not project_org_id:
        return base_org_id

    # c6b82459: cross-org re-entry 차단. project 가 현재 스코프 org(base_org_id)와 다른 org
    # 소속이면, 그 cross-org 가 X-Org-Id 헤더로 명시 요청된 경우에만 허용한다(헤더 지정 시
    # base_org_id 가 그 org 로 해소되어 일치). 헤더 없이 들어온 stale project_id(예: 0-project
    # org 로 switch 직후 옛 프로젝트 쿼리)는 거부하여, FE 가 옛 org 보드로 재진입하지 않고
    # EmptyState 를 렌더하도록 한다. (#1260 refresh 경로가 못 덮은 switch 직후 즉시경로 edge.)
    if project_org_id != base_org_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="요청한 org 스코프와 다른 org 의 프로젝트에 접근할 수 없습니다",
        )

    # E-MEMBER-SSOT AC2-2: "TeamMember 존재 = 인가" 대신 has_project_access SSOT로 전환.
    # team_member(active) ∪ project_access(granted) ∪ owner/admin org-wide 3-branch이므로
    #   - owner/admin은 rowless 접근 유지 (OSS fresh install, team_members 미생성 포함)
    #   - grant-only 휴먼(project_access)도 project 접근 허용 (740e3b7e 에픽403 해소)
    #   - 동일 org 내 다른 project 미멤버 우회 방지(project 스코프)는 그대로 유지
    from app.services.project_auth import has_project_access
    if not await has_project_access(db, uuid.UUID(auth.user_id), project_id, project_org_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="해당 프로젝트의 멤버가 아닌",
        )
    return project_org_id


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


RoleType = Literal["admin", "member", "viewer", "owner"]


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
    """admin 또는 owner role 전용 엔드포인트 가드."""
    role = auth.claims.get("app_metadata", {}).get("role", "member")
    if role not in ("admin", "owner"):
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


async def enforce_body_context(
    auth_org_id: uuid.UUID,
    body_org_id: uuid.UUID | None = None,
    body_project_id: uuid.UUID | None = None,
    auth_project_id: str | None = None,
    *,
    db: AsyncSession | None = None,
    user_id: uuid.UUID | None = None,
) -> None:
    """AC6/AC7: body의 org_id/project_id가 auth context와 일치하는지 검증.

    org_id: auth org와 불일치 시 403.
    project_id:
      - db+user_id 전달 시(create 라우터): **has_project_access SSOT 게이트** — JWT project_id 핀과
        무관하게 접근권(team_member ∪ grant ∪ owner/admin org-wide)만 있으면 통과. 740e3b7e:
        grant/admin이 JWT에 안 핀된(그러나 접근 가능한) 프로젝트서 epic/task/meeting/story/doc 생성 시
        나던 403 제거. 접근권 없으면 403 유지.
      - db 미전달 시(레거시/단위테스트): 기존 JWT project_id 정확일치 검증으로 폴백.
    """
    if body_org_id is not None and body_org_id != auth_org_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="body.org_id가 auth context와 불일치인")
    if body_project_id is None:
        return
    if db is not None and user_id is not None:
        from app.services.project_auth import has_project_access
        if not await has_project_access(db, user_id, body_project_id, auth_org_id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="해당 프로젝트 접근권이 없는")
        return
    # 레거시 폴백(db 미전달): JWT project_id 핀 정확일치
    if auth_project_id and str(body_project_id) != str(auth_project_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="body.project_id가 auth context와 불일치인")


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


# ─── SSE/스트림 전용 auth (커넥션 비점유) ──────────────────────────────────────
# P0 connection leak fix (#abaf6279):
# get_current_user/get_verified_org_id는 Depends(get_db)로 요청 수명 동안 세션을
# 점유한다. SSE 같은 long-lived 응답에서는 API key 해석의 team_members 쿼리가
# 연 커넥션이 yield 구간 내내 idle-in-transaction으로 잔존 → max_connections 포화.
# 아래 streaming 변형은 자체 단명 세션(async with)으로 즉시 닫아 미점유를 보장한다.


async def get_current_user_streaming(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    x_agent_api_key: str | None = Header(default=None, alias="x-agent-api-key"),
) -> AuthContext:
    """get_current_user의 SSE 전용 변형 — get_db 미점유.

    API key 경로는 자체 단명 세션으로 _resolve_api_key 후 즉시 close →
    스트림 yield 구간에 커넥션을 들고 있지 않음. JWT 경로는 DB 불필요(기존과 동일).
    """
    if x_agent_api_key and x_agent_api_key.startswith("sk_live_"):
        async with async_session_factory() as db:
            return await _resolve_api_key(x_agent_api_key, db)

    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Authorization header")

    token = credentials.credentials
    if token.startswith("sk_live_"):
        async with async_session_factory() as db:
            return await _resolve_api_key(token, db)

    try:
        payload = decode_jwt(token)
    except JWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc

    user_id: str | None = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token missing sub claim")

    return AuthContext(
        user_id=user_id,
        email=payload.get("email"),
        claims=payload,
        org_id=payload.get("app_metadata", {}).get("org_id"),
    )


async def get_verified_org_id_streaming(
    auth: AuthContext = Depends(get_current_user_streaming),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
    x_project_id: str | None = Header(default=None, alias="X-Project-Id"),
    request: Request = None,
) -> uuid.UUID:
    """get_verified_org_id의 SSE 전용 변형 — get_db 미점유.

    멤버십/프로젝트 검증이 필요한 경우에만 자체 단명 세션으로 검증 후 close.
    API key + claims org_id(헤더 없음) 경로는 DB 쿼리조차 없음.
    """
    if request is not None:
        _check_api_key_scope(auth, request.method, request.url.path)

    jwt_org_id = auth.claims.get("app_metadata", {}).get("org_id")
    raw = x_org_id or jwt_org_id
    if not raw:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="org_id required (X-Org-Id header or JWT app_metadata)",
        )
    try:
        org_id = uuid.UUID(str(raw))
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid org_id format")

    if x_org_id:
        async with async_session_factory() as db:
            await _verify_org_membership(auth.user_id, org_id, db, request)

    jwt_project_id = auth.claims.get("app_metadata", {}).get("project_id")
    if not jwt_project_id and x_project_id:
        try:
            project_id = uuid.UUID(x_project_id)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid X-Project-Id format")
        async with async_session_factory() as db:
            await _verify_project_in_org(project_id, org_id, db, request)

    return org_id
