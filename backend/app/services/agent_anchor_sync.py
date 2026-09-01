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

import logging
import uuid

from sqlalchemy import func, select
from sqlalchemy import update as sa_update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.member import AgentProjectProfile, Member
from app.models.project import OrgMember
from app.models.user import User

logger = logging.getLogger(__name__)


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
                # 생성자(members 앵커 없는 휴먼·member-SSOT 갭) 휴먼 앵커를 멱등 보장 →
                # owner_member_id 유지(NULL 떨굼 방지) → 뷰 created_by 충족 → DM 403 근본 해소.
                # orphan-safe: ensure_human_member가 org/om 부재 시 False → 기존대로 NULL 유지.
                if not await ensure_human_member(session, owner_member_id):
                    owner_member_id = None

    # story #2646(2026-08-14, 은퇴): story #2603 P0가 여기서 채번하던 @handle(members.handle) —
    # 그 값의 유일한 소비처였던 텍스트 @handle 파서(handle_mention_parser.py)를 dev 실측
    # 0/1139(실 매치 0건, 구조화 mentioned_ids 153건과 대조)로 은퇴시키며 채번도 함께 제거.
    # members.handle 컬럼 자체(과거 채번된 값)는 남아있으나 이제 아무 코드도 읽지 않는다.

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

    # 2·3. per-project 앵커(agent_project_profiles + project_access placement) — 공유 헬퍼.
    await write_agent_project_placement(
        session,
        member_id=team_member.id,
        project_id=team_member.project_id,
        agent_config=team_member.agent_config,
        agent_role=team_member.agent_role,
        fakechat_port=team_member.fakechat_port,
        role=team_member.role,
        color=team_member.color,
        can_manage_members=team_member.can_manage_members,
        last_seen_at=team_member.last_seen_at,
        active_story_id=team_member.active_story_id,
        agent_status=team_member.agent_status,
    )

    # api_key 자동생성(create_team_member)이 같은 트랜잭션에서 members FK를 즉시 보도록 flush
    await session.flush()


async def write_agent_project_placement(
    session: AsyncSession,
    *,
    member_id: uuid.UUID,
    project_id: uuid.UUID,
    agent_config: dict | None = None,
    agent_role: str | None = None,
    fakechat_port: int | None = None,
    role: str = "member",
    color: str = "#3385f8",
    can_manage_members: bool = False,
    last_seen_at=None,
    active_story_id: uuid.UUID | None = None,
    agent_status: str | None = None,
) -> None:
    """에이전트의 per-project 앵커(agent_project_profiles 런타임 + project_access grant)를 멱등 write.

    members 행은 호출부(sync_agent_anchor_on_create / org-level create)에서 보장한다. org-level
    멀티프로젝트 에이전트가 추가 프로젝트로 접근을 확장할 때 이 헬퍼를 프로젝트마다 재호출한다.
    둘 다 ON CONFLICT DO NOTHING — 재호출/백필 중복 안전.
    """
    # agent_project_profiles (member_id) — 런타임/설정 미러
    await session.execute(
        pg_insert(AgentProjectProfile.__table__)
        .values(
            id=uuid.uuid4(),
            member_id=member_id,
            project_id=project_id,
            agent_config=agent_config,
            agent_role=agent_role,
            fakechat_port=fakechat_port,
            last_seen_at=last_seen_at,
            active_story_id=active_story_id,
            agent_status=agent_status,
        )
        .on_conflict_do_nothing()  # (project_id, member_id) UNIQUE + (project_id, fakechat_port) 부분 UNIQUE 모두 흡수
    )

    # project_access direct placement (AC3-4 2-1, G3): 0075 §5 에이전트 placement 동형.
    #    AC3-4 뷰가 role/can_manage를 project_access서 읽으므로 grant 필요. member_id=canonical,
    #    org_member_id=NULL(에이전트). ON CONFLICT 멱등.
    # E-MEMBER-POLICY S1: role 은 enum(owner/admin/member)으로 clamp — 0122 CHECK 위반 방지.
    from app.models.project_access import ProjectAccess
    from app.services.project_auth import clamp_project_role
    await session.execute(
        pg_insert(ProjectAccess.__table__)
        .values(
            id=uuid.uuid4(),
            project_id=project_id,
            org_member_id=None,
            member_id=member_id,
            permission="granted",
            role=clamp_project_role(role),
            color=color,
            can_manage_members=can_manage_members,
            access_source="direct",
        )
        .on_conflict_do_nothing()  # (project_id, member_id) 부분 UNIQUE 흡수(멱등)
    )


_FAKECHAT_BASE_PORT = 8787


async def allocate_fakechat_port(session: AsyncSession, project_id: uuid.UUID) -> int:
    """프로젝트 내 미사용 fakechat 포트 — create_team_member 와 동일 규칙(프로젝트별 유일)."""
    from app.models.team import TeamMember

    existing = {
        r[0]
        for r in (
            await session.execute(
                select(TeamMember.fakechat_port).where(
                    TeamMember.project_id == project_id,
                    TeamMember.type == "agent",
                    TeamMember.fakechat_port.isnot(None),
                )
            )
        ).all()
    }
    port = _FAKECHAT_BASE_PORT
    while port in existing:
        port += 1
    return port


async def ensure_agent_project_profile(
    session: AsyncSession,
    *,
    member_id: uuid.UUID,
    project_id: uuid.UUID,
    agent_config: dict | None = None,
    agent_role: str | None = None,
    fakechat_port: int | None = None,
) -> None:
    """에이전트의 per-project agent_project_profiles 행만 멱등 보장(grant 는 호출부가 관리).

    S4: grant-only 에이전트(team_members 뷰 branch3 = 런타임 컬럼 NULL)에 per-project profile 을
    부여해 presence/런타임 write(sync_agent_profile_presence 의 UPDATE)가 실제 행에 반영되게 한다.
    profile 부재 시 presence UPDATE 가 0행(무음 누락)이 되는 문제 해소. fakechat_port 미지정 시
    프로젝트 내 미사용 포트를 자동 할당(create 경로와 동일 규칙). ON CONFLICT 멱등.
    """
    if fakechat_port is None:
        fakechat_port = await allocate_fakechat_port(session, project_id)
    await session.execute(
        pg_insert(AgentProjectProfile.__table__)
        .values(
            id=uuid.uuid4(),
            member_id=member_id,
            project_id=project_id,
            agent_config=agent_config,
            agent_role=agent_role,
            fakechat_port=fakechat_port,
            last_seen_at=None,
            active_story_id=None,
            agent_status=None,
        )
        .on_conflict_do_nothing()  # (project_id, member_id) UNIQUE + (project_id, fakechat_port) 부분 UNIQUE 흡수
    )


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
    동기 유지. member_id(=agent team_member.id, 1:1)로 단일 profile 행 UPDATE.
    cutover(2-2) 후 레거시 team_members UPDATE 제거 시 이 경로가 유일 write가 된다.

    story #3197 — 이 함수가 "agent가 online으로 관측됐다"(last_seen_at=NOW 세팅)를 쓰는
    유일한 choke point다(stdio SSE connect·http heartbeat 둘 다 여기로 수렴). `last_seen_at`이
    non-None 값으로 오면(=online write, offline인 last_seen_at=None과 구분) 같은 UPDATE에
    `first_connected_at = COALESCE(first_connected_at, :그 값)`을 얹는다 — 별도 write 0,
    한 번 채워지면 이후 online 갱신에 덮이지 않는다(COALESCE가 기존 값 우선).

    story #3275(2026-09-01, 선생님 prod customer-zero 실사고 그라운딩) — "행 없으면 0건(무해)"
    가정이 실은 무해하지 않았다: profile 부재(S4급 grant-only 클래스 — `ensure_agent_project_profile`
    이 project_access grant 경로 한 곳에만 배선돼, heartbeat 등 나머지 콜사이트는 무음 스킵)면
    `first_connected_at`이 영원히 안 써지는데, heartbeat 엔드포인트 자체는 `team_members` 뷰의
    grant-only 분기(런타임 컬럼 NULL)로 200 OK를 반환해 "연결은 됐는데 체크리스트만 영구
    위음성"이 재현됐다. rowcount==0이면 self-heal: `TeamMember.project_id`(anchor project —
    `team_members.project_id`는 DB NOT NULL 제약, `write_agent_project_placement`/
    `create_org_level_agent`가 생성 시 항상 세팅해 이 경로에서 NULL을 만날 수 없다)로
    `ensure_agent_project_profile`을 멱등 호출한 뒤 UPDATE를 1회만 재시도한다. 콜사이트 7곳
    (agent_gateway.py×3·team_members.py×3·agent_auth_failure.py×1) 전부를 고치는 대신 이 함수
    내부에서 닫는 쪽이 더 좁은 경계(PO 확定)."""
    allowed = {"last_seen_at", "active_story_id", "agent_status"}
    upd = {k: v for k, v in fields.items() if k in allowed}
    if not upd:
        return
    if upd.get("last_seen_at") is not None:
        upd["first_connected_at"] = func.coalesce(
            AgentProjectProfile.__table__.c.first_connected_at, upd["last_seen_at"]
        )
    result = await session.execute(
        sa_update(AgentProjectProfile.__table__)
        .where(AgentProjectProfile.__table__.c.member_id == member_id)
        .values(**upd)
    )
    if result.rowcount != 0:
        return

    from app.models.team import TeamMember

    team_member = await session.get(TeamMember, member_id)
    if team_member is None:
        # team_members 행 자체가 없다(고아 member_id) — self-heal 대상 밖, 소리내어 남긴다.
        logger.warning(
            "sync_agent_profile_presence: no team_member row for member_id=%s — presence write skipped",
            member_id,
        )
        return

    await ensure_agent_project_profile(session, member_id=member_id, project_id=team_member.project_id)
    retry = await session.execute(
        sa_update(AgentProjectProfile.__table__)
        .where(AgentProjectProfile.__table__.c.member_id == member_id)
        .values(**upd)
    )
    if retry.rowcount == 0:
        # ensure 직후인데도 0행 — 이론상 불가(project_id NOT NULL·ensure는 멱등 INSERT)이나
        # 무음보다 시끄러운 실패가 낫다(no-fiction 원칙).
        logger.error(
            "sync_agent_profile_presence: self-heal failed to produce a writable profile row for member_id=%s",
            member_id,
        )
