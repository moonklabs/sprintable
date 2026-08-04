"""refresh_tokens.replaced_by — story #2449 로그인 세션 풀림 근본(successor chain 계보 컬럼)

Revision ID: 0226
Revises: 0225
Create Date: 2026-08-04
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0226"
down_revision = "0225"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "refresh_tokens",
        sa.Column("replaced_by", UUID(as_uuid=True), nullable=True),
    )
    # DEFERRABLE INITIALLY DEFERRED 필수 — /refresh 원자 rotation은 «같은 트랜잭션» 안에서
    # old row.replaced_by=<미리 생성한 새 id> 를 먼저 UPDATE 하고, 그 id를 가진 새 row는
    # 나중에(같은 트랜잭션 커밋 前) INSERT 한다. 즉시(non-deferred) FK면 UPDATE 시점에 참조
    # 대상이 아직 없어 매번 ForeignKeyViolationError — 로컬 realdb 테스트로 실제로 잡았다.
    op.create_foreign_key(
        "fk_refresh_tokens_replaced_by",
        "refresh_tokens",
        "refresh_tokens",
        ["replaced_by"],
        ["id"],
        ondelete="SET NULL",
        deferrable=True,
        initially="DEFERRED",
    )


def downgrade() -> None:
    op.drop_constraint("fk_refresh_tokens_replaced_by", "refresh_tokens", type_="foreignkey")
    op.drop_column("refresh_tokens", "replaced_by")
