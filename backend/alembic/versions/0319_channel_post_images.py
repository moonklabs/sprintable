"""story #f8f7cb0f/620beefc(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — Threads 이미지
발행: channel_post_images 원장(원본+파생본 계보) + 재승인 판정 축 분리(media).

`channel_post_images` — org·draft·version 스코프(그라운딩 §④, story 본문 AC1). 한 버전에
이미지 최대 1건(Phase1, `ChannelAdapterConfig.image_max_count`) — `version_id` UNIQUE로
DB 레벨 강제. FK 없음 — `channel_publications`/`publication_commands`와 동일 관례(그라운딩
§9, gate_id/destination 등 이 도메인 전체가 FK 미사용).

`channel_post_versions.image_sha256`(추가 컬럼) — 이 버전이 봉인하는 이미지의 「나가는
파생본」 sha256(derived_sha256 있으면 그 값, 없으면 original_sha256 — 서비스 계층이
결정). `body_sha256`(text/link_url만)과 **분리된 별도 축** — 합치면 "본문이 바뀌었나
이미지가 바뀌었나"를 재승인 판정에서 다시 구별 못 한다(PO 決定 ④, AC4 "재승인 판정
축 세분화 content|schedule|media").

`gate.sealed_media_sha256`(추가 컬럼) — `sealed_content_sha256`과 짝인 두 번째 봉인
축. 승인 시점 이 값과 현재 버전의 `image_sha256`이 다르면 `MEDIA_CHANGED`로 재승인
필요(`sealed_scheduled_at`이 §3 예약 축을 위해 0317에서 같은 방식으로 추가된 선례
그대로 — 신규 테이블을 안 판다, gate 하나가 이미 "봉인" 역할을 도맡는다).

Revision ID: 0319
Revises: 0318
Create Date: 2026-09-04
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0319"
down_revision = "0318"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "channel_post_images",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("draft_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("original_object_path", sa.Text(), nullable=False),
        sa.Column("original_sha256", sa.Text(), nullable=False),
        sa.Column("original_content_type", sa.Text(), nullable=False),
        sa.Column("original_bytes", sa.BigInteger(), nullable=False),
        sa.Column("original_width", sa.Integer(), nullable=False),
        sa.Column("original_height", sa.Integer(), nullable=False),
        # 파생본이 필요 없었으면(원본이 이미 규격 안) 전부 NULL — "나가는 파생본"은
        # 그때 원본 자신이다(서비스 계층의 final_* 계산이 이 NULL을 원본으로 폴백).
        sa.Column("derived_object_path", sa.Text(), nullable=True),
        sa.Column("derived_sha256", sa.Text(), nullable=True),
        sa.Column("derived_content_type", sa.Text(), nullable=True),
        sa.Column("derived_bytes", sa.BigInteger(), nullable=True),
        sa.Column("derived_width", sa.Integer(), nullable=True),
        sa.Column("derived_height", sa.Integer(), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("version_id", name="uq_channel_post_images_version"),
    )
    op.create_index("ix_channel_post_images_org_id", "channel_post_images", ["org_id"])
    op.create_index("ix_channel_post_images_draft_id", "channel_post_images", ["draft_id"])

    op.add_column(
        "channel_post_versions",
        sa.Column("image_sha256", sa.Text(), nullable=True),
    )
    op.add_column(
        "gate",
        sa.Column("sealed_media_sha256", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("gate", "sealed_media_sha256")
    op.drop_column("channel_post_versions", "image_sha256")
    op.drop_index("ix_channel_post_images_draft_id", table_name="channel_post_images")
    op.drop_index("ix_channel_post_images_org_id", table_name="channel_post_images")
    op.drop_table("channel_post_images")
