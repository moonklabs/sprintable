"""story #2397 — pricing_versions 신설(forward replay of 0146, DDL만).

배경: develop이 0144에서 갈라져 ee_pricing 브랜치(0145→0146→0147)와 core 브랜치(0148→...→0161)
를 각각 갖다가 0162(순수 병합 노드)에서 합쳤는데, main은 이 ee_pricing 브랜치 자체가 없어(0146·
0147·0162 셋 다 부재) 0163 리비전을 develop과 다른 부모(0161)로 따로 만들었다 — 같은 revision id
"0163"가 두 브랜치에서 서로 다른 down_revision을 가리키는 포크가 생겼다(#2397 발견).

prod 실측(2026-08-01, PO): alembic_version이 이미 "0220"(main 체인의 head)이고, develop의
head도 우연히 같은 문자열 "0220"이다 — 즉 지금 이대로 develop→main을 승격하면 `alembic upgrade
head`가 **no-op**이 된다(두 head 이름이 같아 "이미 최신"으로 보임). 그러면 pricing_versions를
만드는 0146·0147은 영원히 실행될 기회를 잃는다 — 건너뛰는 정도가 아니라 다시 돌 방법이 없다.
그런데 prod에 pricing_versions는 실제로 없고, 코드(ee/routers/billing.py)는 그 테이블을 읽는다.

처방(PO 판정 ㉢, #2397 AC2): 과거 체인을 소급 수정하지 않고 — 되돌릴 수 없는 자리를 건드리지
않고 — head 앞으로 새 리비전을 하나 더 얹는다. 0162(순수 no-op 병합 마커, prod엔 애초에 그
dual-head 상황 자체가 없어 재현 대상이 아님)는 제외하고, 0146의 DDL만 그대로 재현한다(app/
models/pricing_version.py·org_subscription.py의 현재 선언과 대조해 드리프트 없음 확認).

⛔0147(실 Polar live 가격 10건 시드)은 이 마이그에 **의도적으로 포함하지 않는다** — 그 값이
2026-07-07 당시의 실 가격인데 지금도 유효한지 이 세션에서 검증할 수 없다(Polar 쪽 상태). DDL과
DML을 한 마이그로 묶으면 시드값이 틀렸을 때 되돌리기 어렵다(PO 판단) — 확認되는 대로 별도
후속 마이그(0222 이후)로 붙인다. 이 마이그만으로는 org_subscriptions.pricing_version_id는
전부 NULL로 남는다(0146 설계상 nullable — free tier·아직 유료 미가입 구독 모두 정상 NULL).

이 리비전은 develop에만 존재한다 — main은 다음 승격(#2397 AC5 나머지 다섯 드리프트 판정 후)으로
정상적으로 받는다. main에 직접 얹지 않는다(그것이 바로 이 사고를 만든 패턴이라 PO가 명시 금지).

⛔⛔**idempotent 가드 필수 — 두 서로 다른 실제 이력이 이 노드를 통과한다**:
- **develop 자체의 진짜 이력**(0146→0147→...→0162→...→0220→0221)을 처음부터 순서대로 밟는
  모든 DB(신규 CI/dev 인스턴스 등)는 0146이 **이미** pricing_versions를 만들었은 채로 이
  리비전에 도달한다 — 그대로 create_table하면 DuplicateTable로 죽는다(로컬 alembic upgrade
  head 재현으로 실제로 확認: 이 파일을 무조건부로 작성했다가 이 에러로 즉시 잡았다).
- **prod의 실제 이력**은 0146/0147/0162를 한 번도 거치지 않고 main의 갈래(0161→0163[down=
  0161]→...→0220)로 왔다 — 이 리비전에서 pricing_versions가 진짜 처음 생긴다.
같은 파일이 두 이력 모두를 통과해야 하므로, "이미 있으면 스킵"으로 양쪽 다 안전하게 만든다 —
어느 이력을 밟았는지 알 필요 없이 최종 상태만 보장한다(idempotent = 이력 무관 수렴).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0221"
down_revision = "0220"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("pricing_versions"):
        return
    op.create_table(
        "pricing_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tier", sa.Text(), nullable=False),
        sa.Column("billing_cycle", sa.Text(), nullable=False),
        sa.Column("currency", sa.Text(), nullable=False, server_default="usd"),
        sa.Column("price_cents", sa.Integer(), nullable=False),
        sa.Column("polar_price_id", sa.Text(), nullable=False),
        sa.Column("effective_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("effective_to", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint(
            "tier = ANY (ARRAY['team'::text, 'pro'::text, 'overage'::text])",
            name="pricing_versions_tier_check",
        ),
        sa.CheckConstraint(
            "billing_cycle = ANY (ARRAY['monthly'::text, 'yearly'::text])",
            name="pricing_versions_billing_cycle_check",
        ),
        sa.CheckConstraint(
            "currency = ANY (ARRAY['usd'::text, 'krw'::text])", name="pricing_versions_currency_check"
        ),
        sa.CheckConstraint("price_cents >= 0", name="pricing_versions_price_cents_check"),
        sa.CheckConstraint("effective_to IS NULL OR effective_to > effective_from", name="pricing_versions_effective_range_check"),
    )
    op.create_index(
        "ix_pricing_versions_lineage_effective_from",
        "pricing_versions",
        ["tier", "billing_cycle", "currency", sa.text("effective_from DESC")],
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
    # upgrade()의 idempotent 가드와 대칭 — 어느 이력에서 이 테이블이 생겼는지(0146 vs 이
    # 리비전) 사후에 구분할 방법이 없으므로, "있으면 지운다"로 단순화한다(downgrade는 실무상
    # 거의 안 쓰이는 경로라 이 단순화의 리스크가 낮다 — PO 판단).
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table("pricing_versions"):
        return
    op.drop_index("ix_org_subscriptions_pricing_version_id", table_name="org_subscriptions")
    op.drop_constraint("fk_org_subscriptions_pricing_version_id", "org_subscriptions", type_="foreignkey")
    op.drop_column("org_subscriptions", "pricing_version_id")
    op.drop_index("ix_pricing_versions_lineage_effective_from", table_name="pricing_versions")
    op.drop_table("pricing_versions")
