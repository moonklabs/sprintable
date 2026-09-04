"""story #3437(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — campaign 생성·조회 API.
`site_posts.py`/`channel_posts.py` 라우터 형태를 그대로 미러(새 패턴 발명 0)."""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.routers.channel_posts import ChannelPostDraftListItem, _to_draft_list_item
from app.services.campaigns import create_campaign, get_campaign, list_content_items_for_campaign
from app.services.channel_posts import list_channel_post_drafts
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2/organizations", tags=["campaigns"])


async def _require_human(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    """PO 確定 ⓑ③ — campaign 생성은 휴먼 전용(에이전트 403 pin). channel_posts.py::
    _require_human과 동형(추가 role 제한 없음, org 멤버인 휴먼이면 누구나)."""
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human":
        raise HTTPException(
            status_code=403,
            detail={
                "code": "CAMPAIGN_CREATE_HUMAN_ONLY",
                "message": "campaign 생성은 휴먼 멤버만 가능합니다(에이전트는 조회만).",
            },
        )
    return resolved


class CreateCampaignRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=300)
    starts_at: datetime | None = None
    ends_at: datetime | None = None


class CampaignResponse(BaseModel):
    id: uuid.UUID
    name: str
    starts_at: str | None = None
    ends_at: str | None = None
    status: str
    created_by_member_id: uuid.UUID
    created_at: str


def _campaign_response(campaign) -> CampaignResponse:
    return CampaignResponse(
        id=campaign.id, name=campaign.name,
        starts_at=campaign.starts_at.isoformat() if campaign.starts_at else None,
        ends_at=campaign.ends_at.isoformat() if campaign.ends_at else None,
        status=campaign.status, created_by_member_id=campaign.created_by_member_id,
        created_at=campaign.created_at.isoformat(),
    )


@router.post("/{org_id}/campaigns", response_model=CampaignResponse, status_code=201)
async def post_campaign(
    org_id: uuid.UUID,
    body: CreateCampaignRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> CampaignResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_human(db, auth, org_id)

    campaign = await create_campaign(
        db, org_id=org_id, name=body.name, starts_at=body.starts_at, ends_at=body.ends_at,
        created_by_member_id=resolved.id,
    )
    return _campaign_response(campaign)


class CampaignContentItemItem(BaseModel):
    content_item_id: uuid.UUID
    slug: str
    lang: str
    title: str
    current_version: int
    updated_at: str
    variants: list[ChannelPostDraftListItem]


class CampaignDetailResponse(CampaignResponse):
    content_items: list[CampaignContentItemItem]


@router.get("/{org_id}/campaigns/{campaign_id}", response_model=CampaignDetailResponse)
async def get_campaign_detail_endpoint(
    org_id: uuid.UUID,
    campaign_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> CampaignDetailResponse:
    """story #3437(AC3) — campaign 단위로 소속 원문·변형·상태를 한 번에 준다. 조직
    멤버(휴먼·에이전트 모두) 읽기 가능 — 생성만 human-only(승인·발행 경계 밖 조회는
    이 도메인 전체 관례)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    campaign = await get_campaign(db, org_id=org_id, campaign_id=campaign_id)
    if campaign is None:
        raise HTTPException(status_code=404, detail=f"campaign을 찾을 수 없습니다: {campaign_id}")

    content_item_rows = await list_content_items_for_campaign(db, org_id=org_id, campaign_id=campaign_id)

    content_items: list[CampaignContentItemItem] = []
    for draft, latest_version in content_item_rows:
        variant_rows = await list_channel_post_drafts(
            db, org_id=org_id, source_content_item_id=draft.id, limit=200,
        )
        content_items.append(CampaignContentItemItem(
            content_item_id=draft.id, slug=draft.slug, lang=latest_version.lang,
            title=latest_version.title, current_version=latest_version.version,
            updated_at=latest_version.created_at.isoformat(),
            variants=[_to_draft_list_item(row) for row in variant_rows],
        ))

    return CampaignDetailResponse(
        **_campaign_response(campaign).model_dump(), content_items=content_items,
    )
