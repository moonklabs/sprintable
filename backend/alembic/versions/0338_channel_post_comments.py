"""story #3516(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 댓글 수집+답변 조각①.
블루프린트 v3 §2 「댓글·반응 대응」 MVP. 3테이블:

- `channel_post_comments` — 수집된 댓글 원장. (publication_id, external_comment_id)
  UNIQUE(멱등 upsert 축, 3497 insight_snapshot과 동형 관례). `deleted_at`은 재수집
  시 원격에 더는 없는 댓글을 표시하는 소프트 삭제(하드 삭제 안 함 — 답변 이력 보존).
- `channel_post_comment_replies` — 답변 스키마 선제 등재(조각②가 실제로 쓴다, 조각①은
  테이블만·write 0). `gate_id`+`command_id`는 FK 없음(channel_connections·channel_
  post_drafts와 동일 관례, 그라운딩 §9).
- `channel_post_comment_collection_schedule` — insight_snapshot의 due_at 스케줄링
  뼈대를 그대로(SKIP LOCKED 워커) 재사용·미러(같은 테이블 공유 안 함 — 댓글 수집은
  «몇 개 잡혔다»가 아니라 «시도 자체의 성공/실패»만 원장에 남기면 되고, insight_
  snapshot처럼 하나의 정규화값을 담을 필요가 없어 별도 스키마가 더 맞다). UNIQUE
  (publication_id, due_at) 동형 — 같은 발행 재처리에도 멱등.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0338"
down_revision = "0337"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "channel_post_comments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("publication_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("external_comment_id", sa.Text(), nullable=False),
        sa.Column("author_display_name", sa.Text(), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("text_sha256", sa.Text(), nullable=False),
        sa.Column("external_created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("captured_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("raw", postgresql.JSONB(), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("publication_id", "external_comment_id", name="uq_channel_post_comments_publication_external"),
    )
    op.create_index("ix_channel_post_comments_org_id", "channel_post_comments", ["org_id"])
    op.create_index("ix_channel_post_comments_publication_id", "channel_post_comments", ["publication_id"])

    op.create_table(
        "channel_post_comment_replies",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("comment_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("gate_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("command_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="draft", nullable=False),
        sa.Column("external_reply_id", sa.Text(), nullable=True),
        sa.Column("external_reply_url", sa.Text(), nullable=True),
        sa.Column("created_by_member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_by_kind", sa.Text(), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_channel_post_comment_replies_org_id", "channel_post_comment_replies", ["org_id"])
    op.create_index("ix_channel_post_comment_replies_comment_id", "channel_post_comment_replies", ["comment_id"])
    op.create_index("ix_channel_post_comment_replies_gate_id", "channel_post_comment_replies", ["gate_id"])

    op.create_table(
        "channel_post_comment_collection_schedule",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("publication_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("external_id", sa.Text(), nullable=True),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.Text(), server_default="pending", nullable=False),
        sa.Column("attempt_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("publication_id", "due_at", name="uq_comment_collection_schedule_publication_due_at"),
    )
    op.create_index("ix_comment_collection_schedule_org_id", "channel_post_comment_collection_schedule", ["org_id"])
    op.create_index(
        "ix_comment_collection_schedule_due_at", "channel_post_comment_collection_schedule", ["due_at"],
    )


def downgrade() -> None:
    op.drop_table("channel_post_comment_collection_schedule")
    op.drop_table("channel_post_comment_replies")
    op.drop_table("channel_post_comments")
