"""E-ADMIN B1(story 553fc58d): pricing_versions live 시드 — Polar 실 상품/가격 10건.

선생님 GO + Polar live org(Moonklabs, `fead0e80-7a08-4caf-ad4f-ab6255e80ff8`) 상품 생성
완료 후 확정된 실 가격(doc `e-admin-b1-polar-live-price-ids` SSOT). Team $49/mo·$490/yr,
Pro $149/mo·$1490/yr(연간 ~17%↓), API overage $1/mo — 각 USD+KRW 2종.

**OLD 앵커 불필요**: 0146 설계상 grandfather는 기존 구독을 OLD 버전에 백필하는 메커니즘이나,
이 배포 시점 live에 Team/Pro 유료 구독이 0건이라(백필할 대상 자체가 없음) 앵커 없이 전부
NEW 버전으로 시드한다. grandfather 메커니즘 자체는 향후 가격 변경 시 정상 작동한다.

price_cents는 통화별 최소단위 그대로(USD=센트·KRW=원, Polar 규칙과 동일) — float 아닌
정수 리터럴로 하드코딩(반올림 리스크 0).

idempotent 아님(append-only 원칙상 재실행 방지 불필요 — 이 마이그는 초기 시드 1회용,
이미 존재하는 (tier,billing_cycle,currency) 조합에 대한 재삽입은 CHECK만으로는 안 막히지만
운영상 이 마이그는 1회만 실행됨. downgrade는 이 마이그가 삽입한 10건만 tier+INSERT 시각
기준이 아니라 명시 polar_price_id로 정확히 식별해 제거)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0147"
down_revision = "0146"
branch_labels = None
depends_on = None

_CREATED_BY = "migration:0147_pricing_live_seed"

# (tier, billing_cycle, currency, price_cents, polar_price_id)
_SEED = [
    ("team", "monthly", "usd", 4900, "7d501b9f-f8b0-45ac-9b3f-817a3370ce9f"),
    ("team", "monthly", "krw", 67000, "3d1bae90-be94-496b-832e-f4178c658eea"),
    ("team", "yearly", "usd", 49000, "9a251b0e-e16c-45a6-a977-3351bada5b9e"),
    ("team", "yearly", "krw", 670000, "684deacc-7c31-4fe7-96ae-5c7408feded8"),
    ("pro", "monthly", "usd", 14900, "deefdbe9-ed44-4f60-a485-201215234e0b"),
    ("pro", "monthly", "krw", 204000, "a48fca24-3374-4a78-b1dc-1168457acec4"),
    ("pro", "yearly", "usd", 149000, "415b0b77-f6d3-4cbb-9fe8-250f3281378f"),
    ("pro", "yearly", "krw", 2040000, "1fc9d6fa-b1bd-492b-b081-ecfe78775d12"),
    ("overage", "monthly", "usd", 100, "a6dafd94-08bb-49b5-ba02-cefa22856983"),
    ("overage", "monthly", "krw", 1300, "1e5feeda-19e8-44d5-87db-e4232d5f018f"),
]

_pricing_versions = sa.table(
    "pricing_versions",
    sa.column("id", postgresql.UUID(as_uuid=True)),
    sa.column("tier", sa.Text),
    sa.column("billing_cycle", sa.Text),
    sa.column("currency", sa.Text),
    sa.column("price_cents", sa.Integer),
    sa.column("polar_price_id", sa.Text),
    sa.column("effective_from", sa.DateTime(timezone=True)),
    sa.column("created_by", sa.Text),
)


def upgrade() -> None:
    # 전 10건이 정확히 같은 시각(배포 시각)을 공유해야 하므로 Python 에서 한 번만 계산
    # (func.now() 를 bulk_insert 값에 섞으면 executemany 배치 컴파일 경로가 불확실해질 수
    # 있어 회피 — 모든 행이 동일한 리터럴 timestamp 를 명시적으로 갖는 게 더 명확하다).
    effective_from = datetime.now(timezone.utc)
    op.bulk_insert(
        _pricing_versions,
        [
            {
                "id": uuid.uuid4(),
                "tier": tier,
                "billing_cycle": billing_cycle,
                "currency": currency,
                "price_cents": price_cents,
                "polar_price_id": polar_price_id,
                "effective_from": effective_from,
                "created_by": _CREATED_BY,
            }
            for tier, billing_cycle, currency, price_cents, polar_price_id in _SEED
        ],
    )


def downgrade() -> None:
    op.execute(
        sa.text("DELETE FROM pricing_versions WHERE polar_price_id = ANY(:ids)").bindparams(
            ids=[row[4] for row in _SEED]
        )
    )
