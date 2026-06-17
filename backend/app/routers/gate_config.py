"""HITL 게이트 레벨 config 엔드포인트 — E-HITL-GATING S-GATE-1.

GET  /api/v2/projects/{project_id}/gate-config  — effective config 조회(프로젝트 멤버).
PUT  /api/v2/projects/{project_id}/gate-config  — 레벨 설정. 권한(정책 §2·토대 재사용):
  scope='org'(org 기본값)=org admin / scope='project'(오버라이드)=project owner(+org owner/admin).
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.services.gate_config import (
    ACTOR_TYPES,
    LEVELS,
    WORK_TYPES,
    resolve_gate_level,
    set_gate_level,
)
from app.services.project_auth import (
    get_project_role,
    has_project_access,
    is_org_owner_or_admin,
)

router = APIRouter(prefix="/api/v2/projects", tags=["hitl-gate-config"])


class GateLevelEntry(BaseModel):
    work_type: str
    actor_type: str
    level: str


class SetGateLevelRequest(BaseModel):
    scope: str  # 'org' | 'project'
    work_type: str
    actor_type: str
    level: str


async def _project_org_id(session: AsyncSession, project_id: uuid.UUID) -> uuid.UUID:
    row = (
        await session.execute(
            text("SELECT org_id FROM projects WHERE id = :pid AND deleted_at IS NULL"),
            {"pid": str(project_id)},
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return row[0]


@router.get("/{project_id}/gate-config", response_model=list[GateLevelEntry])
async def get_gate_config(
    project_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> list[GateLevelEntry]:
    """프로젝트의 effective 게이트 레벨(모든 work_type × actor) — **read = 프로젝트 멤버**.

    권한 모델(QA RC·PO 콜): **read=member / write=admin·owner**. 게이트 레벨(자기 액션이 auto/ask/
    block 인지)은 전 멤버가 알아야 유용(미리 차단 여부 인지)·비민감 정책 메타·enforcement 는 서버
    사이드라 알아도 우회 불가 → 멤버 read 가 옳은 설계. 설정(PUT)만 org admin/project owner.
    """
    org_id = await _project_org_id(session, project_id)
    if not await has_project_access(session, uuid.UUID(auth.user_id), project_id, org_id):
        raise HTTPException(status_code=403, detail="No access to this project")

    entries: list[GateLevelEntry] = []
    for wt in WORK_TYPES:
        for at in ACTOR_TYPES:
            level = await resolve_gate_level(
                session, org_id=org_id, project_id=project_id, work_type=wt, actor_type=at
            )
            entries.append(GateLevelEntry(work_type=wt, actor_type=at, level=level))
    return entries


@router.put("/{project_id}/gate-config", response_model=GateLevelEntry)
async def put_gate_config(
    project_id: uuid.UUID,
    body: SetGateLevelRequest,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> GateLevelEntry:
    """게이트 레벨 설정. scope='org'=org 기본값(org admin) / scope='project'=오버라이드(project owner+org admin)."""
    if body.work_type not in WORK_TYPES:
        raise HTTPException(status_code=400, detail=f"work_type must be one of {list(WORK_TYPES)}")
    if body.actor_type not in ACTOR_TYPES:
        raise HTTPException(status_code=400, detail=f"actor_type must be one of {list(ACTOR_TYPES)}")
    if body.level not in LEVELS:
        raise HTTPException(status_code=400, detail=f"level must be one of {list(LEVELS)}")

    org_id = await _project_org_id(session, project_id)
    actor = uuid.UUID(auth.user_id)

    if body.scope == "org":
        # org 기본값 — org admin/owner 만(정책 §2)
        if not await is_org_owner_or_admin(session, actor, org_id):
            raise HTTPException(status_code=403, detail="org owner/admin required to set org default")
        target_project_id: uuid.UUID | None = None
    elif body.scope == "project":
        # project 오버라이드 — project owner 또는 org owner/admin(§2)
        if not (
            (await get_project_role(session, actor, project_id)) == "owner"
            or await is_org_owner_or_admin(session, actor, org_id)
        ):
            raise HTTPException(
                status_code=403, detail="project owner or org owner/admin required to set override"
            )
        target_project_id = project_id
    else:
        raise HTTPException(status_code=400, detail="scope must be 'org' or 'project'")

    row = await set_gate_level(
        session,
        org_id=org_id,
        project_id=target_project_id,
        work_type=body.work_type,
        actor_type=body.actor_type,
        level=body.level,
        created_by=actor,
    )
    await session.commit()
    return GateLevelEntry(work_type=row.work_type, actor_type=row.actor_type, level=row.level)
