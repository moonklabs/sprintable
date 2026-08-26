"""story #3097(선생님 결정 2026-08-26) — platform_settings.vat_rate_bp.

v2.3 확定가는 공급가(부가세 별도) — 청구 시점에 VAT를 가산한다. 실측(디디, #3097)으로
백엔드 청구 파이프라인 전체에 VAT 승수가 없었음을 확認(구독 체크아웃 표시=VAT 포함
31,900원인데 실 Toss 청구는 29,000원 그대로 — 표시≠청구 10% 불일치). 하드코딩 금지
원칙(AC6 — dunning_grace_days와 동일 선례)에 따라 어드민 관리값으로 — 기본 1000bp(10%,
현행 부가세율)로 시드.

basis points(1bp=0.01%) 정수 표현 — 부동소수점 반올림 오차를 DB 계층에서부터 배제.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0282"
down_revision = "0281"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "platform_settings",
        sa.Column("vat_rate_bp", sa.Integer(), nullable=False, server_default="1000"),
    )
    op.create_check_constraint(
        "ck_platform_settings_vat_rate_bp_range",
        "platform_settings",
        "vat_rate_bp >= 0 AND vat_rate_bp <= 10000",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_platform_settings_vat_rate_bp_range", "platform_settings", type_="check",
    )
    op.drop_column("platform_settings", "vat_rate_bp")
