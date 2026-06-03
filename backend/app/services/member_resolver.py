"""E-MEMBER-SSOT Phase 0: JWT 휴먼 → org_member.id, API키 에이전트 → team_member.id.

ResolvedMember를 conversations/events 전반에 사용해 team_member 강요를 제거.
가역 패치 — 롤백 시 리졸버 교체 + migration downgrade.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext
from app.models.project import OrgMember
from app.models.team import TeamMember
from app.models.user import User
from app.services.project_auth import has_project_access


@dataclass
class ResolvedMember:
    """통합 멤버 신원 — 휴먼(org_member.id) 또는 에이전트(team_member.id)."""
    id: uuid.UUID
    user_id: uuid.UUID | None      # users.id (휴먼) | None (에이전트)
    name: str
    type: str                      # "human" | "agent"
    role: str
    org_id: uuid.UUID
    project_id: uuid.UUID | None = field(default=None)
    avatar_url: str | None = field(default=None)


async def resolve_member(
    auth: AuthContext,
    org_id: uuid.UUID,
    session: AsyncSession,
    project_id: uuid.UUID | None = None,
) -> ResolvedMember:
    """멤버 신원 해소 — 인증 방식에 따라 분기.

    API키(에이전트): team_member.id 반환.
    JWT(휴먼): org_member.id 반환 + has_project_access 검증.
    """
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))

    if is_api_key:
        tm = (await session.execute(
            select(TeamMember).where(TeamMember.id == uuid.UUID(auth.user_id))
        )).scalars().first()
        if tm is None:
            raise HTTPException(status_code=400, detail="Team member not found")
        return ResolvedMember(
            id=tm.id,
            user_id=None,
            name=tm.name,
            type=tm.type,
            role=tm.role,
            org_id=tm.org_id,
            project_id=tm.project_id,
        )

    # JWT 휴먼
    user_id = uuid.UUID(auth.user_id)

    if project_id is not None:
        if not await has_project_access(session, user_id, project_id, org_id):
            raise HTTPException(status_code=403, detail="No access to this project")

    om = (await session.execute(
        select(OrgMember).where(
            OrgMember.org_id == org_id,
            OrgMember.user_id == user_id,
            OrgMember.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if om is None:
        raise HTTPException(status_code=400, detail="Organization member not found")

    user = (await session.execute(
        select(User).where(User.id == user_id)
    )).scalar_one_or_none()
    name = user.email if user else str(user_id)

    return ResolvedMember(
        id=om.id,
        user_id=user_id,
        name=name,
        type="human",
        role=om.role,
        org_id=om.org_id,
        project_id=project_id,
    )


async def lookup_members_by_ids(
    ids: set[uuid.UUID],
    session: AsyncSession,
) -> dict[uuid.UUID, ResolvedMember]:
    """ID 집합 → ResolvedMember 맵. TeamMember 우선, 없으면 OrgMember."""
    if not ids:
        return {}

    tms = (await session.execute(
        select(TeamMember).where(TeamMember.id.in_(ids))
    )).scalars().all()
    result: dict[uuid.UUID, ResolvedMember] = {
        m.id: ResolvedMember(
            id=m.id, user_id=m.user_id, name=m.name,
            type=m.type, role=m.role, org_id=m.org_id, project_id=m.project_id,
        )
        for m in tms
    }

    missing = ids - set(result.keys())
    if missing:
        oms = (await session.execute(
            select(OrgMember).where(OrgMember.id.in_(missing))
        )).scalars().all()
        # OrgMember의 display name: user.email 배치 조회
        user_ids = {m.user_id for m in oms if m.user_id}
        users_map: dict[uuid.UUID, str] = {}
        if user_ids:
            users = (await session.execute(
                select(User).where(User.id.in_(user_ids))
            )).scalars().all()
            users_map = {u.id: u.email for u in users}

        for om in oms:
            result[om.id] = ResolvedMember(
                id=om.id,
                user_id=om.user_id,
                name=users_map.get(om.user_id, str(om.user_id)) if om.user_id else str(om.id),
                type="human",
                role=om.role,
                org_id=om.org_id,
                project_id=None,
            )

    # orphan/삭제 멤버: TM도 OrgMember도 아닌 ID → fallback(크래시 방지)
    for mid in ids:
        if mid not in result:
            result[mid] = ResolvedMember(
                id=mid, user_id=None,
                name=str(mid)[:8],
                type="human", role="member",
                org_id=uuid.UUID(int=0),
                project_id=None,
            )

    return result


async def resolve_auth_member(
    auth: AuthContext,
    org_id: uuid.UUID,
    session: AsyncSession,
    project_id: uuid.UUID | None = None,
) -> "ResolvedMember | TeamMember":
    """인증 주체의 멤버 신원 — team_member 우선, 없으면 org_member(grant-only).

    resolve_member(JWT→org_member.id-always)와 달리 team_member가 있으면 그 id를 반환한다.
    team_member.id로 매칭하는 표시 경로(스탠드업 카드 `/api/team-members`, 대화 참가자 등)와
    write author/sender id를 일치시키기 위함 — org_member.id-always는 표시 경로와 어긋난다.

    API키(에이전트): team_member.id. JWT 휴먼: team_member(project 스코프) 우선 → org_member.
    conversations._resolve_member와 동형 — 공유 SSOT.
    """
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    if is_api_key:
        tm = (await session.execute(
            select(TeamMember).where(TeamMember.id == uuid.UUID(auth.user_id))
        )).scalars().first()
        if tm is None:
            raise HTTPException(status_code=400, detail="Team member not found")
        return tm

    filters = [TeamMember.user_id == uuid.UUID(auth.user_id), TeamMember.org_id == org_id]
    if project_id is not None:
        filters.append(TeamMember.project_id == project_id)
    tm = (await session.execute(select(TeamMember).where(*filters))).scalars().first()
    if tm is not None:
        return tm

    # team_member 없음(grant-only 휴먼) → org_member 경로 (has_project_access 검증 포함)
    return await resolve_member(auth, org_id, session, project_id=project_id)


async def resolve_member_identity(
    member_id: uuid.UUID,
    org_id: uuid.UUID,
    session: AsyncSession,
) -> ResolvedMember | None:
    """단일 member_id(team_member.id | org_member.id)를 org 범위에서 신원 해소.

    TeamMember(에이전트 + 레거시 휴먼) 우선, 없으면 OrgMember(grant-only 휴먼) 조회.
    org 미소속이면 None — 호출부가 404/403 처리. lookup_members_by_ids와 달리
    orphan fallback이 없어 인가/존재 검증에 안전하게 쓸 수 있는.
    """
    tm = (await session.execute(
        select(TeamMember).where(
            TeamMember.id == member_id,
            TeamMember.org_id == org_id,
        )
    )).scalars().first()
    if tm is not None:
        return ResolvedMember(
            id=tm.id, user_id=tm.user_id, name=tm.name, type=tm.type,
            role=tm.role, org_id=tm.org_id, project_id=tm.project_id,
            avatar_url=tm.avatar_url,
        )

    om = (await session.execute(
        select(OrgMember).where(
            OrgMember.id == member_id,
            OrgMember.org_id == org_id,
            OrgMember.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if om is None:
        return None

    user = (await session.execute(
        select(User).where(User.id == om.user_id)
    )).scalar_one_or_none()
    return ResolvedMember(
        id=om.id, user_id=om.user_id,
        name=user.email if user else str(om.id),
        type="human", role=om.role, org_id=om.org_id,
        project_id=None, avatar_url=None,
    )


async def filter_org_member_ids(
    member_ids: set[uuid.UUID],
    org_id: uuid.UUID,
    session: AsyncSession,
) -> set[uuid.UUID]:
    """member_ids 중 org 소속(team_member 또는 org_member)인 것만 반환.

    cross-org 차단용 — grant-only 휴먼(org_member)도 포함하므로 멘션/포크에서 누락되지 않는.
    """
    if not member_ids:
        return set()

    tm_ids = set((await session.execute(
        select(TeamMember.id).where(
            TeamMember.id.in_(member_ids),
            TeamMember.org_id == org_id,
        )
    )).scalars().all())

    remaining = member_ids - tm_ids
    om_ids: set[uuid.UUID] = set()
    if remaining:
        om_ids = set((await session.execute(
            select(OrgMember.id).where(
                OrgMember.id.in_(remaining),
                OrgMember.org_id == org_id,
                OrgMember.deleted_at.is_(None),
            )
        )).scalars().all())

    return tm_ids | om_ids
