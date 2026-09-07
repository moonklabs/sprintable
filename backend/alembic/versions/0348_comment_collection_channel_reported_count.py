"""story #3618(Phase2·BE+FE·실측, 페드루 PO 確定 2026-09-07) — `channel_post_comment_
collection_schedule`에 `channel_reported_comment_count` additive. 댓글 누락률
(§7 Phase2 실측 열) 정의의 분모(「채널이 말한 댓글 수」)를 수집 성공 시점에 남긴다 —
채널이 그 수를 안 주면(대부분의 실 어댑터가 summary 필드를 요청 안 하면 못 준다)
NULL="미측정"(0과 구분, null≠0 정규화 규약 그대로 승계).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0348"
down_revision = "0347"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "channel_post_comment_collection_schedule",
        sa.Column("channel_reported_comment_count", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("channel_post_comment_collection_schedule", "channel_reported_comment_count")
