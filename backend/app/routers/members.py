import uuid

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.team import TeamMember

router = APIRouter(prefix="/api/v2/members", tags=["members"])


class MemberResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    type: str
    role: str
    is_active: bool


@router.get("", response_model=list[MemberResponse])
async def list_members(
    project_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> list[MemberResponse]:
    """프로젝트 멤버 목록.

    Human: org_members + project_access JOIN (grant 모델 — 레코드 있음 = 접근 허용).
    Agent: team_members(type=agent) 그대로 유지.
    """
    result: list[MemberResponse] = []

    # Human members — org owner/admin은 grant 없이도 항상 포함 (S-MBR-03).
    # Org member는 명시적 granted 레코드가 있어야 포함 (S-MBR-10).
    #
    # name 해소: canonical members.name → users.display_name → email 순(LEFT JOIN members).
    # 기존 `COALESCE(u.email,'')`는 휴먼을 항상 raw 이메일로 노출해, 동일 휴먼을
    # 실명(display_name)으로 보여주는 org 로스터(team_member.py list_org_human_members)와
    # 어긋났다(보드/Dispatch assignee 가 email 노출). 두 경로를 동일 COALESCE 로 정렬한다.
    human_rows = await session.execute(
        text(
            """
            SELECT om.id,
                   COALESCE(NULLIF(m.name, ''), NULLIF(u.display_name, ''), u.email, '') AS name,
                   om.role
            FROM org_members om
            JOIN users u ON u.id = om.user_id
            JOIN projects p ON p.org_id = om.org_id AND p.id = :project_id
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
        {"project_id": str(project_id)},
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
