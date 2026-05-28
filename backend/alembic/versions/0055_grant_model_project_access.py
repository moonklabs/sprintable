"""S-MBR-10: project_access opt-out → grant 모델 전환

Revision ID: 0055
Revises: 0054

기존: permission='denied' = 차단, 레코드 없음 = 허용 (opt-out)
변경: permission='granted' = 허용, 레코드 없음 = no access (grant/opt-in)

AC4 데이터 마이그레이션:
- 'denied' 레코드 삭제 (grant 모델에서 레코드 없음 = no access로 동일 효과)
- 'allowed' 레코드 → 'granted'로 업데이트
"""
import sqlalchemy as sa
from alembic import op

revision = "0055"
down_revision = "0054"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # denied 레코드 삭제 — grant 모델에서 레코드 없음이 no access를 의미
    op.execute("DELETE FROM project_access WHERE permission = 'denied'")
    # allowed → granted 변환
    op.execute("UPDATE project_access SET permission = 'granted' WHERE permission = 'allowed'")
    # server_default 변경
    op.alter_column(
        "project_access",
        "permission",
        server_default="granted",
        existing_type=sa.Text,
        existing_nullable=False,
    )


def downgrade() -> None:
    op.execute("UPDATE project_access SET permission = 'allowed' WHERE permission = 'granted'")
    op.alter_column(
        "project_access",
        "permission",
        server_default="allowed",
        existing_type=sa.Text,
        existing_nullable=False,
    )
