"""story #3360(발행 구조·서버, 선생님 확定 2026-09-03) — 자사 사이트 글 발행 API(org 인증).

POST /api/v2/organizations/{org_id}/site-posts — org 멤버(에이전트 키 포함) write. **서버
chokepoint**: work item의 external_publish 게이트가 approved/auto_passed가 아니면 403 —
connectors.py::post_connector_schema와 동일 권한 축(스키마 등록처럼 "그 org 소속이면 누구나"
— owner/admin 전용 아님, 발행 스킬을 실행하는 게 에이전트라 owner/admin이면 그 흐름이 첫
호출에서 403으로 죽는다)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.site_posts import (
    ExternalPublishGateNotApprovedError,
    InvalidSitePostInputError,
    publish_site_post,
)

router = APIRouter(prefix="/api/v2/organizations", tags=["site-posts"])


class PublishSitePostRequest(BaseModel):
    work_item_id: uuid.UUID
    gate_id: uuid.UUID | None = None
    title: str = Field(..., min_length=1, max_length=300)
    slug: str = Field(..., min_length=1, max_length=200)
    lang: str = Field(..., min_length=2, max_length=5)
    summary: str = Field(..., min_length=1, max_length=1000)
    tags: list[str] = Field(default_factory=list)
    body_md: str = Field(..., min_length=1)


class SitePostResponse(BaseModel):
    id: uuid.UUID
    slug: str
    title: str
    lang: str
    published_at: str
    gate_id: uuid.UUID


@router.post("/{org_id}/site-posts", response_model=SitePostResponse, status_code=201)
async def post_site_post(
    org_id: uuid.UUID,
    body: PublishSitePostRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> SitePostResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    try:
        post = await publish_site_post(
            db, org_id=org_id, work_item_id=body.work_item_id, gate_id=body.gate_id,
            title=body.title, slug=body.slug, lang=body.lang, summary=body.summary,
            tags=body.tags, body_md=body.body_md, created_by_member_id=uuid.UUID(auth.user_id),
        )
    except InvalidSitePostInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ExternalPublishGateNotApprovedError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    return SitePostResponse(
        id=post.id, slug=post.slug, title=post.title, lang=post.lang,
        published_at=post.published_at.isoformat(), gate_id=post.gate_id,
    )
