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
    # 현재 앱 로직(app/routers/auth.py)은 replaced_by를 새 row가 실제 INSERT+commit된 «後»
    # 별개 UPDATE로만 기록하므로 이 시점엔 참조 대상이 이미 존재 — DEFERRABLE INITIALLY
    # DEFERRED가 판정에 필수는 아니다. 다만 폐기된 v1 설계(원자 revoke UPDATE와 «같은» 문장에
    # 미리생성 id를 얹어, revoke 성공 直後 다른 이유로 조기반환하면 deferred FK가 커밋 시점에
    # 위반돼 그 revoke까지 롤백되는 회귀를 냈다 — 카디르 QA REQUEST_CHANGES 2026-08-04)에서
    # 이 옵션이 정확히 그 실패를 잡아준 이력이 있어, 방어적으로 유지한다(무해·재발 방지 여지).
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
