"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각③a) — 블로그
목적지 축. `site_post_drafts.connection_id`(nullable — null=hosted_site, 값이
있으면 그 `channel_connections` 행이 목적지) + `gate.sealed_destination_
connection_id`(목적지 봉인 축, sealed_content_*/sealed_scheduled_at/sealed_media_
sha256과 같은 공유-nullable 관례 — 신규 테이블 안 판다).

목적지도 "승인 시 봉인"(블루프린트 §3) 대상이다 — 승인 뒤 connection_id가 바뀌면
sealed_scheduled_at/sealed_media_sha256과 동형으로 재승인이 걸린다(코드는
site_posts.py::_reseal_gate_on_new_version 확장, 이 마이그는 그 축의 컬럼만 연다).

FK 없음 — site_post_drafts/channel_post_drafts/channel_connections를 포함한 이
도메인 전체 관례(그라운딩 §9) 그대로.

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
    op.add_column(
        "site_post_drafts",
        sa.Column("connection_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_index("ix_site_post_drafts_connection_id", "site_post_drafts", ["connection_id"])

    op.add_column(
        "gate",
        sa.Column("sealed_destination_connection_id", postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("gate", "sealed_destination_connection_id")

    op.drop_index("ix_site_post_drafts_connection_id", table_name="site_post_drafts")
    op.drop_column("site_post_drafts", "connection_id")
