"""E-MEMBER-SSOT Phase 0: JWT 휴먼 → org_member.id, API키 에이전트 → team_member.id.

ResolvedMember를 conversations/events 전반에 사용해 team_member 강요를 제거.
가역 패치 — 롤백 시 리졸버 교체 + migration downgrade.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field

from fastapi import HTTPException
from sqlalchemy import or_, select
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

# story #3758 — 서버가 직접 조립하는 한국어 알림 문구(next-intl 밖, conversations.py
# mention/message 알림 title 등)용 공용 폴백. FE `common.memberUnnamed`(member-display.ts)
# 와 같은 값 — 이름 없는 실존 구성원을 f-string에 그대로 꽂으면 "None님이..."로 새는
# 자리를 막는다. 여기가 SSOT(ResolvedMember와 같은 자리) — 새 문구를 다른 파일에서
# 따로 짓지 않는다.
UNNAMED_MEMBER_LABEL = "이름 없는 구성원"


@dataclass
class ResolvedMember:
    """통합 멤버 신원 — 휴먼(org_member.id) 또는 에이전트(team_member.id).

    story #3203 — name은 orphan/삭제 멤버(TM도 OrgMember도 아닌 id, org_id=
    uuid.UUID(int=0) sentinel) fallback에서 None일 수 있다. 예전엔 `str(id)[:8]`
    (uuid 앞 8자)로 "이름처럼 보이는" 값을 지어냈으나, 그건 FE 화면에 raw 식별자가
    그대로 새는 표시결함이었다(#3203 실사고 — 대화 리스트 상대명 자리에 uuid 노출).
    소비처 4곳 전수 확認: gates.py/activity_logs.py는 이미 `if rm and rm.name`
    truthy 가드, backlinks.py는 org_id sentinel로 orphan을 name 읽기 前에 걸러냄
    (셋 다 None 안전) — conversations.py(_fetch_conversation_participants)만 FE로
    그대로 흘려보내는데, FE Participant.name은 원래 `string | null`이었다(폴백
    로직이 처음부터 null을 전제하고 설계돼 있었다는 뜻 — 이 fix는 그 계약을
    실제로 채우는 것).

    story #3758(별건 ④ 9번째, PO 決 2026-09-09) — `name=None`은 두 가지 서로 다른
    사실을 뭉뚱그린다: 「실존 구성원인데 표시명만 없음」과 「orphan(member/alias
    자체가 해소 안 됨)」. batch 조회(lookup_members_by_ids) 소비처 중 conversations.py
    참여자 목록처럼 이 둘을 다르게 그려야 하는 화면이 있는데, name=None 하나로는
    구별이 안 됐다. `resolved` 필드로 가른다 — 정의는 이 dataclass 한 자리(소비처마다
    orphan-id 집합을 따로 들고 재동기화하는 방식은 기각, PO 決)."""
    id: uuid.UUID
    user_id: uuid.UUID | None      # users.id (휴먼) | None (에이전트)
    name: str | None
    type: str                      # "human" | "agent"
    role: str
    org_id: uuid.UUID
    project_id: uuid.UUID | None = field(default=None)
    avatar_url: str | None = field(default=None)
    # story #3758 — orphan-fallback placeholder(진짜 member/alias 해소 실패)만 False.
    # 실존 구성원(표시명만 없음)은 그대로 True — name=None과 독립된 축.
    resolved: bool = field(default=True)


def is_human_member_condition(member_id_col, *, user_id: uuid.UUID | None = None):
    """story #3627/#3629(prod 결함 클래스, 페드루 PO 確定 2026-09-07) — 이 member_id가
    「휴먼」인지 판정하는 유일한 자리(이 모듈 첫 줄의 규칙과 같은 자리 — 새 판정자
    발명 0). SQL WHERE 절에 그대로 끼워 넣을 수 있는 boolean 조건을 돌려준다.

    E-MEMBER-SSOT Phase 0부터 JWT 휴먼의 참여자/발신자 id는 `org_members.id`다
    (org_members 테이블 자체가 휴먼 전용이라 추가 type 조건 불요) — 그런데 코드
    곳곳(conversations.py 멘션/알림 대상 필터·channel_router.py 대화-내-휴먼
    존재 판정 등)이 여전히 `team_members(type='human')`로만 이었다. team_members에
    그 org의 휴먼 행이 하나도 없으면(SSOT 전환 이후 만들어진 org 다수) 그 자리들이
    org_member-only 휴먼을 조용히 "휴먼 아님"으로 판정한다(3627 원 사고: 온보딩
    왕복·딥링크. 3629: 멘션 알림·chain-expired 휴먼 존재 판정 등으로 같은 클래스가
    번져 있음을 확認).

    둘 다 인정(OR) — legacy team_member(type='human') 행이 남아있는 org도 회귀
    없이 그대로 통과해야 한다. `user_id`를 주면 그 유저 소유 여부까지, 안 주면
    "휴먼이기만 하면" 통과.

    story #3629(카디르 발견, #3627 후속) — `OrgMember.deleted_at.is_(None)` 가드
    없이는 soft-delete된 org_member도 여전히 휴먼으로 오판정된다(뮤테이션 확認,
    회귀 테스트 참고)."""
    org_member_conditions = [OrgMember.id == member_id_col, OrgMember.deleted_at.is_(None)]
    team_member_conditions = [TeamMember.id == member_id_col, TeamMember.type == "human"]
    if user_id is not None:
        org_member_conditions.append(OrgMember.user_id == user_id)
        team_member_conditions.append(TeamMember.user_id == user_id)
    return or_(
        select(OrgMember.id).where(*org_member_conditions).exists(),
        select(TeamMember.id).where(*team_member_conditions).exists(),
    )


async def filter_human_member_ids(
    candidate_ids: set[uuid.UUID],
    session: AsyncSession,
) -> set[uuid.UUID]:
    """story #3629 — `candidate_ids` 중 휴먼인 것만 반환(org_members 또는 legacy
    team_members(type='human') 둘 다 인정, `is_human_member_condition`과 같은 규칙).

    conversations.py의 멘션/일반 메시지 notification 대상 필터 2곳이 각자 `TeamMember.
    id.in_(candidates)` INCLUSION 쿼리만 써서 org_member-only 휴먼을 조용히 빼던 것을
    한 자리로 통일(배치-멤버십 조회라 `filter_org_member_ids`와 같은 형 — 다만 그 함수는
    "org 소속인가"(agent 포함)이고 이건 "휴먼인가"라 목적이 다르다, 새 판정자 발명은
    아니다)."""
    if not candidate_ids:
        return set()
    org_member_ids = set((await session.execute(
        select(OrgMember.id).where(OrgMember.id.in_(candidate_ids), OrgMember.deleted_at.is_(None))
    )).scalars().all())
    team_member_ids = set((await session.execute(
        select(TeamMember.id).where(TeamMember.id.in_(candidate_ids), TeamMember.type == "human")
    )).scalars().all())
    return org_member_ids | team_member_ids


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


async def resolve_member_db_verified(
    auth: AuthContext,
    org_id: uuid.UUID,
    session: AsyncSession,
) -> ResolvedMember:
    """story #3370(페드루 지적 2026-09-10) — `resolve_member()`와 같은 목적(휴먼(JWT)=
    auth.user_id(users.id)를 org_member.id로, 에이전트(API키)는 team_member.id 그대로)
    이지만, agent 판정을 auth 클레임(``app_metadata.api_key_id``)이 아니라 **DB 실측**
    (TeamMember.type=='agent'·is_active, site_posts.py::is_agent_caller와 동일 predicate)
    으로 한다.

    왜 별도 함수인가 — `resolve_member()`로 직접 바꿔 보니 site_posts.py/channel_posts.py
    submit 계열 엔드포인트를 왕복하는 기존 destructive_schema 테스트 수십 개가 전부
    400 "Organization member not found"로 깨졌다(실측: test_3367_site_post_submit_gate_
    seal.py 등). 원인 — 그 테스트들의 `_setup_org_scoped_app(..., user_id=agent_id)`
    호출부가 `agent=True`(api_key_id 클레임) 없이 agent의 team_member.id만 auth.user_id로
    넘기는 관례로 광범위하게 짜여 있다(is_agent_caller가 원래 DB로 판정해 클레임 유무가
    무관했던 계약에 맞춰진 테스트 하네스). 그 계약 자체가 `is_agent_caller`의 설계 의도
    (클레임을 안 믿고 DB의 실제 멤버 타입으로 판정 — actor_type fail-closed, 이 함수
    자신의 docstring 그대로)와 더 맞기도 해, 테스트 수십 곳을 고치는 대신 이 축을
    보존하는 별도 해소 함수로 정정한다(site_posts.py 자신의 축과 정합·새 판정 원칙
    발명 0 — 기존 두 축의 조합일 뿐).

    project_id 스코프는 지원하지 않는다(이 축을 쓰는 현재 호출부가 전부 project 스코프
    불요 — 필요해지면 그때 얹는다, resolve_member()를 쓰면 된다).

    ⚠️fail-closed 안전성(페드루 2차 리뷰 지적 2026-09-10, `_resolve_member_legacy`류
    폴백 없음이 안전한 이유) — 상위 `get_verified_org_id`→`_verify_org_membership`
    (auth.py:593)은 더 넓게 받는다: `OrgMember(user_id==raw) ∪ TeamMember(id==raw,
    active, **타입 무관**)`. 이 함수는 `OrgMember(user_id==raw) ∪ TeamMember(id==raw,
    type=='agent')`만 받으므로 차집합은 「`type != 'agent'`인 TeamMember 행이 raw_id
    (JWT 휴먼이면 users.id)로 매치하는」 호출자 — 그 집합이 **구조적으로 공집합**이다:
    `team_members`는 0088부터 물리테이블이 아니라 VIEW(alembic/versions/0088_team_
    members_projection_view.py)이고, `type='human'` 분기의 `id`는 `members.id`다.
    0075(alembic/versions/0075_member_ssot_anchor_tables.py:11,110) 확定 — "휴먼
    members.id = org_members.id(Phase0 ID 보존)" — `users.id`가 아니다. 즉 휴먼
    TeamMember 행의 `id`는 애초에 `org_members.id`라 JWT의 `auth.user_id`(users.id)와
    같은 값일 수가 없다(서로 다른 테이블의 독립 PK, uuid 충돌이 아니면 불가능) — 상위
    가드가 그 `TeamMember(타입 무관)` 분기로 통과시키는 호출자는 전부 agent뿐이고, 그건
    이 함수의 agent 분기가 이미 받는다. 막히는 집합=∅."""
    raw_id = uuid.UUID(auth.user_id)

    tm = (await session.execute(
        select(TeamMember).where(
            TeamMember.org_id == org_id, TeamMember.id == raw_id, TeamMember.type == "agent",
            TeamMember.is_active.is_(True),
        ).limit(1)
    )).scalars().first()
    if tm is not None:
        return ResolvedMember(
            id=tm.id, user_id=None, name=tm.name, type="agent", role=tm.role,
            org_id=tm.org_id, project_id=tm.project_id, avatar_url=tm.avatar_url,
        )

    om = (await session.execute(
        select(OrgMember).where(
            OrgMember.org_id == org_id, OrgMember.user_id == raw_id, OrgMember.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if om is None:
        raise HTTPException(status_code=400, detail="Organization member not found")

    user = (await session.execute(select(User).where(User.id == raw_id))).scalar_one_or_none()
    return ResolvedMember(
        id=om.id, user_id=raw_id, name=user.display_name if user else None, type="human",
        role=om.role, org_id=org_id,
    )


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
        # 까심 QA CRITICAL(#1814 S3 QA): 휴먼 분기만 project_id를 has_project_access로 검증했고
        # agent(API키) 분기는 검증 없이 조기 return — agent가 접근권한 없는 project_id를 넘기면
        # 그 project에 리소스가 생성됐다(cross-project IDOR). resolve_member(project_id=)를 쓰는
        # 모든 라우터(loops/hypotheses/retros/standups/conversations 등)가 동일하게 뚫려 있었다.
        if project_id is not None:
            if not await has_project_access(session, tm.id, project_id, org_id):
                raise HTTPException(status_code=403, detail="No access to this project")
        return ResolvedMember(
            id=tm.id,
            user_id=None,
            name=tm.name,
            type=tm.type,
            role=tm.role,
            org_id=tm.org_id,
            project_id=tm.project_id,
            avatar_url=tm.avatar_url,
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
    # story #3755(별건 ④, 페드루 PO 決) — email은 name이 아니다. display_name 없으면
    # 이메일도 id 문자열도 지어내지 않고 None(#3747 resolve_member_display_name 계약을
    # resolver 전 경로로 — 신원은 위 om.id/user_id가 지키고 name은 표시 전용).
    name = user.display_name if user else None

    # story #2901 — OrgMember·User 둘 다 avatar_url 컬럼이 없다(TeamMember/Member만 보유) —
    # 지어낼 수 없어 dataclass 기본값(None) 그대로 둔다. JWT-휴먼이 TeamMember 행도 없는
    # 레거시 org-member-only 케이스에 한정된 사각(앵커 모드 전환 시 Member 통합으로 해소).
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
    휴먼(JWT): members.id(=org_member.id), role=members.org_role, name=users.display_name
    (story #3755 — email 폴백 0, 없으면 None).
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
        # 까심 QA CRITICAL(#1814 S3 QA) — legacy 분기와 동일 갭(agent가 project_id 검증 없이 통과).
        # anchor 경로도 동일하게 봉인(shadow 플래그로 어느 쪽이 active여도 안전).
        if project_id is not None:
            if not await has_project_access(session, m.id, project_id, org_id):
                raise HTTPException(status_code=403, detail="No access to this project")
        return ResolvedMember(
            id=m.id,
            user_id=None,
            name=m.name,
            type=m.type,
            role=role or "member",
            org_id=m.org_id,
            project_id=proj,
            avatar_url=m.avatar_url,
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

    user = (await session.execute(
        select(User).where(User.id == user_id)
    )).scalar_one_or_none()
    # story #3755(별건 ④) — 위 legacy 분기와 동일 계약: email/id 폴백 0, None 정직.
    name = user.display_name if user else None

    if m is None:
        # P0 핫픽스(members-sync 갭): members 앵커 행이 없는 org-member 폴백.
        # org-create(organizations.py)·invite-accept 는 org_members 만 INSERT·members 미생성 →
        # 0075 백필 이후 신규 org-creator/invitee 는 members 행이 없어 여기서 400 났다.
        # **org_members 폴백**(canonical org_member.id) — 0075 ID 보존(member.id = org_member.id)
        # 이라 anchor 가 반환할 동일 신원을 org_members 서 소싱(parity). team_member 봐주기 아님
        # (team_member 조회 0·org_members 만). GET /me 의 org_members 폴백과 동형.
        om = (await session.execute(
            select(OrgMember).where(
                OrgMember.org_id == org_id,
                OrgMember.user_id == user_id,
                OrgMember.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
        if om is None:
            raise HTTPException(status_code=400, detail="Organization member not found")
        # story #2901 — 이 폴백은 om(OrgMember) 소싱이라 위 L111 레거시 분기와 동일하게
        # avatar_url 컬럼이 없다(지어낼 수 없어 dataclass 기본값 None 유지).
        return ResolvedMember(
            id=om.id,
            user_id=user_id,
            name=name,
            type="human",
            role=om.role,
            org_id=om.org_id,
            project_id=project_id,
        )

    return ResolvedMember(
        id=m.id,
        user_id=user_id,
        name=name,
        type="human",
        role=m.org_role or "member",
        org_id=m.org_id,
        project_id=project_id,
        avatar_url=m.avatar_url,
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
            avatar_url=m.avatar_url,
        )
        for m in tms
    }

    missing = ids - set(result.keys())
    if missing:
        oms = (await session.execute(
            select(OrgMember).where(OrgMember.id.in_(missing))
        )).scalars().all()
        # story #3755(별건 ④) — OrgMember의 display name: user.display_name 배치 조회
        # (email 폴백 0 — #3747 resolve_member_display_name 계약).
        user_ids = {m.user_id for m in oms if m.user_id}
        users_map: dict[uuid.UUID, str | None] = {}
        if user_ids:
            users = (await session.execute(
                select(User).where(User.id.in_(user_ids))
            )).scalars().all()
            users_map = {u.id: u.display_name for u in users}

        for om in oms:
            # story #2901 — om(OrgMember) 소싱, avatar_url 컬럼 없음(위 단일 resolve와 동일 사각).
            # story #3755 — display_name 없으면(또는 user_id 자체가 없으면) None(id 문자열 0).
            result[om.id] = ResolvedMember(
                id=om.id,
                user_id=om.user_id,
                name=users_map.get(om.user_id) if om.user_id else None,
                type="human",
                role=om.role,
                org_id=om.org_id,
                project_id=None,
            )

    # orphan/삭제 멤버: TM도 OrgMember도 아닌 ID → fallback(크래시 방지). story #3203 —
    # name=None(예전엔 str(mid)[:8] — uuid 노출 표시결함 원인지 중 하나, ResolvedMember
    # 클래스 docstring 참고). story #3758 — resolved=False(진짜 orphan임을 소비처가
    # 구별할 수 있게).
    for mid in ids:
        if mid not in result:
            result[mid] = ResolvedMember(
                id=mid, user_id=None,
                name=None,
                type="human", role="member",
                org_id=uuid.UUID(int=0),
                project_id=None,
                resolved=False,
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

    # story #3755(별건 ④) — 휴먼 display name은 users.display_name(email 폴백 0, 레거시
    # OrgMember path + 단일 resolve와 동일 계약 — #3747 resolve_member_display_name).
    human_user_ids = {m.user_id for m in resolved_member_for.values() if m.type == "human" and m.user_id}
    display_name_by_user: dict[uuid.UUID, str | None] = {}
    if human_user_ids:
        for uid_, display_name in (await session.execute(
            select(User.id, User.display_name).where(User.id.in_(human_user_ids))
        )).all():
            display_name_by_user[uid_] = display_name

    for orig_id, m in resolved_member_for.items():
        if m.type == "agent":
            result[orig_id] = ResolvedMember(
                id=m.id, user_id=None, name=m.name, type="agent",
                role=role_by_member.get(m.id, "member"), org_id=m.org_id,
                project_id=proj_by_member.get(m.id),
                avatar_url=m.avatar_url,
            )
        else:
            # story #3755 — display_name 없으면(또는 user_id 자체가 없으면) None(id 문자열 0).
            result[orig_id] = ResolvedMember(
                id=m.id, user_id=m.user_id,
                name=display_name_by_user.get(m.user_id) if m.user_id else None,
                type="human", role=m.org_role or "member", org_id=m.org_id, project_id=None,
                avatar_url=m.avatar_url,
            )

    # 3. 진짜 orphan(member/alias 모두 없음) — telemetry-only + 크래시 방지 placeholder.
    # story #3203 — name=None(legacy 경로와 동형 fix, ResolvedMember docstring 참고).
    # story #3758 — resolved=False(진짜 orphan임을 소비처가 구별할 수 있게).
    for oid in ids - set(result.keys()):
        logger.warning("member_resolver(anchor): unresolved orphan id=%s — no member/alias", oid)
        result[oid] = ResolvedMember(
            id=oid, user_id=None, name=None,
            type="human", role="member", org_id=uuid.UUID(int=0), project_id=None,
            resolved=False,
        )

    return result


async def is_caller_member(
    member_id: uuid.UUID, auth: AuthContext, session: AsyncSession, org_id: uuid.UUID,
) -> bool:
    """S19(발견·회귀수정): caller가 team_members뷰 id 공간의 ``member_id`` 본인인지 axis-safe하게
    확인한다.

    ``resolve_member(auth,...).id != member_id`` 직접비교는 API키 에이전트(auth.user_id가 이미
    team_member.id)엔 맞지만, JWT 휴먼은 ``resolve_member``가 ``OrgMember.id``(별개 테이블 PK)를
    반환해 이 path의 ``member_id``(=members anchor/team_members뷰 id)와 축이 달라 **본인이 본인
    claim/heartbeat/lock을 호출해도 403**나는 회귀를 냈다(까심의 "human 회귀 없음" 판정은 검증
    시드가 같은 id를 재사용한 거짓양성 — 실 서로 다른 id로 재현하면 드러남).

    axis-safe 비교: agent(API키)는 ``auth.user_id`` 자체가 이미 team_member.id이므로 직접비교.
    human(JWT)은 ``auth.user_id``=users.id이므로, member_id가 가리키는 team_members뷰 행의
    ``user_id`` 컬럼(동일 users.id 공간)과 비교한다 — org_member/members 어느 쪽도 개입하지 않음.
    """
    caller_id = uuid.UUID(auth.user_id)
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    if is_api_key:
        return member_id == caller_id
    result = await session.execute(
        select(TeamMember.user_id).where(
            TeamMember.id == member_id, TeamMember.org_id == org_id,
        ).limit(1)
    )
    row = result.first()
    if row is not None:
        return row[0] == caller_id
    # #2216: team_members뷰(members ⋈ project_access INNER JOIN)는 owner-floor 휴먼
    # (project_access grant 없이 has_project_access의 admin_branch로만 접근하는 org
    # owner/admin)을 원천적으로 못 담는다 — 그 축은 TeamMember 조회가 항상 빈 채로
    # 오는데, 그걸 곧장 "본인 아님"으로 오판하면 owner-floor 본인이 자기 자신을 대상으로
    # 한 self-scope 호출(예: current-project 전환)에서 영구히 403을 맞는다. org_members
    # SSOT(filter_org_member_ids와 동일 축 — member_id.py:508의 폴백과 동형)로 마지막
    # 확인한다: member_id가 org_member.id이고 그 user_id가 caller 본인인가.
    om_result = await session.execute(
        select(OrgMember.user_id).where(
            OrgMember.id == member_id, OrgMember.org_id == org_id,
            OrgMember.deleted_at.is_(None),
        ).limit(1)
    )
    om_row = om_result.first()
    return om_row is not None and om_row[0] == caller_id


async def assert_caller_is_member(
    member_id: uuid.UUID, auth: AuthContext, session: AsyncSession, org_id: uuid.UUID,
    detail: str = "Cannot act as another member",
) -> None:
    """``is_caller_member`` 결과가 False면 403. self-scope 게이트의 표준 형태."""
    if not await is_caller_member(member_id, auth, session, org_id):
        raise HTTPException(status_code=403, detail=detail)


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
    # story #3755(별건 ④, 페드루 PO 決 2026-09-09) — email은 name이 아니다. #3747에서
    # 이 함수 대신 `resolve_member_display_name()`을 신설해 content-rules 한 화면만
    # 처방했으나, 그건 국소 fix라 클래스가 남았다(같은 email 폴백이 활동 로그·대화·
    # 이벤트 등 이 함수의 다른 호출부 전부에 그대로 있었다) — 이제 이 함수 자체를
    # 같은 계약으로: display_name 없으면 이메일도 id 문자열도 지어내지 않고 None.
    return ResolvedMember(
        id=om.id, user_id=om.user_id,
        name=user.display_name if user else None,
        type="human", role=om.role, org_id=om.org_id,
        project_id=None, avatar_url=None,
    )


async def resolve_member_display_name(
    member_id: uuid.UUID,
    org_id: uuid.UUID,
    session: AsyncSession,
) -> str | None:
    """story #3747(①, 페드루 PO 確定 2026-09-09) — «사람에게 보여줄 이름» 전용 해소.
    이 함수를 신설했을 당시(#3747) `resolve_member_identity()`의 OrgMember(grant-only
    휴먼) 분기는 표시명이 없으면 이메일(`user.email`)로, 그마저 없으면 id 문자열로
    채워 넣었다 — 화면에 그대로 찍으면 이메일이 UI에 새는 사고였다(#3747
    content-rules 헤더 부제·409 배너 두 자리에서 실제 발생). #3755(별건 ④)에서
    그 email/id 폴백을 `resolve_member_identity()`·`resolve_member()`·
    `lookup_members_by_ids()` 전 경로(5자리)로 걷어 이제 이 함수와 같은 계약이다 —
    이 함수는 TeamMember만 보고(OrgMember 폴백 없음) 그 계약을 처음 세운 자리로
    남는다. TeamMember.name 또는 User.display_name "만" 인정하고, 없으면 이메일도
    id도 안 지어내고 그냥 None을 돌린다(호출부가 "이름 모름" 갈래로 정직하게
    떨어진다, 지어내지 않는다 원칙)."""
    tm = (await session.execute(
        select(TeamMember).where(
            TeamMember.id == member_id,
            TeamMember.org_id == org_id,
        )
    )).scalars().first()
    if tm is not None:
        return tm.name

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
    return user.display_name if user else None


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


async def canonicalize_member_id(
    member_id: uuid.UUID,
    session: AsyncSession,
) -> uuid.UUID:
    """레거시 식별자를 canonical members.id로 정규화 — AC3-2/AC3-3 read-cut 방향.

    레거시 휴먼 team_member.id는 member_identity_aliases로 canonical(org_member.id) 치환,
    그 외(이미 canonical org_member.id·에이전트 team_member.id)는 그대로(orphan-safe).
    COALESCE(alias.member_id, id) 동형.
    """
    aliased = (
        await session.execute(
            select(MemberIdentityAlias.member_id).where(MemberIdentityAlias.alias_id == member_id)
        )
    ).scalar_one_or_none()
    return aliased or member_id


async def canonicalize_member_ids(
    member_ids: set[uuid.UUID],
    session: AsyncSession,
) -> dict[uuid.UUID, uuid.UUID]:
    """배치 정규화 — {원본 id: canonical id}. alias 없으면 자기 자신(orphan-safe)."""
    if not member_ids:
        return {}
    rows = (
        await session.execute(
            select(MemberIdentityAlias.alias_id, MemberIdentityAlias.member_id).where(
                MemberIdentityAlias.alias_id.in_(member_ids)
            )
        )
    ).all()
    alias_map = {a: m for a, m in rows}
    return {mid: alias_map.get(mid, mid) for mid in member_ids}
