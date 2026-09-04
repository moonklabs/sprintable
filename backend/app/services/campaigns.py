"""story #3437(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — campaign 생성·조회. 블루프린트
v3 §3 원장 5단 중 `campaign` 단(가장 바깥 묶음). 조직·이름·기간·상태 최소(PO 確定 ⓑ③).

`get_campaign_detail` — AC3 "campaign 단위로 소속 원문·변형·상태를 한 번에 주는 조회 API
1개". 소속 content_item(=SitePostDraft, campaign_id로 필터) 각각에 그 원문에서 파생된
channel 변형 목록을 붙인다 — `channel_posts.list_channel_post_drafts`의 `source_content_
item_id` 필터(story #3437 AC2)를 그대로 재사용한다(조인 축을 새로 안 짠다, list_content_
item_variants_endpoint와 동형)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.campaign import Campaign
from app.models.site_post_draft import SitePostDraft
from app.models.site_post_version import SitePostVersion


class CampaignNotFoundError(ValueError):
    """campaign_id가 이 org의 Campaign이 아니다(존재 안 함 또는 다른 org 소속) —
    `get_campaign`의 org_id 조건이 이미 두 경우를 같은 결과(None)로 합쳐 다룬다(존재
    비노출 관례)."""

    def __init__(self, *, campaign_id: uuid.UUID):
        self.campaign_id = campaign_id
        super().__init__(f"campaign을 찾을 수 없습니다: {campaign_id}")


async def get_campaign(db: AsyncSession, *, org_id: uuid.UUID, campaign_id: uuid.UUID) -> Campaign | None:
    return (await db.execute(
        select(Campaign).where(Campaign.id == campaign_id, Campaign.org_id == org_id)
    )).scalar_one_or_none()


async def create_campaign(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    name: str,
    starts_at: datetime | None,
    ends_at: datetime | None,
    created_by_member_id: uuid.UUID,
) -> Campaign:
    campaign = Campaign(
        id=uuid.uuid4(), org_id=org_id, name=name, starts_at=starts_at, ends_at=ends_at,
        created_by_member_id=created_by_member_id,
    )
    db.add(campaign)
    await db.commit()
    await db.refresh(campaign)
    return campaign


async def list_content_items_for_campaign(
    db: AsyncSession, *, org_id: uuid.UUID, campaign_id: uuid.UUID,
) -> list[tuple[SitePostDraft, SitePostVersion]]:
    """이 campaign에 속한 content_item(SitePostDraft)과 각각의 최신 버전(title/lang
    표시용) — site_posts.list_site_post_drafts의 latest-version 조인 축과 동형(단,
    campaign_id 필터 하나뿐이라 origin/gate/publication 배치는 이 자리에서 불요 —
    AC3가 요구하는 것은 "원문·변형·상태" 요약이지 site_posts 목록 계약 전체 재현이
    아니다)."""
    latest_version_ids = (
        select(
            SitePostVersion.draft_id,
            func.max(SitePostVersion.version).label("max_version"),
        )
        .group_by(SitePostVersion.draft_id)
        .subquery()
    )
    stmt = (
        select(SitePostDraft, SitePostVersion)
        .join(latest_version_ids, latest_version_ids.c.draft_id == SitePostDraft.id)
        .join(
            SitePostVersion,
            (SitePostVersion.draft_id == latest_version_ids.c.draft_id)
            & (SitePostVersion.version == latest_version_ids.c.max_version),
        )
        .where(SitePostDraft.org_id == org_id, SitePostDraft.campaign_id == campaign_id)
        .order_by(SitePostVersion.created_at.desc())
    )
    return [(row[0], row[1]) for row in (await db.execute(stmt)).all()]
