"""Role Templates API — E-RECRUIT S1 (story a47e7374): 채용 카탈로그 조회.

GET /api/v2/role-templates        발행된 role_template 목록
GET /api/v2/role-templates/{slug} 단건 조회(role_behaviors 포함)
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.role_template import RoleTemplate

router = APIRouter(prefix="/api/v2/role-templates", tags=["role-templates"])


class RoleTemplateSummary(BaseModel):
    """목록 응답 — role_behaviors(md 본문) 제외(목록 페이로드 절감, chat/story 패턴과 동형)."""

    id: uuid.UUID
    slug: str
    name: str
    category: str
    description: str | None
    default_tool_groups: list[str]
    default_workflow_recipe_slug: str | None
    is_builtin: bool
    tier: str
    version: int

    model_config = {"from_attributes": True}


class RoleTemplateDetail(RoleTemplateSummary):
    """단건 응답 — role_behaviors(자율 운영 지침 본문) + runtime_overrides 포함."""

    role_behaviors: str
    runtime_overrides: dict
    created_at: datetime
    updated_at: datetime


@router.get("", response_model=list[RoleTemplateSummary])
async def list_role_templates(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> list[RoleTemplateSummary]:
    """발행된(is_published) role_template 카탈로그 — org/project 무관 전역 조회."""
    result = await session.execute(
        select(RoleTemplate)
        .where(RoleTemplate.is_published.is_(True))
        .order_by(RoleTemplate.category, RoleTemplate.name)
    )
    return [RoleTemplateSummary.model_validate(rt) for rt in result.scalars().all()]


@router.get("/{slug}", response_model=RoleTemplateDetail)
async def get_role_template(
    slug: str,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> RoleTemplateDetail:
    """단건 조회 — 미발행(is_published=False) 행은 404(카탈로그와 동일 가시성 규칙)."""
    role_template = (await session.execute(
        select(RoleTemplate).where(RoleTemplate.slug == slug, RoleTemplate.is_published.is_(True))
    )).scalar_one_or_none()
    if role_template is None:
        raise HTTPException(status_code=404, detail="Role template not found")
    return RoleTemplateDetail.model_validate(role_template)
