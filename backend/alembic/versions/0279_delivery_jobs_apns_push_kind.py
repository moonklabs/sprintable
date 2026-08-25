"""story #3064(E-MOBILE·macOS): delivery_jobs.kind CHECK에 'apns_push' 추가.

0278이 push_devices 쪽 macOS 지원을 열었고, 발송기(ee/services/apns_push.py)가 via_outbox=True
경로에서 delivery_jobs(kind="apns_push") row를 insert한다 — 기존 CHECK("org_webhook",
"personal_webhook", "expo_push")가 이 값을 원천 거부하므로 먼저 열어둬야 한다.

Revision ID: 0279
Revises: 0278
Create Date: 2026-08-25
"""
from __future__ import annotations

from alembic import op

revision = "0279"
down_revision = "0278"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_delivery_jobs_kind", "delivery_jobs", type_="check")
    op.create_check_constraint(
        "ck_delivery_jobs_kind",
        "delivery_jobs",
        "kind IN ('org_webhook', 'personal_webhook', 'expo_push', 'apns_push')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_delivery_jobs_kind", "delivery_jobs", type_="check")
    op.create_check_constraint(
        "ck_delivery_jobs_kind",
        "delivery_jobs",
        "kind IN ('org_webhook', 'personal_webhook', 'expo_push')",
    )
