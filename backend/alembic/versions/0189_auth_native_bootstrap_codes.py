"""story 4dee942b(E-AUTH-REBUILD M2 Phase1-S5): auth_native_bootstrap_codes 테이블(doc §9.1·
산티아고 §9 코드 보안계약 2026-07-15). 단회 부트스트랩 코드는 HASH만 저장(원문 미저장) —
발급 시 생성한 raw code는 클라이언트에게만 반환되고 DB엔 절대 남지 않는다.

Revision ID: 0189
Revises: 0188
Create Date: 2026-07-16

additive — 기존 스키마 무회귀.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0189"
down_revision = "0188"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "auth_native_bootstrap_codes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("firebase_uid", sa.Text(), nullable=False),
        # 산티아고 §9: exact Firebase project/tenant 바인딩 — 크로스 환경 코드 재생 방지.
        sa.Column("project_id", sa.Text(), nullable=False),
        # code_hash만 저장(원문 미저장). SHA-256 hex.
        sa.Column("code_hash", sa.Text(), nullable=False),
        # App Check 기반 device binding proof hash — 발급 시점에 App Check 검증이 요구되지
        # 않았으면 NULL(소비 시 device proof 불요), 값이 있으면 소비 시 정확 일치 필수.
        sa.Column("device_binding_hash", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_unique_constraint("uq_auth_native_bootstrap_codes_code_hash", "auth_native_bootstrap_codes", ["code_hash"])
    op.create_index("ix_auth_native_bootstrap_codes_user_id", "auth_native_bootstrap_codes", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_auth_native_bootstrap_codes_user_id", table_name="auth_native_bootstrap_codes")
    op.drop_constraint("uq_auth_native_bootstrap_codes_code_hash", "auth_native_bootstrap_codes", type_="unique")
    op.drop_table("auth_native_bootstrap_codes")
