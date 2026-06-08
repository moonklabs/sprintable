import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy import update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.member import AgentProjectProfile, Member
from app.models.project_access import ProjectAccess
from app.models.team import TeamMember
from app.repositories.base import BaseRepository

# AC3-4 2-2: team_members가 projection 뷰로 강등됨 → write를 앵커 테이블로 라우팅(anchor-only).
# PATCH 필드 → 앵커 매핑(0088 뷰 정의와 정합):
#   name/avatar_url/is_active → members,  role/color/can_manage_members → project_access(per-project),
#   agent_config/agent_role → agent_project_profiles.
_MEMBERS_FIELDS = {"name", "avatar_url", "is_active"}
_ACCESS_FIELDS = {"role", "color", "can_manage_members"}
_PROFILE_FIELDS = {"agent_config", "agent_role"}


class TeamMemberRepository(BaseRepository[TeamMember]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(TeamMember, session, org_id)

    async def get(self, id: uuid.UUID) -> TeamMember | None:  # type: ignore[override]
        # AC3-4 2-2: team_members가 뷰 — 휴먼은 members.id=org_member.id가 project_access 다행이라 동일
        # id로 여러 행 가능(프로젝트별). scalar_one_or_none RAISE 회피 위해 first()(에이전트는 1:1 단일행).
        # ⚠️ order_by(project_id)로 **결정적** row 선택(휴먼 multi-project 비결정성 제거 — QA 소크 안정).
        # 휴먼 project-specific(role/color)은 team-members 단일조회/PATCH 비-플로우(=project_access 그랜트
        # 경로로 관리); first()는 is_active/name(members 공통) 안전망 + RAISE 회피가 목적.
        result = await self.session.execute(
            select(TeamMember)
            .where(self._org_filter(), TeamMember.id == id)
            .order_by(TeamMember.project_id)
            .limit(1)
        )
        return result.scalars().first()

    async def list(self, limit: int = 1000, **filters: Any) -> list[TeamMember]:  # type: ignore[override]
        q = select(TeamMember).where(self._org_filter())
        for attr, val in filters.items():
            q = q.where(getattr(TeamMember, attr) == val)
        # standup-dup 근본 fix: team_members 는 0088 projection 뷰(members ⋈ project_access /
        # ⋈ agent_project_profiles)라 멀티프로젝트 멤버가 per-project N행이 된다. org-level
        # (project_id 미필터) 조회는 멤버 중복 → member(id) 기준 DISTINCT ON 으로 1행만 반환
        # (org-level 계약 = unique 멤버). project_id 필터 시엔 project당 1행이라 dedup 불요(무회귀).
        if "project_id" not in filters:
            q = q.distinct(TeamMember.id).order_by(TeamMember.id)
        result = await self.session.execute(q.limit(limit))
        return list(result.scalars().all())

    async def apply_anchor_update(self, member: TeamMember, data: dict[str, Any]) -> None:
        """AC3-4 2-2: PATCH 필드를 앵커 테이블로 라우팅(anchor-only write, 레거시 team_members UPDATE 없음).

        뷰가 읽는 소스에 직접 write: members(신원·is_active) / project_access(per-project role·color·권한) /
        agent_project_profiles(에이전트 설정). JSONB(agent_config)는 ORM 컬럼 타입으로 안전 직렬화.
        """
        m_set = {k: v for k, v in data.items() if k in _MEMBERS_FIELDS}
        a_set = {k: v for k, v in data.items() if k in _ACCESS_FIELDS}
        p_set = {k: v for k, v in data.items() if k in _PROFILE_FIELDS}
        if m_set:
            await self.session.execute(
                sa_update(Member)
                .where(Member.id == member.id)
                .values(**m_set, updated_at=func.now())
            )
        if a_set:
            await self.session.execute(
                sa_update(ProjectAccess)
                .where(
                    ProjectAccess.member_id == member.id,
                    ProjectAccess.project_id == member.project_id,
                )
                .values(**a_set)
            )
        if p_set:
            await self.session.execute(
                sa_update(AgentProjectProfile)
                .where(AgentProjectProfile.member_id == member.id)
                .values(**p_set, updated_at=func.now())
            )
        await self.session.flush()

    async def deactivate(self, id: uuid.UUID) -> bool:
        """DELETE 대신 is_active=False soft deactivate.

        AC3-4 2-2: team_members 뷰 전환 — anchor-only. members.is_active=false로 반영(에이전트
        members.id=tm.id 1:1). 휴먼은 members.id=org_member.id라 미매치=0건(무해; 휴먼 비활성은
        org_members 경로에서 처리). 레거시 team_members UPDATE 제거(뷰는 write 불가).
        """
        member = await self.get(id)
        if member is None:
            return False
        await self.session.execute(
            sa_update(Member).where(Member.id == id).values(is_active=False, updated_at=func.now())
        )
        return True
