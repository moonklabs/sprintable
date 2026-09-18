"""story #3414(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — publication_commands.

발행 명령 원장. 블루프린트 v3 §3 멱등키(org_id+destination+approved_version+
operation) 그대로 UNIQUE. 휴먼의 발행/예약 요청(POST .../publish)이 이 행을
만든다(승인 자체는 트리거가 아니다 — "승인 없는 명령이 없다"일 뿐, PO 確定 (B)
2026-09-04). gate_id는 FK 없음(channel_connections·channel_post_drafts와 동일
관례) — 승인 뒤 편집 시 이 gate에 걸린 pending 명령을 voided로 무효화하는
조회(void_pending_commands_for_gate)의 유일한 키.

failure_kind/dead_letter_at은 유나 T9 계약(화면이 실패를 조립하지 않게 서버가
값으로 준다) — 이 PR은 저장까지, 목록/단건 노출은 후속 story #3415.

Revision ID: 0318
Revises: 0317
Create Date: 2026-09-04
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0318"
down_revision = "0317"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "publication_commands",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("gate_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("destination", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("approved_version", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("operation", sa.Text(), nullable=False, server_default="publish"),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("reason_code", sa.Text(), nullable=True),
        sa.Column("failure_kind", sa.Text(), nullable=True),
        sa.Column("dead_letter_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("requested_by_member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False,
        ),
        sa.UniqueConstraint(
            "org_id", "destination", "approved_version", "operation",
            name="uq_publication_commands_idempotency",
        ),
    )
    op.create_index("ix_publication_commands_org_id", "publication_commands", ["org_id"])
    op.create_index("ix_publication_commands_gate_id", "publication_commands", ["gate_id"])
    # cron 워커 클레임 쿼리(status='pending' AND scheduled_at<=now())의 인덱스 축.
    op.create_index(
        "ix_publication_commands_status_scheduled_at",
        "publication_commands", ["status", "scheduled_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_publication_commands_status_scheduled_at", table_name="publication_commands")
    op.drop_index("ix_publication_commands_gate_id", table_name="publication_commands")
    op.drop_index("ix_publication_commands_org_id", table_name="publication_commands")
    op.drop_table("publication_commands")
