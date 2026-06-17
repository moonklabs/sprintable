from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy import update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.member import AgentProjectProfile, Member
from app.models.project_access import ProjectAccess
from app.models.team import TeamMember
from app.repositories.base import BaseRepository

# AC3-4 2-2: team_members가 projection 뷰로 강등됨 → write를 앵커 테이블로 라우팅(anchor-only).
# PATCH 필드 → 앵커 매핑(0088 뷰 정의와 정합):
#   name/avatar_url/is_active/runtime_type → members,  role/color/can_manage_members → project_access(per-project),
#   agent_config/agent_role → agent_project_profiles.
# E-CHAT-CMD S1b: runtime_type 은 에이전트 단위 식별 → canonical members 에 기록(0106 뷰가 투영).
_MEMBERS_FIELDS = {"name", "avatar_url", "is_active", "runtime_type"}
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

    async def list_org_human_members(
        self, user_id: uuid.UUID | None = None
    ) -> list[dict[str, Any]]:
        """org-level 휴먼 로스터 = **org_members SSOT 직접 해소** (S:166051f0).

        team_members 뷰(0088 = members ⋈ project_access)는 휴먼을 project_access.member_id 로
        join 하는데, 실 grant 플로우(create_project_access)는 member_id 를 NULL 로 두므로
        grant-only/owner 휴먼이 뷰에서 탈락한다 → org-level 스탠드업 로스터서 휴먼 0(상용 버그).
        여기서는 **project_access/team_members 를 일절 경유하지 않고** org_members 를 권위 소스로
        직접 열거한다. 곱연산(휴먼×프로젝트=N행) 없음 — org_member 1행/휴먼. member_id 백필 불요.

        id = org_member.id = canonical 휴먼 신원(/api/me·standup author_id·_MISSING_SQL 과 동일
        기준 → 자기 카드 편집/제출 매칭 정합). name/avatar 는 canonical members 우선, users 폴백
        (백필 갭 안전망). 반환은 TeamMemberResponse 와 호환되는 dict.
        """
        sql = (
            "SELECT om.id AS id, om.user_id AS user_id, om.role AS role, om.created_at AS created_at, "
            "       COALESCE(m.name, u.display_name, u.email, '') AS name, m.avatar_url AS avatar_url "
            "FROM org_members om "
            "JOIN users u ON u.id = om.user_id "
            "LEFT JOIN members m ON m.org_id = om.org_id AND m.user_id = om.user_id "
            "                   AND m.type = 'human' AND m.deleted_at IS NULL "
            "WHERE om.org_id = :org AND om.deleted_at IS NULL"
        )
        params: dict[str, Any] = {"org": self.org_id}
        # asyncpg 함정 회피: ':uid IS NULL' 분기 대신 Python 조건부로 필터를 붙인다
        # (feedback_asyncpg_text_traps — IS NULL 바인딩 AmbiguousParameterError).
        if user_id is not None:
            sql += " AND om.user_id = :uid"
            params["uid"] = user_id
        sql += " ORDER BY name"
        rows = await self.session.execute(text(sql), params)
        return [dict(row._mapping) for row in rows]

    async def apply_anchor_update(self, member: TeamMember, data: dict[str, Any]) -> None:
        """AC3-4 2-2: PATCH 필드를 앵커 테이블로 라우팅(anchor-only write, 레거시 team_members UPDATE 없음).

        뷰가 읽는 소스에 직접 write: members(신원·is_active) / project_access(per-project role·color·권한) /
        agent_project_profiles(에이전트 설정). JSONB(agent_config)는 ORM 컬럼 타입으로 안전 직렬화.
        """
        m_set = {k: v for k, v in data.items() if k in _MEMBERS_FIELDS}
        a_set = {k: v for k, v in data.items() if k in _ACCESS_FIELDS}
        p_set = {k: v for k, v in data.items() if k in _PROFILE_FIELDS}
        # E-MEMBER-POLICY S1: project_access.role 은 enum(owner/admin/member)만 — PATCH 로 비-enum
        # (예: 레거시 'manager')이 들어오면 0122 CHECK 위반(500) → clamp 로 정규화.
        if "role" in a_set:
            from app.services.project_auth import clamp_project_role
            a_set["role"] = clamp_project_role(a_set["role"])
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
