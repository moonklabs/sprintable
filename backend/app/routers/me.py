import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select, text
from sqlalchemy import update as sa_update
from sqlalchemy.orm import joinedload
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.member import Member
from app.models.project import OrgMember
from app.models.team import TeamMember
from app.models.user import User
from app.schemas.me import MeResponse, UpdateMe

router = APIRouter(prefix="/api/v2/me", tags=["me"])


@router.get("", response_model=MeResponse)
async def get_me(
    member_id: uuid.UUID | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> MeResponse:
    uid = uuid.UUID(auth.user_id)
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))

    if member_id:
        # S20(authz-coverage 스캐너 발견 — update_me엔 있는 self-check가 이 GET엔 없었다):
        # 명시 member_id가 caller 본인일 때만 매칭 — 아니면 임의 member의 email 등 PII를
        # 그대로 반환하던 갭(MeResponse.email 노출).
        if is_api_key:
            where_clause = (TeamMember.id == member_id) & (TeamMember.id == uid)
        else:
            where_clause = (TeamMember.id == member_id) & (TeamMember.user_id == uid)
    elif is_api_key:
        # API key 인증: auth.user_id = TeamMember.id
        where_clause = TeamMember.id == uid
    else:
        # JWT 인증: auth.user_id = user.id = TeamMember.user_id
        # app_metadata.project_id로 멀티프로젝트 유저 분기 필수
        project_id_str = auth.claims.get("app_metadata", {}).get("project_id")
        if project_id_str:
            try:
                project_id = uuid.UUID(project_id_str)
                where_clause = (TeamMember.user_id == uid) & (TeamMember.project_id == project_id)
            except (ValueError, AttributeError):
                where_clause = TeamMember.user_id == uid
        else:
            where_clause = TeamMember.user_id == uid

    result = await session.execute(
        select(TeamMember)
        .options(joinedload(TeamMember.project))
        .where(where_clause)
    )
    member = result.scalars().first()

    if member is None and not is_api_key and not member_id:
        # fallback: org_members 기반 응답 — human TM 없는 org-members-only 환경 (E-ENTITY-CLEANUP S5 이후)
        org_id_str = auth.claims.get("app_metadata", {}).get("org_id")
        project_id_str = auth.claims.get("app_metadata", {}).get("project_id")
        if org_id_str:
            om_result = await session.execute(
                select(OrgMember).where(
                    OrgMember.org_id == uuid.UUID(org_id_str),
                    OrgMember.user_id == uid,
                    OrgMember.deleted_at.is_(None),
                )
            )
            org_member = om_result.scalar_one_or_none()
            if org_member:
                user_result = await session.execute(select(User).where(User.id == uid))
                user = user_result.scalar_one_or_none()
                # E-ONBOARDING S2: display_name 우선, 없을 때만 email (기존 무조건 email → 실명 반영)
                name = (user.display_name or user.email) if user else str(uid)
                try:
                    proj_id = uuid.UUID(project_id_str) if project_id_str else org_member.org_id
                except (ValueError, AttributeError):
                    proj_id = org_member.org_id
                return MeResponse(
                    id=org_member.id,
                    org_id=org_member.org_id,
                    project_id=proj_id,
                    user_id=uid,
                    name=name,
                    email=user.email if user else None,
                    type="human",
                    role=org_member.role,
                    is_active=True,
                    has_password=bool(user.hashed_password) if user else None,
                )

    if member is None:
        raise HTTPException(status_code=404, detail="Member not found")

    data = MeResponse.model_validate(member)
    data.project_name = member.project.name if member.project else None
    data.user_id = member.user_id

    if not is_api_key and member.user_id:
        user_result = await session.execute(select(User).where(User.id == member.user_id))
        user = user_result.scalar_one_or_none()
        if user:
            data.has_password = bool(user.hashed_password)
            data.email = user.email  # E-ONBOARDING S2: User.email 노출

    # S-MBR-03: org owner/admin → effective role 상속. /me role이 JWT role과 일치하도록.
    if not is_api_key and member.user_id:
        _ROLE_RANK: dict[str, int] = {"owner": 4, "admin": 3, "manager": 2, "member": 1}
        org_role_result = await session.execute(
            select(OrgMember.role).where(
                OrgMember.org_id == member.org_id,
                OrgMember.user_id == member.user_id,
                OrgMember.deleted_at.is_(None),
            )
        )
        org_role = org_role_result.scalar_one_or_none()
        if org_role and _ROLE_RANK.get(org_role, 0) > _ROLE_RANK.get(data.role, 0):
            data = data.model_copy(update={"role": org_role})

    return data


@router.get("/memberships")
async def get_my_memberships(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> list[dict]:
    """현재 사용자가 접근할 수 있는 프로젝트 목록 (스위처 소스).

    S-MBR-FIX: TeamMember 기반 ∪ ProjectAccess grant 기반 ∪ owner/admin org 전체.
    members.py list_members grant 패턴(S-MBR-10) 정합.
    """
    current_org_id: str | None = auth.claims.get("app_metadata", {}).get("org_id")
    # uuid.UUID 객체로 바인딩 — asyncpg text() + ::uuid 캐스트가 syntax error를 유발하므로
    # CAST() 또는 파라미터 타입 지정 대신 Python uuid.UUID 객체로 직접 바인딩함 (S-MBR-FIX)
    user_id_param = uuid.UUID(auth.user_id)
    org_id_param: uuid.UUID | None = uuid.UUID(current_org_id) if current_org_id else None

    rows = await session.execute(
        text(
            """
            SELECT DISTINCT p.id::text AS project_id, p.name AS project_name
            FROM projects p
            WHERE p.deleted_at IS NULL
              AND (CAST(:org_id AS uuid) IS NULL OR p.org_id = :org_id)
              AND (
                -- 1. TeamMember 직접 등록 (기존)
                EXISTS (
                    SELECT 1 FROM team_members tm
                    WHERE tm.project_id = p.id
                      AND (tm.id = :user_id OR tm.user_id = :user_id)
                      AND tm.is_active = true
                      AND tm.type = 'human'
                )
                -- 2. ProjectAccess grant (S-MBR-10, members.py 패턴 정합)
                OR EXISTS (
                    SELECT 1 FROM project_access pa
                    JOIN org_members om ON pa.org_member_id = om.id
                    WHERE pa.project_id = p.id
                      AND om.user_id = :user_id
                      AND om.deleted_at IS NULL
                      AND pa.permission = 'granted'
                      AND (CAST(:org_id AS uuid) IS NULL OR om.org_id = :org_id)
                )
                -- 3. owner/admin은 grant 없이도 org 전체 (AC2, S-MBR-03 정합)
                OR EXISTS (
                    SELECT 1 FROM org_members om
                    WHERE om.user_id = :user_id
                      AND om.deleted_at IS NULL
                      AND om.role IN ('owner', 'admin')
                      AND (CAST(:org_id AS uuid) IS NULL OR om.org_id = :org_id)
                      AND p.org_id = om.org_id
                )
              )
            ORDER BY project_name
            """
        ),
        {"user_id": user_id_param, "org_id": org_id_param},
    )
    return [
        {"projectId": row.project_id, "projectName": row.project_name}
        for row in rows
    ]


@router.patch("", response_model=MeResponse)
async def update_me(
    body: UpdateMe,
    member_id: uuid.UUID | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> MeResponse:
    # E-ONBOARDING S1: 타겟 member를 auth에서 파생 — client Query 강제 제거(누락 시 422 해소).
    #   member_id를 명시해도 **본인 소유 member만** 매칭(ownership 강제 — 남의 프로필 변경 차단).
    uid = uuid.UUID(auth.user_id)
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))

    if member_id is not None:
        # 명시 member_id는 호출자 본인 것일 때만 (api_key=TeamMember.id 본인, JWT=user_id 본인)
        if is_api_key:
            where_clause = (TeamMember.id == member_id) & (TeamMember.id == uid)
        else:
            where_clause = (TeamMember.id == member_id) & (TeamMember.user_id == uid)
    elif is_api_key:
        where_clause = TeamMember.id == uid
    else:
        project_id_str = auth.claims.get("app_metadata", {}).get("project_id")
        if project_id_str:
            try:
                where_clause = (TeamMember.user_id == uid) & (TeamMember.project_id == uuid.UUID(project_id_str))
            except (ValueError, AttributeError):
                where_clause = TeamMember.user_id == uid
        else:
            where_clause = TeamMember.user_id == uid

    # AC3-5 ②: team_members가 뷰(0088) — multi-row 안전(휴먼 multi-project) .limit(1).first().
    result = await session.execute(
        select(TeamMember).where(where_clause).limit(1)
    )
    member = result.scalars().first()

    if member is None and not is_api_key and member_id is None:
        # a1580005: team_member 행이 없는 org-member(휴먼)도 프로필 이름을 갱신할 수 있게
        # GET /me 와 동일한 org_members 폴백을 적용. 기존엔 GET 만 폴백이 있고 PATCH 는 없어
        # "프로필 Name 변경 시 /api/me 404" 비대칭 버그가 있었다. canonical members.name 과
        # GET 폴백 표시 소스(users.display_name)를 함께 갱신해 모든 표면 정합.
        org_id_str = auth.claims.get("app_metadata", {}).get("org_id")
        project_id_str = auth.claims.get("app_metadata", {}).get("project_id")
        if org_id_str:
            org_member = (await session.execute(
                select(OrgMember).where(
                    OrgMember.org_id == uuid.UUID(org_id_str),
                    OrgMember.user_id == uid,
                    OrgMember.deleted_at.is_(None),
                )
            )).scalar_one_or_none()
            if org_member is not None:
                # GET 폴백이 읽는 표시 소스
                await session.execute(
                    sa_update(User).where(User.id == uid).values(display_name=body.name)
                )
                # canonical members 앵커(있으면) — chat/list_members 등 정합 (best-effort, 0 rows ok)
                await session.execute(
                    sa_update(Member).where(
                        Member.user_id == uid,
                        Member.org_id == uuid.UUID(org_id_str),
                        Member.type == "human",
                        Member.deleted_at.is_(None),
                    ).values(name=body.name, updated_at=func.now())
                )
                user = (await session.execute(
                    select(User).where(User.id == uid)
                )).scalar_one_or_none()
                try:
                    proj_id = uuid.UUID(project_id_str) if project_id_str else org_member.org_id
                except (ValueError, AttributeError):
                    proj_id = org_member.org_id
                return MeResponse(
                    id=org_member.id,
                    org_id=org_member.org_id,
                    project_id=proj_id,
                    user_id=uid,
                    name=body.name,
                    email=user.email if user else None,
                    type="human",
                    role=org_member.role,
                    is_active=True,
                    has_password=bool(user.hashed_password) if user else None,
                )

    if member is None:
        # 본인 소유가 아니거나 미존재 — 존재 여부 누설 없이 404
        raise HTTPException(status_code=404, detail="Member not found")
    target_id = member.id
    # AC3-5 ②: 뷰는 write 불가 — ORM mutation+flush 대신 name을 members 앵커에 UPDATE. expire 후 뷰 재조회.
    await session.execute(
        sa_update(Member).where(Member.id == target_id).values(name=body.name, updated_at=func.now())
    )
    session.expire(member)
    refreshed = (await session.execute(
        select(TeamMember).where(TeamMember.id == target_id).limit(1)
    )).scalars().first()
    return MeResponse.model_validate(refreshed or member)
