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
    op.add_column("invitations", sa.Column("email_sent_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("invitations", sa.Column("email_error", sa.Text, nullable=True))


def downgrade() -> None:
    op.drop_column("invitations", "email_error")
    op.drop_column("invitations", "email_sent_at")
