"""story #3437(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — 콘텐츠 원장 투영: campaign
묶음 + Threads 변형(channel_post_draft)→블로그 원문(site_post_draft=content_item) 파생
관계. 그라운딩(스토리 코멘트) 결론 그대로 부재분 2건만 신설 — content_item/content_version/
publication은 site_post_draft/site_post_version·channel_post_version·channel_publication을
그대로 투영한다(신규 테이블 0, 처분표 6행).

`campaigns` — org·이름·기간·상태 최소(PO 確定 1~4 ③). FK 없음 — site_post_drafts/
channel_post_drafts를 포함한 이 도메인 전체가 FK 미사용 관례(그라운딩 §9 그대로 재사용,
신규 예외를 만들지 않는다).

`channel_post_drafts.source_content_item_id`(신규 컬럼) — 이 채널 변형이 파생된 content_item
(=site_post_drafts.id, PO 보정 ⓐ: 스크립트 생성분 옛 site_posts는 draft가 없어 이 스토리
범위 밖). nullable — 소스 없는 단독 채널 초안도 계속 허용한다(기존 회귀, AC6). FK 없음(동일
관례) — org 일치 검증은 서비스 계층이 매번 한다(생성 시점, 422).

`site_post_drafts.campaign_id`(신규 컬럼) — content_item이 속하는 campaign(PO 確定 1~4
④). nullable — campaign 없는 단독 글 허용(AC3 명시).

Revision ID: 0321
Revises: 0320
Create Date: 2026-09-04
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0321"
down_revision = "0320"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "campaigns",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column("created_by_member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False,
        ),
    )
    op.create_index("ix_campaigns_org_id", "campaigns", ["org_id"])

    op.add_column(
        "channel_post_drafts",
        sa.Column("source_content_item_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_index(
        "ix_channel_post_drafts_source_content_item_id",
        "channel_post_drafts", ["source_content_item_id"],
    )

    op.add_column(
        "site_post_drafts",
        sa.Column("campaign_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_index("ix_site_post_drafts_campaign_id", "site_post_drafts", ["campaign_id"])


def downgrade() -> None:
    op.drop_index("ix_site_post_drafts_campaign_id", table_name="site_post_drafts")
    op.drop_column("site_post_drafts", "campaign_id")

    op.drop_index("ix_channel_post_drafts_source_content_item_id", table_name="channel_post_drafts")
    op.drop_column("channel_post_drafts", "source_content_item_id")

    op.drop_index("ix_campaigns_org_id", table_name="campaigns")
    op.drop_table("campaigns")
