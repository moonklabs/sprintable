import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.team import TeamMember
from app.repositories.team_member import TeamMemberRepository
from app.services.project_auth import assert_target_in_caller_org, has_project_access

router = APIRouter(prefix="/api/v2/members", tags=["members", "Organization"])


class MemberResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str | None
    type: str
    role: str
    is_active: bool


@router.get("", response_model=list[MemberResponse])
async def list_members(
    project_id: uuid.UUID | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[MemberResponse]:
    """멤버 목록 — canonical SSOT(휴먼: org_members+project_access grant, 에이전트: team_members
    type=agent). team_members 뷰 기반 /api/v2/team-members와 달리 grant 휴먼·owner/admin
    누락이 없다(BFF route.ts 주석과 동일 계약 — 이 계약을 지키는 게 이 엔드포인트의 존재
    이유라 project_id 스코프에서 team-members로 대체하면 안 된다).

    story #3687(3680 클래스) — project_id 없는 대화(org-level DM 등)는 애초에 "프로젝트
    접근권" 개념이 없다. 이 경우는 grant 판정 자체가 무의미한 **별도 분기**(project 스코프
    "grant 모델이라 못 바꾼다"는 여기 해당 안 됨) — 휴먼은 org_members 전원(SSOT 직접 해소,
    list_org_human_members·S:166051f0과 동일 방식, grant 무관 — DM 상대가 프로젝트 grant가
    없어도 org 소속이면 멘션 가능해야 한다), 에이전트는 org의 team_members(type=agent) 전원
    (프로젝트 무관, 이 org에서 일하는 모든 에이전트).
    """
    if project_id is None:
        result: list[MemberResponse] = []
        repo = TeamMemberRepository(session, org_id)
        for row in await repo.list_org_human_members():
            result.append(MemberResponse(id=row["id"], name=row["name"], type="human", role=row["role"], is_active=True))

        # team_members는 members⋈project_access VIEW(0088)라 project_id로 안 좁히면 grant
        # 프로젝트 수만큼 같은 에이전트가 중복 행으로 나온다 — repo.list()가 이미 이 축(project_id
        # 미필터 시 DISTINCT ON team_members.id)을 처리해 두어 그대로 재사용(중복 재발명 금지,
        # team_members.py org-스코프 분기와 동일 패턴).
        for agent in await repo.list(type="agent", is_active=True):
            result.append(MemberResponse.model_validate(agent))
        return result

    # E-SECURITY SEC-S6(story 54248174·까심 QA 부수발견 D): project_id가 caller org 소속인지
    # 대조한 적이 없어 타 org project_id로 그 org 멤버 로스터가 그대로 열거됐다(cross-org IDOR).
    # 존재/타org 둘 다 404(존재 비노출).
    project_org_row = await session.execute(
        text("SELECT org_id FROM projects WHERE id = :project_id"),
        {"project_id": project_id},
    )
    project_org_id = project_org_row.scalar_one_or_none()
    assert_target_in_caller_org(org_id, project_org_id, not_found_detail="Project not found")

    # ratchet round9(#2050 SEC HIGH baseline 마지막 1건): 위 가드는 cross-org IDOR만 막고
    # same-org cross-project는 미검증이라, 같은 org 내 접근권 없는 project_id를 주입하면
    # 그 프로젝트의 휴먼+에이전트 로스터(name/role)가 그대로 열거됐다. project_id는 쿼리
    # 파라미터 자체가 조회 대상이므로 resource-actual 직접검증. 유일한 project-환원 벡터이며
    # (다른 필터/검색어 없음) EE RBAC 등 특수 훅도 없음을 그라운딩으로 확認(round7 교훈).
    # 존재/무접근권 모두 404(존재 비노출·기존 가드와 동형 시맨틱).
    if not await has_project_access(session, uuid.UUID(auth.user_id), project_id, org_id):
        raise HTTPException(status_code=404, detail="Project not found")

    result: list[MemberResponse] = []

    # Human members — org owner/admin은 grant 없이도 항상 포함 (S-MBR-03).
    # Org member는 명시적 granted 레코드가 있어야 포함 (S-MBR-10).
    #
    # name 해소: canonical members.name → users.display_name(story #3758 — email 폴백 0,
    # 둘 다 없으면 None 정직). 예전 `COALESCE(...,u.email,'')`는 휴먼을 항상 raw
    # 이메일로 노출해, 동일 휴먼을 실명(display_name)으로 보여주는 org 로스터
    # (team_member.py list_org_human_members)와 어긋났고, member_resolver.py
    # 5자리(#3755)와도 같은 email 폴백 클래스였다(여기는 그 5자리 밖 독립 raw SQL).
    #
    # p.org_id = :org_id — 위 가드로 이미 보장되지만 defense-in-depth로 join에도 명시.
    human_rows = await session.execute(
        text(
            """
            SELECT om.id,
                   COALESCE(NULLIF(m.name, ''), NULLIF(u.display_name, '')) AS name,
                   om.role
            FROM org_members om
            JOIN users u ON u.id = om.user_id
            JOIN projects p ON p.org_id = om.org_id AND p.id = :project_id AND p.org_id = :org_id
            LEFT JOIN members m ON m.org_id = om.org_id AND m.user_id = om.user_id
                               AND m.type = 'human' AND m.deleted_at IS NULL
            WHERE om.deleted_at IS NULL
              AND (
                om.role IN ('owner', 'admin')
                OR EXISTS (
                    SELECT 1 FROM project_access pa
                    WHERE pa.org_member_id = om.id
                      AND pa.project_id = :project_id
                      AND pa.permission = 'granted'
                )
              )
            ORDER BY name
            """
        ),
        {"project_id": str(project_id), "org_id": str(org_id)},
    )
    for row in human_rows:
        result.append(MemberResponse(id=row[0], name=row[1], type="human", role=row[2], is_active=True))

    # Agent members — team_members(type=agent)은 기존 그대로
    agent_result = await session.execute(
        select(TeamMember).where(
            TeamMember.project_id == project_id,
            TeamMember.type == "agent",
            TeamMember.is_active.is_(True),
        ).order_by(TeamMember.name)
    )
    for agent in agent_result.scalars().all():
        result.append(MemberResponse.model_validate(agent))

    return result
