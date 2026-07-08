"""E-I18N EN 콘텐츠(story d6e3f407) — release_notes.summary_i18n/items_i18n 병행 JSONB 컬럼.

Revision ID: 0165
Revises: 0164
Create Date: 2026-07-08

crux doc `en-content-native-generation-crux`, 선생님 GO 2026-07-08(결정①: 릴노트 full EN =
title+summary+items). 0164가 title만 오버레이했던 걸 확장 — summary/items도 동형 패턴(순수
additive, 콘텐츠 데이터 아님 — [[no-pr-for-data]] 게이트 무관, 이 마이그는 PR1(코드+스키마)
스코프. 실 EN 콘텐츠 backfill은 PR2(선생님 데이터 게이트) 몫).

설계(title_i18n과 완전 동형):
- `summary_i18n` — JSONB `NOT NULL DEFAULT '{}'::jsonb`(`{"en": "...", ...}`). 기존
  `summary`(Text) 컬럼은 그대로 "ko" 캐논 소스. 백필 없음.
- `items_i18n` — JSONB `NOT NULL DEFAULT '{}'::jsonb`(`{"en": [{"text":..., "href":...}, ...], ...}`).
  기존 `items`(JSONB 배열) 컬럼은 그대로 "ko" 캐논 소스. 백필 없음.
- 소비 코드(같은 PR1에서 배선): `summary_i18n.get(locale) or summary` / `items_i18n.get(locale) or items`
  — en 키가 비어있는 한 자동으로 ko로 폴백(title_i18n과 동일한 무회귀 원칙).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0165"
down_revision = "0164"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "release_notes",
        sa.Column(
            "summary_i18n", postgresql.JSONB(astext_type=sa.Text()),
            nullable=False, server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column(
        "release_notes",
        sa.Column(
            "items_i18n", postgresql.JSONB(astext_type=sa.Text()),
            nullable=False, server_default=sa.text("'{}'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("release_notes", "items_i18n")
    op.drop_column("release_notes", "summary_i18n")
