"""story #3528(BE·Phase2, 페드루 PO 確定 2026-09-06) — 댓글 「지속 폴링」 백오프용
`channel_post_comment_collection_schedule.next_attempt_at` additive nullable
컬럼. transient(429/5xx) 실패 시 `next_attempt_at = now + min(2^attempt분, 60분)`
을 채워 다음 tick이 그 시각 전엔 이 행을 안 집게 한다(publication_command.py의
`next_attempt_at` 관례와 동형 — 새 백오프 어휘 0). NULL=백오프 없음(대기 없이
바로 집힘, 기존 행·최초 시도 전부 여기 해당 — 회귀 0).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0341"
down_revision = "0340"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "channel_post_comment_collection_schedule",
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("channel_post_comment_collection_schedule", "next_attempt_at")
