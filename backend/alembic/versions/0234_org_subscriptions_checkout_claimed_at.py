"""#2511(결제②-D후속) — org_subscriptions에 checkout_claimed_at(nullable timestamptz) 추가.

카디르 #2890 결함사냥 재QA 발견(2026-08-07): checkout 진행 中(응답 대기)에 같은 org가
다른 tier/cycle로 재제출하면 order_id가 달라(결정적 키가 offering_version_id를 포함)
#2493의 원자적 claim이 서로 다른 두 시도를 막지 못해 이론적 이중 청구가 가능했다.

이 컬럼이 org당 "진행 중 checkout" 서버 정본 — checkout_subscription()이 실 청구
전에 `WHERE checkout_claimed_at IS NULL OR checkout_claimed_at < now-STALE` 가드가
걸린 UPSERT로 원자적 claim하고(같은 org의 동시 다른 tier/cycle 요청은 이 단일 UPDATE
문에서 자연히 하나만 이기고 나머지는 rowcount=0로 즉시 거부 — advisory lock이 아니라
Postgres 자체의 행단위 원자성이 직렬화 소스), 성공/거절/예외 어느 경로든 finally에서
NULL로 되돌려 해제한다. staleness 윈도(코드 상수, 이 마이그는 그릇만)는 프로세스가
release 前에 죽어도 org가 영구히 막히지 않게 하는 자기치유 장치."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0234"
down_revision = "0233"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "org_subscriptions",
        sa.Column("checkout_claimed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("org_subscriptions", "checkout_claimed_at")
