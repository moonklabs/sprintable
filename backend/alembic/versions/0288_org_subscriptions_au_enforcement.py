"""story #3176(결제②-C) — AU 한도 집행: org_subscriptions에 크론-캐시 상태 컬럼 5종 신설.

doc `au-limit-enforcement-grounding-3176`(페드루 PO 승인 2026-08-28) §1.3 — AU는 기존
storage/seats/agent 5종(즉시 단일임계 402)과 달리 80%/90% 2단계 경고+유예(110%/7일)+
일시중지 구조라, 크로싱 시각을 기억할 신규 상태가 필요하다. paused 여부는 요청마다
재계산하지 않고 크론(`au-usage-warn`)이 주기적으로 캐시(`au_paused_at`)에 박아두고
미들웨어/인증 dependency는 그 캐시만 읽는다 — `au_eval_at`(크론이 매 실행마다 무조건
갱신하는 last-evaluated 마커)로 fail-open을 구현한다(크론이 죽거나 캐시가 stale이면
차단하지 않는다, 페드루 PO 조건).

Revision ID: 0288
Revises: 0287
Create Date: 2026-08-28

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0288"
down_revision = "0287"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "org_subscriptions",
        sa.Column("au_warn_80_notified_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "org_subscriptions",
        sa.Column("au_warn_90_notified_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "org_subscriptions",
        sa.Column("au_grace_started_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "org_subscriptions",
        sa.Column("au_paused_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "org_subscriptions",
        sa.Column("au_eval_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("org_subscriptions", "au_eval_at")
    op.drop_column("org_subscriptions", "au_paused_at")
    op.drop_column("org_subscriptions", "au_grace_started_at")
    op.drop_column("org_subscriptions", "au_warn_90_notified_at")
    op.drop_column("org_subscriptions", "au_warn_80_notified_at")
