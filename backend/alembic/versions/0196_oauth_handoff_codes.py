"""story 1931(계약 doc `e-mobile-oauth-native-handoff-contract` §4/§7.5(b)·산티아고 §10 MUST):
OAuth 완결→웹뷰 세션 핸드오프용 단회 코드 테이블 신설. attested `auth_native_bootstrap_codes`
(§7.5)와 물리적으로 분리 — installation/challenge FK 없음, 대신 PKCE `code_challenge`에 바인딩
+ `purpose` discriminator(§10.1.1) 고정. 미르코 실측 정정 반영(2026-07-16): 레거시 JWT
발급 대상이라 firebase_uid/project_id/auth_time 컬럼 불필요 — user_id+created_at만 사용.

Revision ID: 0196
Revises: 0195
Create Date: 2026-07-16
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0196"
down_revision = "0195"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "oauth_handoff_codes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("code_hash", sa.Text(), nullable=False, unique=True),
        sa.Column("purpose", sa.Text(), nullable=False),
        sa.Column("code_challenge", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_oauth_handoff_codes_user_id", "oauth_handoff_codes", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_oauth_handoff_codes_user_id", table_name="oauth_handoff_codes")
    op.drop_table("oauth_handoff_codes")
