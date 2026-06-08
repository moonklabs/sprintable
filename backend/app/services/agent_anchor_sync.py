"""E-MEMBER-SSOT AC3-1b: 신규 agent 앵커 write-sync.

신규 agent(team_member type='agent') 생성 시 앵커 신원(members) + per-project 런타임
(agent_project_profiles)을 함께 dual-write 한다. 0075 백필과 **동형**(members.id=team_member.id,
owner_member_id=생성 휴먼 member, agent_project_profiles는 team_member 런타임 필드 미러).

왜 foundational:
- members 부재 → `member_ssot_apikey_cut=on`에서 _resolve_api_key가 401(생명선 차단).
- agent_project_profiles 부재 → cut-on의 project_id=None(M1).
- 둘 부재 → agent_api_keys.member_id→members FK 재추가(0080) 시 신규 INSERT가 referent 없어 위반(트랩#7/8).

⚠️ 호출 위치: team_member 생성 직후 ~ **api_key 자동생성 이전**(FK 선행 충족). create_team_member에서 보장.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy import update as sa_update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.member import AgentProjectProfile, Member
from app.models.project import OrgMember
from app.models.user import User


async def sync_agent_anchor_on_create(
    session: AsyncSession,
    team_member,
    created_by: uuid.UUID | None,
) -> None:
    """agent team_member의 앵커(members + agent_project_profiles)를 멱등 dual-write.

    team_member.type != 'agent'이면 no-op. 멱등(ON CONFLICT DO NOTHING) — 재호출/백필 중복 안전.
    """
    if getattr(team_member, "type", None) != "agent":
        return

    # owner_member_id = 생성 휴먼의 member.id (= org_member.id, 0075 불변식).
    #   휴먼 org_member이고 members 행이 실재할 때만; 그 외(agent 생성자·orphan) NULL(SET NULL 컬럼).
    owner_member_id: uuid.UUID | None = None
    if created_by is not None:
        owner_member_id = (
            await session.execute(
                select(OrgMember.id)
                .where(OrgMember.org_id == team_member.org_id)
                .where(OrgMember.user_id == created_by)
                .where(OrgMember.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
        if owner_member_id is not None:
            member_exists = (
                await session.execute(select(Member.id).where(Member.id == owner_member_id))
            ).scalar_one_or_none()
            if member_exists is None:
                owner_member_id = None

    # 1. members (id=team_member.id, type='agent') — 0075 에이전트 백필 동형
    await session.execute(
        pg_insert(Member.__table__)
        .values(
            id=team_member.id,
            org_id=team_member.org_id,
            type="agent",
            user_id=None,
            owner_member_id=owner_member_id,
            name=team_member.name,
            avatar_url=team_member.avatar_url,
            org_role=None,
            is_active=team_member.is_active,
        )
        .on_conflict_do_nothing(index_elements=["id"])
    )

    # 2. agent_project_profiles (member_id=team_member.id) — 런타임/설정 미러
    await session.execute(
        pg_insert(AgentProjectProfile.__table__)
        .values(
            id=uuid.uuid4(),
            member_id=team_member.id,
            project_id=team_member.project_id,
            agent_config=team_member.agent_config,
            agent_role=team_member.agent_role,
            fakechat_port=team_member.fakechat_port,
            last_seen_at=team_member.last_seen_at,
            active_story_id=team_member.active_story_id,
            agent_status=team_member.agent_status,
        )
        .on_conflict_do_nothing()  # (project_id, member_id) UNIQUE + (project_id, fakechat_port) 부분 UNIQUE 모두 흡수
    )

    # 3. project_access direct placement (AC3-4 2-1, G3): 0075 §5 에이전트 placement 동형.
    #    AC3-4 뷰가 role/can_manage를 project_access서 읽으므로 신규 agent도 placement 필요(누락 시 뷰서
    #    role 기본값). member_id=tm.id(canonical), org_member_id=NULL(에이전트). ON CONFLICT 멱등.
    from app.models.project_access import ProjectAccess
    await session.execute(
        pg_insert(ProjectAccess.__table__)
        .values(
            id=uuid.uuid4(),
            project_id=team_member.project_id,
            org_member_id=None,
            member_id=team_member.id,
            permission="granted",
            role=team_member.role,
            color=team_member.color,
            can_manage_members=team_member.can_manage_members,
            access_source="direct",
        )
        .on_conflict_do_nothing()  # (project_id, member_id) 부분 UNIQUE 흡수(멱등)
    )

    # api_key 자동생성(create_team_member)이 같은 트랜잭션에서 members FK를 즉시 보도록 flush
    await session.flush()


async def ensure_human_member(session: AsyncSession, org_member_id: uuid.UUID) -> bool:
    """휴먼 org_member의 앵커 members 행을 멱등 보장(AC3-2c grant write-sync).

    members.id = org_member.id (0075 휴먼 불변식). 0075 백필 동형(name=users.email/display_name).
    project_access.member_id=org_member.id를 세팅하기 전 호출 — fk_project_access_member(NOT VALID이나
    신규 INSERT 검증)가 members 행을 요구하므로. 신규 휴먼(0075 이후)은 members 행이 없을 수 있다.

    반환: members 행이 (이미 있거나) 보장되면 True, org_member 부재/삭제 **또는 orphan org**면
    False(호출부 미세팅 — member_id NULL 레거시 호환).

    ⚠️ orphan-safe(QA E1, 0084 §1 동형): members.org_id NOT NULL FK라 **org 부재 시 INSERT 불가**
    → org 존재 확인 후만 INSERT(아니면 False). user_id는 users FK라 **orphan user면 NULL**(user.id|NULL).
    """
    from app.models.organization import Organization

    om = (
        await session.execute(
            select(OrgMember).where(OrgMember.id == org_member_id, OrgMember.deleted_at.is_(None))
        )
    ).scalar_one_or_none()
    if om is None:
        return False

    # org 존재 확인 — orphan org면 members.org_id FK 위반(500) 회피로 미보장(False)
    org_exists = (
        await session.execute(select(Organization.id).where(Organization.id == om.org_id))
    ).scalar_one_or_none()
    if org_exists is None:
        return False

    user = (
        await session.execute(select(User).where(User.id == om.user_id))
    ).scalar_one_or_none()
    # orphan user면 user_id=NULL(members.user_id FK 위반 회피, 0084 LEFT JOIN u.id 동형)
    user_id_val = user.id if user is not None else None
    name = (getattr(user, "display_name", None) or getattr(user, "email", None) or str(om.user_id)) if user else str(om.user_id)

    await session.execute(
        pg_insert(Member.__table__)
        .values(
            id=om.id,  # 0075 불변식: 휴먼 members.id = org_member.id
            org_id=om.org_id,
            type="human",
            user_id=user_id_val,
            owner_member_id=None,
            name=name,
            org_role=om.role,
            is_active=True,
        )
        .on_conflict_do_nothing(index_elements=["id"])
    )
    await session.flush()
    return True


async def sync_agent_profile_presence(session: AsyncSession, member_id: uuid.UUID, **fields) -> None:
    """AC3-4 2-1 dual-write: 에이전트 presence를 agent_project_profiles에도 반영(team_members UPDATE와 동시).

    AC3-4 뷰가 last_seen_at/active_story_id/agent_status를 agent_project_profiles서 읽으므로 cutover 전
    동기 유지. member_id(=agent team_member.id, 1:1)로 단일 profile 행 UPDATE. 행 없으면 0건(무해).
    cutover(2-2) 후 레거시 team_members UPDATE 제거 시 이 경로가 유일 write가 된다.
    """
    allowed = {"last_seen_at", "active_story_id", "agent_status"}
    upd = {k: v for k, v in fields.items() if k in allowed}
    if not upd:
        return
    await session.execute(
        sa_update(AgentProjectProfile.__table__)
        .where(AgentProjectProfile.__table__.c.member_id == member_id)
        .values(**upd)
    )
