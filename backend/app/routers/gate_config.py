"""HITL 게이트 레벨 config 엔드포인트 — E-HITL-GATING S-GATE-1.

GET  /api/v2/projects/{project_id}/gate-config  — effective config 조회(프로젝트 멤버).
PUT  /api/v2/projects/{project_id}/gate-config  — 레벨 설정. 권한(정책 §2·토대 재사용):
  scope='org'(org 기본값)=org admin / scope='project'(오버라이드)=project owner(+org owner/admin).
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.gate_config import (
    ACTOR_TYPES,
    LEVELS,
    WORK_TYPES,
    delete_gate_override,
    resolve_gate_level,
    resolve_gate_level_with_source,
    set_gate_level,
)
from app.services.project_auth import (
    get_project_role,
    has_project_access,
    is_org_owner_or_admin,
)

router = APIRouter(prefix="/api/v2/projects", tags=["hitl-gate-config"])
# S-GATE-4: org 기본값 단독 조회용 org-layer 라우터(project-effective GET과 별개·org 탭 surface).
org_router = APIRouter(prefix="/api/v2/organizations", tags=["hitl-gate-config"])


class GateLevelEntry(BaseModel):
    work_type: str
    actor_type: str
    level: str
    source: str = "org_default"  # S-GATE-4: 'override'(project 재정의) | 'org_default'(상속)


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
            level, source = await resolve_gate_level_with_source(
                session, org_id=org_id, project_id=project_id, work_type=wt, actor_type=at
            )
            entries.append(GateLevelEntry(work_type=wt, actor_type=at, level=level, source=source))
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
    # source = project scope면 override, org scope면 org_default(방금 설정한 계층 반영).
    src = "override" if target_project_id is not None else "org_default"
    return GateLevelEntry(work_type=row.work_type, actor_type=row.actor_type, level=row.level, source=src)


@router.delete("/{project_id}/gate-config", response_model=GateLevelEntry)
async def delete_gate_config_override(
    project_id: uuid.UUID,
    work_type: str = Query(...),
    actor_type: str = Query(...),
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> GateLevelEntry:
    """S-GATE-4: project override 해제(↺ 기본값 복귀) → org 기본값 상속. 삭제 후 effective 레벨+source 반환.

    권한 = project owner 또는 org owner/admin(PUT scope='project'와 동일). org 기본값은 여기서 못 지움.
    """
    if work_type not in WORK_TYPES:
        raise HTTPException(status_code=400, detail=f"work_type must be one of {list(WORK_TYPES)}")
    if actor_type not in ACTOR_TYPES:
        raise HTTPException(status_code=400, detail=f"actor_type must be one of {list(ACTOR_TYPES)}")

    org_id = await _project_org_id(session, project_id)
    actor = uuid.UUID(auth.user_id)
    if not (
        (await get_project_role(session, actor, project_id)) == "owner"
        or await is_org_owner_or_admin(session, actor, org_id)
    ):
        raise HTTPException(
            status_code=403, detail="project owner or org owner/admin required to remove override"
        )

    await delete_gate_override(
        session, org_id=org_id, project_id=project_id, work_type=work_type, actor_type=actor_type
    )
    await session.commit()
    # 삭제 후 effective(상속) 레벨 반환 — FE 즉시 갱신("↺ 기본값"). 미존재 override 삭제는 멱등(상속값 반환).
    level, source = await resolve_gate_level_with_source(
        session, org_id=org_id, project_id=project_id, work_type=work_type, actor_type=actor_type
    )
    return GateLevelEntry(work_type=work_type, actor_type=actor_type, level=level, source=source)


@org_router.get("/{org_id}/gate-config", response_model=list[GateLevelEntry])
async def get_org_gate_config(
    org_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[GateLevelEntry]:
    """S-GATE-4: org **기본값 단독** 조회(project-effective GET과 별개·org 설정 탭 surface).

    project_id 무시하고 org 레벨(project_id IS NULL) 값만 — 미설정 셀은 시스템 기본 'ask'. path org_id는
    caller org와 일치해야(타org 차단). 설정(PUT scope='org')은 org admin.

    QA RC: 권한 = **org owner/admin only**. project GET(멤버 read·자기 프로젝트 effective)과 달리 이건
    **org 전체 기본값 관리 surface**라 관리자 스코프 — 멤버는 project GET으로 자기 config 읽으니 무손실.
    """
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org owner/admin required for org-level gate config")
    entries: list[GateLevelEntry] = []
    for wt in WORK_TYPES:
        for at in ACTOR_TYPES:
            # project_id=None → org 행 또는 시스템 기본(상속). org 레이어엔 override 개념 없음 → source=org_default.
            level, source = await resolve_gate_level_with_source(
                session, org_id=org_id, project_id=None, work_type=wt, actor_type=at
            )
            entries.append(GateLevelEntry(work_type=wt, actor_type=at, level=level, source=source))
    return entries


class OrgGateLevelRequest(BaseModel):
    work_type: str
    actor_type: str
    level: str


@org_router.put("/{org_id}/gate-config", response_model=GateLevelEntry)
async def put_org_gate_config(
    org_id: uuid.UUID,
    body: OrgGateLevelRequest,
    session: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> GateLevelEntry:
    """S-GATE-4: org **기본값** 설정(project override 아님·project_id=None). 권한=org owner/admin.

    org-scoped PUT — 기존 project 라우트 scope='org' 우회(미르코 #1567 워크어라운드·project 0개 org
    편집 불가)를 대체. path org_id 는 caller org 와 일치해야(타org 차단).
    """
    if body.work_type not in WORK_TYPES:
        raise HTTPException(status_code=400, detail=f"work_type must be one of {list(WORK_TYPES)}")
    if body.actor_type not in ACTOR_TYPES:
        raise HTTPException(status_code=400, detail=f"actor_type must be one of {list(ACTOR_TYPES)}")
    if body.level not in LEVELS:
        raise HTTPException(status_code=400, detail=f"level must be one of {list(LEVELS)}")
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org owner/admin required to set org default")

    row = await set_gate_level(
        session,
        org_id=org_id,
        project_id=None,  # org 기본값(project override 아님)
        work_type=body.work_type,
        actor_type=body.actor_type,
        level=body.level,
        created_by=uuid.UUID(auth.user_id),
    )
    await session.commit()
    return GateLevelEntry(
        work_type=row.work_type, actor_type=row.actor_type, level=row.level, source="org_default"
    )
