"""story #2349 AC3 — 1:1 사용자 차단(user_blocks). Play UGC 정책이 요구하는 block.

blocker_member_id가 blocked_member_id를 차단하면, 그 발신자의 DM/멘션이 (알림 감산+FE
마스킹으로) 안 온다.

⚠️실측(2026-08-02, 디디 — 프레시 DB 마이그 시도 중 실패로 발견): PO 계약은 "team_members.id로
키를 잡는다"였으나, `team_members`는 실제로는 **VIEW**다(`members ⋈ project_access`, baseline
schema.sql:2040) — VIEW에는 FK 제약을 못 건다(포스트그레스 하드 제약, "referenced relation
team_members is not a table"로 CREATE TABLE 자체가 실패). `conversation_participants.member_id`
도 같은 이유로 실 DB엔 FK가 없다(ORM 모델만 `ForeignKey("team_members.id")`를 선언 — 문서화
목적, 실 제약 아님. baseline schema.sql 직접 grep으로 확認: conversation_participants는
conversation_id FK만 있고 member_id FK는 없음). 이 마이그레이션도 동일 패턴을 따른다 — 컬럼만
두고 실 FK 제약은 안 건다. 모델(app/models/user_block.py)의 `ForeignKey` 선언도 같은 이유로
제거했다(선언해도 걸리지 않는 채 오해만 남기는 것보다 없는 편이 정직하다).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0225"
down_revision = "0224"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_blocks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("blocker_member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("blocked_member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("blocker_member_id", "blocked_member_id", name="uq_user_block_pair"),
    )
    op.create_index("ix_user_blocks_blocker_member_id", "user_blocks", ["blocker_member_id"])
    op.create_index("ix_user_blocks_blocked_member_id", "user_blocks", ["blocked_member_id"])


def downgrade() -> None:
    op.drop_index("ix_user_blocks_blocked_member_id", table_name="user_blocks")
    op.drop_index("ix_user_blocks_blocker_member_id", table_name="user_blocks")
    op.drop_table("user_blocks")
