"""B2(9f27af8f): retro_items 그룹핑(parent_item_id self-FK) + vote_count 근본수정.

배경: `retro_items.vote_count`가 baseline 이래 어디서도 증가되지 않던 버그(B4 작업 중 발견) —
`RetroVoteRepository.vote()`가 RetroVote row만 insert. 이 마이그가 (a) 기존 데이터를
`retro_votes` 실측 COUNT로 재계산(backfill = 추측 아닌 source-of-truth 재집계) (b) 앞으로는
`vote()`가 원자적 +1을 유지하도록 app 코드가 짝을 맞춤(별도 커밋, 이 마이그는 스키마만).

`retro_votes(item_id, voter_id)` unique 제약도 신설 — 기존은 app-level pre-check(SELECT 후
INSERT)뿐이라 동시 요청 레이스에서 중복 투표가 가능했음(TOCTOU). 제약 추가 전 기존 중복이
있으면 위반이라 먼저 dedupe(오래된 것 유지 — created_at·id 순 1건만 남김)한다.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0144"
down_revision = "0143"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "retro_items",
        sa.Column("parent_item_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_retro_items_parent_item_id",
        "retro_items",
        "retro_items",
        ["parent_item_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_check_constraint(
        "retro_items_parent_not_self_check",
        "retro_items",
        "parent_item_id IS NULL OR parent_item_id <> id",
    )
    op.create_index("idx_retro_items_parent_item_id", "retro_items", ["parent_item_id"])
    op.create_index("idx_retro_items_session_parent", "retro_items", ["session_id", "parent_item_id"])

    # 기존 중복 투표 dedupe(가장 오래된 1건만 유지) — unique 제약 추가 전 선행 필수.
    op.execute(
        """
        WITH ranked AS (
          SELECT id,
                 row_number() OVER (
                   PARTITION BY item_id, voter_id
                   ORDER BY created_at, id
                 ) AS rn
          FROM retro_votes
        )
        DELETE FROM retro_votes rv
        USING ranked r
        WHERE rv.id = r.id AND r.rn > 1
        """
    )
    op.create_unique_constraint(
        "uq_retro_votes_item_voter",
        "retro_votes",
        ["item_id", "voter_id"],
    )

    # vote_count 실측 재계산(추측 backfill 아님 — retro_votes 가 source of truth).
    op.execute(
        """
        UPDATE retro_items ri
        SET vote_count = COALESCE(v.cnt, 0)
        FROM (
          SELECT ri2.id, COUNT(rv.id)::integer AS cnt
          FROM retro_items ri2
          LEFT JOIN retro_votes rv ON rv.item_id = ri2.id
          GROUP BY ri2.id
        ) v
        WHERE ri.id = v.id
        """
    )


def downgrade() -> None:
    op.drop_constraint("uq_retro_votes_item_voter", "retro_votes", type_="unique")
    op.drop_index("idx_retro_items_session_parent", table_name="retro_items")
    op.drop_index("idx_retro_items_parent_item_id", table_name="retro_items")
    op.drop_constraint("retro_items_parent_not_self_check", "retro_items", type_="check")
    op.drop_constraint("fk_retro_items_parent_item_id", "retro_items", type_="foreignkey")
    op.drop_column("retro_items", "parent_item_id")
