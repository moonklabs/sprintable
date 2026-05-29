"""S-INV-03: invitations 테이블에 email_sent_at, email_error 컬럼 추가

Revision ID: 0056
Revises: 0055
"""
import sqlalchemy as sa
from alembic import op

revision = "0056"
down_revision = "0055"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # idempotent: 컬럼이 이미 존재하면 무시 — dev 버전 정합용 (S-MIG-FIX AC2)
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing_cols = {c["name"] for c in insp.get_columns("invitations")}
    if "email_sent_at" not in existing_cols:
        op.add_column("invitations", sa.Column("email_sent_at", sa.DateTime(timezone=True), nullable=True))
    if "email_error" not in existing_cols:
        op.add_column("invitations", sa.Column("email_error", sa.Text, nullable=True))


def downgrade() -> None:
    op.drop_column("invitations", "email_error")
    op.drop_column("invitations", "email_sent_at")
