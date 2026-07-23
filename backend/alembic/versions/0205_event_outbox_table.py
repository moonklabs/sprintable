"""E-ARCH S3(story #2078) 3a단계 — 트랜잭셔널 아웃박스 스캐폴딩 테이블. `EventBroker` 콜사이트
(publish_event()/_push_to_agent(), 10파일 20곳)의 payload를 durable하게 적재해 realtime-gateway의
outbox_dispatcher_loop()가 Redis로 폴링·발행한다. 이 단계에서는 아직 caller의 commit과 같은
트랜잭션이 아니다(3b에서 콜사이트별 이관 예정) — 지금은 "재시도 가능한 큐"만 얻는다.

Revision ID: 0205
Revises: 0204
Create Date: 2026-07-21
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0205"
down_revision = "0204"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "event_outbox",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("target", sa.Text(), nullable=False),
        sa.Column("target_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("target IN ('org', 'agent')", name="ck_event_outbox_target"),
    )
    op.create_index("ix_event_outbox_org_id", "event_outbox", ["org_id"])
    # dispatcher 폴링 축 — published_at IS NULL 부분 인덱스(unpublished row는 항상 소수).
    op.create_index(
        "ix_event_outbox_pending", "event_outbox", ["id"],
        postgresql_where=sa.text("published_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_event_outbox_pending", table_name="event_outbox")
    op.drop_index("ix_event_outbox_org_id", table_name="event_outbox")
    op.drop_table("event_outbox")
