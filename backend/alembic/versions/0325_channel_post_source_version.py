"""story #3437(후속 묶음, 페드루 PO 確定 2026-09-05) — `channel_post_drafts.
source_site_post_version_id` 신규 컬럼.

`source_content_item_id`(0321)가 「어느 draft에서 파생됐나」(draft 축)만 가리키는
것과 달리, 이 컬럼은 「그 draft의 몇 번 버전에서 파생됐나」(버전 축)를 초안 생성
시점에 고정한다 — 원문이 그 뒤 새 버전을 내도 이 값은 안 바뀐다(staleness 판별의
기준점, FE는 이 값과 원문 현재 latest version.id를 비교해 "원문이 파생 이후
개정됨" 배지를 그린다 — 서버는 판정 라벨을 안 낸다).

FK 없음(source_content_item_id와 같은 관례) — nullable(source_content_item_id가
null이면 이것도 항상 null — 소스 없는 단독 채널 초안 회귀 유지).

down_revision=0324는 story e4fc29fa 조각④(#3800, webhook_delivery_nonces) — 이
스토리 착수 시점에 develop 미착지였다(gh api로 실물 확인). #3800이 먼저 착지해야
이 마이그가 develop에 얹힐 수 있다.

Revision ID: 0325
Revises: 0324
Create Date: 2026-09-05
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0325"
down_revision = "0324"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "channel_post_drafts",
        sa.Column("source_site_post_version_id", postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("channel_post_drafts", "source_site_post_version_id")
