"""story #3121 AC1(계약 doc `e-mobile-oauth-native-handoff-contract` §2/§10.7·산티아고 SSOT) —
oauth_handoff_codes에 callback_mode+exact return_uri 컬럼 신설. iOS 17.4 미만 custom-scheme
fallback은 계약 §2에 따라 "association 실패 후 동적 전환"이 아니라 "OAuth 시작 전 정적으로
결정되는 호환 모드" — 이 값을 issue 시점에 코드 행에 고정해 consume 시 그대로 대조한다
(다른 모드/URI로 소비 시도 시 원자 UPDATE의 WHERE절에서 매치 실패 → 미소비 상태 유지).

기존 행(있다면 전부 TTL 120초 지나 이미 만료·무해)에 대한 NOT NULL 충족용 server_default만
목적 — 애플리케이션 계층은 항상 명시적 값을 쓴다(0282 vat_rate_bp와 동형 패턴).

Revision ID: 0284
Revises: 0283
Create Date: 2026-08-27
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0284"
down_revision = "0283"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "oauth_handoff_codes",
        sa.Column("callback_mode", sa.Text(), nullable=False, server_default="https"),
    )
    op.add_column(
        "oauth_handoff_codes",
        sa.Column("return_uri", sa.Text(), nullable=False, server_default=""),
    )
    op.create_check_constraint(
        "ck_oauth_handoff_codes_callback_mode",
        "oauth_handoff_codes",
        "callback_mode IN ('https', 'custom_scheme')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_oauth_handoff_codes_callback_mode", "oauth_handoff_codes", type_="check")
    op.drop_column("oauth_handoff_codes", "return_uri")
    op.drop_column("oauth_handoff_codes", "callback_mode")
