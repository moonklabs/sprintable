"""story #2880(카디르 CRITICAL, 2026-08-21) — billing_orders.purpose.

`_latest_confirmed_order()`(org_subscription_tier_change.py)가 "이 org의 가장 최근
confirmed billing_order"를 «직전 구독 결제»로 가정했으나, `billing_orders`엔 주문
종류(구독 charge vs pack 구매) 구분이 전혀 없었다 — pack 구매도 같은 테이블에
confirmed row를 남긴다(billing_pack.py::purchase_packs, charge_org(entry_type=
"pack_purchase")). 그 결과 구독charge 後 pack구매가 있었던 org가 상향하면 pack
주문을 잘못 부분취소하는 실 재현 결함(카디르 실PG 2시나리오 확定, PR#3306 리뷰).

`purpose`는 `charge_org()`가 받는 `entry_type` 파라미터를 그대로 INSERT 시점에
같이 찍는다(billing_ledger_entries.entry_type과 같은 값 — 별도 개념 발명 아님,
billing_orders에도 같은 사실을 갖고 있게 하는 것뿐). 기존 행은 billing_ledger_
entries(provider_ref=payment_key)와 join해 실 entry_type으로 백필 — 매칭 없는
행(pending/failed로 끝나 원장 자체가 없는 행)은 'charge'로 기본값(과거
charge_org() 기본 entry_type과 동일 — 이 스토리 前까지 pack 구매 외엔 전부 charge
였다는 사실 그대로 반영, 새 가정 발명 아님)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0268"
down_revision = "0267"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("billing_orders", sa.Column("purpose", sa.Text(), nullable=True))
    op.execute(
        """
        UPDATE billing_orders bo
        SET purpose = ble.entry_type
        FROM billing_ledger_entries ble
        WHERE bo.payment_key IS NOT NULL AND bo.payment_key = ble.provider_ref
        """
    )
    op.execute("UPDATE billing_orders SET purpose = 'charge' WHERE purpose IS NULL")
    op.alter_column("billing_orders", "purpose", nullable=False, server_default="charge")
    # charge_org() 실 호출부 전수 확認(2026-08-21) — entry_type을 명시하는 곳은
    # billing_pack.py("pack_purchase")뿐, 나머지(checkout·tier_change·admin retry·
    # dunning retry)는 전부 기본값 "charge"거나 기존 order_id 재사용(claim INSERT가
    # ON CONFLICT DO NOTHING이라 purpose는 최초 생성 시점 값 그대로 유지). 실제로
    # 존재하는 두 값만 허용 — 다른 값은 이 CHECK가 스스로 잡는다.
    op.create_check_constraint(
        "ck_billing_orders_purpose", "billing_orders", "purpose IN ('charge', 'pack_purchase')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_billing_orders_purpose", "billing_orders", type_="check")
    op.drop_column("billing_orders", "purpose")
