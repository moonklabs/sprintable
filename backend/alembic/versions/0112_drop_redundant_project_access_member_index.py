"""중복 partial unique 인덱스 정리 — uq_project_access_project_member_id drop (tech-debt·CP2).

0110(18073a52)이 `uq_project_access_project_member_id`(project_id, member_id WHERE member_id NOT NULL)
를 신설했으나, baseline(0075)에 동일 정의 `uq_project_access_project_member_v2`가 이미 존재해 100%
중복이었다(까심 CP2·기능 영향 0). 유일성은 v2 가 계속 enforce 하므로 0110 신설본만 drop.

backward-safe: 데이터 변화 0·v2 가 (project_id, member_id) 유일성 유지·구/신 코드 무영향.

Revision ID: 0112
Revises: 0111
Create Date: 2026-06-10
"""
from alembic import op

revision = "0112"
down_revision = "0111"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_project_access_project_member_id")


def downgrade() -> None:
    # 0110 정의 복원(v2 와 중복이지만 0110→0112 롤백 정합).
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_project_access_project_member_id "
        "ON project_access (project_id, member_id) WHERE member_id IS NOT NULL"
    )
