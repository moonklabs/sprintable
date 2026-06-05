"""add last_org_id to users

0746 후속(0-project org leak): refresh는 org 컨텍스트가 없어 last_project_id=null(0-project org
전환 후)이면 cross-org fallback으로 옛 org project를 재주입한다. 서버가 현재 org를 source-of-truth로
들고 가도록 users.last_org_id를 추가해, _build_app_metadata가 org_id 미지정 시 이 값으로 스코프한다.

additive(nullable + ondelete SET NULL)라 dev/prod 양립 안전·구코드 무영향.
⚠️ deploy-before-migrate: 머지 후 migrate 잡 선행.

Revision ID: 0098
Revises: 0097
Create Date: 2026-06-05
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0098"
down_revision = "0097"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("last_org_id", UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_users_last_org_id",
        "users",
        "organizations",
        ["last_org_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_users_last_org_id", "users", type_="foreignkey")
    op.drop_column("users", "last_org_id")
