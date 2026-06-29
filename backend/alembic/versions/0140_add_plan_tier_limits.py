"""E-STORAGE-SSOT S8: plan_tier_limits — tier별 storage 캡(admin-configurable·server-trust SSOT).

Revision ID: 0140
Revises: 0139
Create Date: 2026-06-28

S8 capacity gate 의 캡 단일 소스(client-trust 0·하드코딩 X). BE enforce 가 org tier(org_subscriptions)→
plan_tier_limits[tier]→캡으로 읽는다. FE 는 BE storage-usage 로 캡 read(Supabase 이원화 0). 결재값 seed:
Free 5GB/100MB · Team 50GB/500MB · Pro 250GB/500MB (MB 단위 저장·admin 편집 가능).

idempotent: 테이블 inspect 가드(0139 선례)·seed 는 ON CONFLICT DO NOTHING. fresh-runnable. downgrade=drop.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect, text

revision = "0140"
down_revision = "0139"
branch_labels = None
depends_on = None

# 결재 확정값(MB). admin 이 이후 plan_tier_limits 를 직접 편집(하드코딩 아님·여긴 초기 seed).
_SEED = [
    ("free", 5 * 1024, 100),       # 5GB / 100MB
    ("team", 50 * 1024, 500),      # 50GB / 500MB
    ("pro", 250 * 1024, 500),      # 250GB / 500MB
]


def upgrade() -> None:
    bind = op.get_bind()
    if "plan_tier_limits" not in inspect(bind).get_table_names():
        op.create_table(
            "plan_tier_limits",
            sa.Column("tier", sa.Text(), primary_key=True),
            sa.Column("max_storage_mb", sa.BigInteger(), nullable=False),
            sa.Column("max_file_mb", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        )
    # seed(멱등) — 이미 있으면 보존(admin 편집값 덮지 않음).
    for tier, storage_mb, file_mb in _SEED:
        bind.execute(
            text(
                "INSERT INTO plan_tier_limits (tier, max_storage_mb, max_file_mb) "
                "VALUES (:t, :s, :f) ON CONFLICT (tier) DO NOTHING"
            ),
            {"t": tier, "s": storage_mb, "f": file_mb},
        )


def downgrade() -> None:
    op.drop_table("plan_tier_limits")
