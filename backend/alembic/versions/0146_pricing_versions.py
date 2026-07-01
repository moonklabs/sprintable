"""E-ADMIN B1(story 553fc58d): pricing_versions 신설 + org_subscriptions grandfather FK.

가격을 ee/billing.py의 하드코딩 상수(_PLAN_CATALOG/_PLAN_PRICES)에서 DB로 이관하기 위한
버전 이력 테이블. **append-only**(가격 값은 절대 UPDATE 안 됨) — 새 가격은 항상 새 행으로
추가되고, 이전 "열린"(effective_to IS NULL) 행은 새 행 추가 시 그 effective_from으로
effective_to를 닫는다(행 자체를 닫는 것이지 가격값을 바꾸는 게 아님).

`org_subscriptions.pricing_version_id`는 grandfather 메커니즘의 핵심 — 구독이 가입(또는
플랜변경)한 시점의 pricing_version을 참조해, 이후 가격이 바뀌어도 기존 구독은 원래 가격을
유지한다. nullable인 이유: (a) free tier는 가격이 항상 0이라 버전 이력 대상에서 제외(무의미)
(b) 이 마이그는 **구조만** 만든다 — 실제 OLD/NEW pricing_versions 행 삽입과 기존 구독의
pricing_version_id 백필은 실 가격 VALUES가 확정된 후 별도 후속 마이그로 수행한다(PO
결정 대기 — 이 마이그에 추측 숫자를 넣지 않기 위함).

free tier 제외: pricing_versions.tier는 'team'|'pro'만 허용(CHECK) — free는 가격이 항상
0이라 버전 이력을 관리할 이유가 없다는 판단(디디 권고, PO 확인).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0146"
down_revision = "0145"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "pricing_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tier", sa.Text(), nullable=False),
        sa.Column("billing_cycle", sa.Text(), nullable=False),
        # 정수 cents — float 부동소수 반올림 리스크 0(release_notes epoch-µs 정수 토큰과 동일 원칙).
        sa.Column("price_cents", sa.Integer(), nullable=False),
        sa.Column("effective_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("effective_to", sa.DateTime(timezone=True), nullable=True),
        # operator email — internal-api L1 인증 principal(사람 IAP email or agent SA principal).
        sa.Column("created_by", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("tier = ANY (ARRAY['team'::text, 'pro'::text])", name="pricing_versions_tier_check"),
        sa.CheckConstraint(
            "billing_cycle = ANY (ARRAY['monthly'::text, 'yearly'::text])",
            name="pricing_versions_billing_cycle_check",
        ),
        sa.CheckConstraint("price_cents >= 0", name="pricing_versions_price_cents_check"),
        sa.CheckConstraint("effective_to IS NULL OR effective_to > effective_from", name="pricing_versions_effective_range_check"),
    )
    # "현재가" 조회 패턴(tier+billing_cycle당 최신 effective_from WHERE <= now())을 위한 인덱스.
    op.create_index(
        "ix_pricing_versions_tier_cycle_effective_from",
        "pricing_versions",
        ["tier", "billing_cycle", sa.text("effective_from DESC")],
    )

    op.add_column(
        "org_subscriptions",
        sa.Column("pricing_version_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_org_subscriptions_pricing_version_id",
        "org_subscriptions",
        "pricing_versions",
        ["pricing_version_id"],
        ["id"],
    )
    op.create_index(
        "ix_org_subscriptions_pricing_version_id",
        "org_subscriptions",
        ["pricing_version_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_org_subscriptions_pricing_version_id", table_name="org_subscriptions")
    op.drop_constraint("fk_org_subscriptions_pricing_version_id", "org_subscriptions", type_="foreignkey")
    op.drop_column("org_subscriptions", "pricing_version_id")
    op.drop_index("ix_pricing_versions_tier_cycle_effective_from", table_name="pricing_versions")
    op.drop_table("pricing_versions")
