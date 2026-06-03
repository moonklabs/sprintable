"""E-MEMBER-SSOT Phase 0: JWT 휴먼 → org_member.id, API키 에이전트 → team_member.id.

ResolvedMember를 conversations/events 전반에 사용해 team_member 강요를 제거.
가역 패치 — 롤백 시 리졸버 교체 + migration downgrade.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext
from app.models.member import AgentProjectProfile, Member, MemberIdentityAlias
from app.models.project import OrgMember
from app.models.project_access import ProjectAccess
from app.models.team import TeamMember
from app.models.user import User
from app.services.project_auth import has_project_access

logger = logging.getLogger(__name__)


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
    """멤버 신원 해소 — AC2-3 shadow 플래그로 레거시/앵커 분기.

    플래그 off(기본): org_members/team_members 기반(레거시).
    플래그 on(shadow): members(+aliases) 앵커 기반. 0075 ID 보존으로 출력 동일(parity).
    """
    if settings.member_ssot_resolver_shadow:
        return await _resolve_member_anchor(auth, org_id, session, project_id)
    return await _resolve_member_legacy(auth, org_id, session, project_id)


async def _resolve_member_legacy(
    auth: AuthContext,
    org_id: uuid.UUID,
    session: AsyncSession,
    project_id: uuid.UUID | None = None,
) -> ResolvedMember:
    """레거시 신원 해소 — API키(에이전트): team_member.id / JWT(휴먼): org_member.id + has_project_access."""
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


async def _resolve_member_anchor(
    auth: AuthContext,
    org_id: uuid.UUID,
    session: AsyncSession,
    project_id: uuid.UUID | None = None,
) -> ResolvedMember:
    """앵커 신원 해소 — members(+placement) 기반. 0075 ID 보존으로 레거시와 출력 동일(parity).

    에이전트(API키): members.id(=team_member.id), role=project_access.role, project_id=agent_project_profiles.project_id.
    휴먼(JWT): members.id(=org_member.id), role=members.org_role, name=users.email(레거시 정합).
    """
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))

    if is_api_key:
        member_id = uuid.UUID(auth.user_id)
        m = (await session.execute(
            select(Member).where(Member.id == member_id, Member.type == "agent")
        )).scalars().first()
        if m is None:
            raise HTTPException(status_code=400, detail="Team member not found")
        # placement(역할/프로젝트) — 0075에서 에이전트 member.id = team_member.id **1:1**(team_member별
        # 1 member)이라 placement/profile도 1행. 멀티프로젝트 에이전트는 N개의 (member,team_member)로
        # 분리되며 API키 auth.user_id는 그중 하나를 지정 → 단일 placement 해소(legacy tm.role/project_id와 동일).
        # ORDER BY created_at: 1:1 위반(미래 데이터) 시에도 결정적 — parity 안정성.
        role = (await session.execute(
            select(ProjectAccess.role).where(ProjectAccess.member_id == m.id)
            .order_by(ProjectAccess.created_at.asc()).limit(1)
        )).scalar_one_or_none()
        proj = (await session.execute(
            select(AgentProjectProfile.project_id).where(AgentProjectProfile.member_id == m.id)
            .order_by(AgentProjectProfile.created_at.asc()).limit(1)
        )).scalar_one_or_none()
        return ResolvedMember(
            id=m.id,
            user_id=None,
            name=m.name,
            type=m.type,
            role=role or "member",
            org_id=m.org_id,
            project_id=proj,
        )

    # JWT 휴먼
    user_id = uuid.UUID(auth.user_id)

    if project_id is not None:
        if not await has_project_access(session, user_id, project_id, org_id):
            raise HTTPException(status_code=403, detail="No access to this project")

    m = (await session.execute(
        select(Member).where(
            Member.org_id == org_id,
            Member.user_id == user_id,
            Member.type == "human",
            Member.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if m is None:
        raise HTTPException(status_code=400, detail="Organization member not found")

    user = (await session.execute(
        select(User).where(User.id == user_id)
    )).scalar_one_or_none()
    name = user.email if user else str(user_id)

    return ResolvedMember(
        id=m.id,
        user_id=user_id,
        name=name,
        type="human",
        role=m.org_role or "member",
        org_id=m.org_id,
        project_id=project_id,
    )


async def lookup_members_by_ids(
    ids: set[uuid.UUID],
    session: AsyncSession,
) -> dict[uuid.UUID, ResolvedMember]:
    """ID 집합 → ResolvedMember 맵. AC2-3 shadow 플래그로 레거시/앵커 분기."""
    if not ids:
        return {}
    if settings.member_ssot_resolver_shadow:
        return await _lookup_members_by_ids_anchor(ids, session)
    return await _lookup_members_by_ids_legacy(ids, session)


async def _lookup_members_by_ids_legacy(
    ids: set[uuid.UUID],
    session: AsyncSession,
) -> dict[uuid.UUID, ResolvedMember]:
    """레거시 ID 집합 → ResolvedMember 맵. TeamMember 우선, 없으면 OrgMember, 그래도 없으면 orphan fallback."""
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


async def _lookup_members_by_ids_anchor(
    ids: set[uuid.UUID],
    session: AsyncSession,
) -> dict[uuid.UUID, ResolvedMember]:
    """앵커 ID 집합 → ResolvedMember 맵. members 직접 → member_identity_aliases resolve(908075db
    de-fallback) → 진짜 orphan(member/alias 모두 없음)만 telemetry-only.

    레거시 휴먼 team_member.id는 alias를 통해 canonical 휴먼 member(=org_member.id)로 해소되며,
    맵의 key는 호출자가 넘긴 원본 id 유지(callers가 원본 id로 조회). .id 필드는 canonical member.id.
    """
    if not ids:
        return {}

    result: dict[uuid.UUID, ResolvedMember] = {}
    resolved_member_for: dict[uuid.UUID, Member] = {}

    # 1. members 직접 매칭 (id가 곧 member.id)
    members = (await session.execute(select(Member).where(Member.id.in_(ids)))).scalars().all()
    member_by_id = {m.id: m for m in members}
    for mid in ids:
        if mid in member_by_id:
            resolved_member_for[mid] = member_by_id[mid]

    # 2. alias 매칭 (레거시 team_member.id → canonical member) — 908075db de-fallback
    missing = ids - set(resolved_member_for.keys())
    if missing:
        alias_rows = (await session.execute(
            select(MemberIdentityAlias.alias_id, MemberIdentityAlias.member_id)
            .where(MemberIdentityAlias.alias_id.in_(missing))
        )).all()
        target_ids = {row[1] for row in alias_rows}
        target_members: dict[uuid.UUID, Member] = {}
        if target_ids:
            tms = (await session.execute(select(Member).where(Member.id.in_(target_ids)))).scalars().all()
            target_members = {m.id: m for m in tms}
        for alias_id, member_id in alias_rows:
            tgt = target_members.get(member_id)
            if tgt is not None:
                resolved_member_for[alias_id] = tgt

    # 에이전트 placement(role/project_id) 배치 조회 — H1: ORDER BY created_at ASC로 결정성
    # (단일 resolve와 동일 기준). setdefault + 정렬이라 member별 earliest placement가 선택됨.
    agent_ids = [m.id for m in resolved_member_for.values() if m.type == "agent"]
    role_by_member: dict[uuid.UUID, str] = {}
    proj_by_member: dict[uuid.UUID, uuid.UUID] = {}
    if agent_ids:
        for mid_, role in (await session.execute(
            select(ProjectAccess.member_id, ProjectAccess.role)
            .where(ProjectAccess.member_id.in_(agent_ids))
            .order_by(ProjectAccess.created_at.asc())
        )).all():
            role_by_member.setdefault(mid_, role)
        for mid_, pid in (await session.execute(
            select(AgentProjectProfile.member_id, AgentProjectProfile.project_id)
            .where(AgentProjectProfile.member_id.in_(agent_ids))
            .order_by(AgentProjectProfile.created_at.asc())
        )).all():
            proj_by_member.setdefault(mid_, pid)

    # M1: 휴먼 display name은 users.email로 정합(레거시 OrgMember path + 단일 resolve와 동일).
    human_user_ids = {m.user_id for m in resolved_member_for.values() if m.type == "human" and m.user_id}
    email_by_user: dict[uuid.UUID, str] = {}
    if human_user_ids:
        for uid_, email in (await session.execute(
            select(User.id, User.email).where(User.id.in_(human_user_ids))
        )).all():
            email_by_user[uid_] = email

    for orig_id, m in resolved_member_for.items():
        if m.type == "agent":
            result[orig_id] = ResolvedMember(
                id=m.id, user_id=None, name=m.name, type="agent",
                role=role_by_member.get(m.id, "member"), org_id=m.org_id,
                project_id=proj_by_member.get(m.id),
            )
        else:
            result[orig_id] = ResolvedMember(
                id=m.id, user_id=m.user_id,
                name=email_by_user.get(m.user_id) if m.user_id else str(m.id),
                type="human", role=m.org_role or "member", org_id=m.org_id, project_id=None,
            )

    # 3. 진짜 orphan(member/alias 모두 없음) — telemetry-only + 크래시 방지 placeholder
    for oid in ids - set(result.keys()):
        logger.warning("member_resolver(anchor): unresolved orphan id=%s — no member/alias", oid)
        result[oid] = ResolvedMember(
            id=oid, user_id=None, name=str(oid)[:8],
            type="human", role="member", org_id=uuid.UUID(int=0), project_id=None,
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
