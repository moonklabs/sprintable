"""story ddac96fd(S-resolve): workspace+project slug 단일 resolve — S-route-project FE
미들웨어 소비용(오르테가군 조율 87ed7c68/956d2f36). 발명 0 — /organizations/resolve+
/projects/resolve의 기존 lookup을 한 요청으로 합성(요청당 2 fetch→1).

캐싱: slug UNIQUE 제약(organizations 전역·projects org-scope)상 rename 즉시 옛 slug가
다른 entity에 재점유 가능 — "느려서"가 아니라 오배정 정합성 리스크라 긴 캐시 금지, 짧은
Cache-Control(30~60s)+ETag(If-None-Match 304)만 사용. 옛 slug 요청은 entity_slug_history
(139d2405, 향후 301 redirect용으로 설계된 그 테이블)에서 canonical slug를 찾아 redirect
필드에 실어 반환 — 미들웨어가 그 필드를 보고 브라우저에 자체 301을 낸다(백엔드가 raw HTTP
301을 내지 않는 이유: JSON API를 fetch()로 호출하는 미들웨어 입장에서 조건 없는 301은
추가 라운드트립을 부르므로, 판단 가능한 JSON 필드가 더 저렴하다).
"""
from __future__ import annotations

import hashlib
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.entity_slug_history import EntitySlugHistory
from app.models.organization import Organization
from app.models.project import Project
from app.repositories.organization import OrganizationRepository
from app.services.project_auth import has_project_access

router = APIRouter(prefix="/api/v2/resolve", tags=["resolve", "Organization"])

_CACHE_CONTROL = "private, max-age=60"


async def _find_org_by_history(session: AsyncSession, old_slug: str) -> Organization | None:
    """옛 workspace slug → 가장 최근 rename 이력의 entity → 그 entity의 현재(canonical) 행.

    changed_at DESC LIMIT 1: 다회 rename(A→B→C)이어도 entity_id만 얻으면 그 entity의 현재
    slug를 다시 조회하므로 체이닝 불요. slug가 그사이 다른 org에 재점유됐어도 그 org는
    현재 slug 직접조회(1차 시도)에서 이미 걸렸을 것이므로 이 분기엔 도달하지 않는다.
    """
    row = await session.execute(
        select(EntitySlugHistory.entity_id)
        .where(EntitySlugHistory.entity_type == "organization", EntitySlugHistory.old_slug == old_slug)
        .order_by(EntitySlugHistory.changed_at.desc())
        .limit(1)
    )
    entity_id = row.scalar_one_or_none()
    if entity_id is None:
        return None
    return await session.get(Organization, entity_id)


async def _find_project_by_history(
    session: AsyncSession, org_id: uuid.UUID, old_slug: str,
) -> Project | None:
    row = await session.execute(
        select(EntitySlugHistory.entity_id)
        .where(
            EntitySlugHistory.entity_type == "project",
            EntitySlugHistory.org_id == org_id,
            EntitySlugHistory.old_slug == old_slug,
        )
        .order_by(EntitySlugHistory.changed_at.desc())
        .limit(1)
    )
    entity_id = row.scalar_one_or_none()
    if entity_id is None:
        return None
    project = await session.get(Project, entity_id)
    if project is None or project.deleted_at is not None:
        return None
    return project


def _etag_for(result: dict) -> str:
    key = f"{result.get('org_id')}:{result.get('project_id')}:{result.get('redirect')}"
    return '"' + hashlib.sha1(key.encode()).hexdigest() + '"'


@router.get("", response_model=None)
async def resolve_workspace_project(
    request: Request,
    response: Response,
    workspace: str = Query(...),
    project: str | None = Query(default=None),
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> Response | dict:
    repo = OrganizationRepository(session)
    redirect: dict = {}

    org = await repo.get_by_slug(workspace)
    if org is None:
        org = await _find_org_by_history(session, workspace)
        if org is not None:
            redirect["workspace"] = org.slug
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")

    role = await repo.get_member_role(org_id=org.id, user_id=uuid.UUID(auth.user_id))
    if role is None:
        raise HTTPException(status_code=404, detail="Organization not found")

    result: dict = {"org_id": str(org.id), "org_slug": org.slug, "org_role": role}

    if project is not None:
        proj_row = await session.execute(
            select(Project).where(
                Project.org_id == org.id, Project.slug == project, Project.deleted_at.is_(None),
            )
        )
        proj = proj_row.scalar_one_or_none()
        if proj is None:
            proj = await _find_project_by_history(session, org.id, project)
            if proj is not None:
                redirect["project"] = proj.slug
        if proj is None or not await has_project_access(session, uuid.UUID(auth.user_id), proj.id, org.id):
            raise HTTPException(status_code=404, detail="Project not found")
        result["project_id"] = str(proj.id)
        result["project_slug"] = proj.slug

    if redirect:
        result["redirect"] = redirect

    etag = _etag_for(result)
    response.headers["Cache-Control"] = _CACHE_CONTROL
    response.headers["ETag"] = etag
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=dict(response.headers))
    return result
