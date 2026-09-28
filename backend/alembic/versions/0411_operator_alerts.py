"""story #4341 — 플랫폼 운영 알림(operator_alerts). 결제 늦은 성공 무효 · 확정 환불 실패 · 발행 예산 밖이 logger.error 한 줄로 끝나
받는 사람이 0이던 결함 클래스의 받는 곳. 멱등(dedupe_key unique)과 재시도(pending · next_attempt_at)를 이 표 하나가 쥔다.

- status: pending / delivered(메시지 행 커밋 뒤에만). 종결 실패 없음 — 전달 실패는 재시도(비종결).
- target_org_id FK 없음: 운영 기록이라 대상 조직 · 시도가 지워져도 남는다.
- 부분 인덱스 (next_attempt_at) WHERE status='pending' — 재시도 스윕이 읽는 정렬.

번호: 착지 순 사다리 — 결제 4704(4335)가 0410(down 0409)으로 먼저 PR이 열려 이 파일은 0411(down 0410). 둘 다 0409를 부모로 열면
sibling 가드가 양쪽 CI를 막는다(0406 선례). 4704 병합 전까지 이 PR의 fresh-DB alembic upgrade는 RED — 예상 상태.

Revision ID: 0411
Revises: 0410
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0411"
down_revision = "0410"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "operator_alerts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("dedupe_key", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("target_org_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("target", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("facts", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("message_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("dedupe_key", name="operator_alerts_dedupe_key_key"),
        sa.CheckConstraint("status IN ('pending', 'delivered')", name="ck_operator_alerts_status"),
        sa.CheckConstraint("attempt_count >= 0", name="ck_operator_alerts_attempt_count"),
    )
    op.create_index(
        "ix_operator_alerts_pending_due", "operator_alerts", ["next_attempt_at"],
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index("ix_operator_alerts_pending_due", table_name="operator_alerts")
    op.drop_table("operator_alerts")
