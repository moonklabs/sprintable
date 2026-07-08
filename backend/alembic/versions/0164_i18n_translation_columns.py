"""E-I18N Phase B(story 11f1087c) — role_templates/release_notes i18n 병행 JSONB 컬럼.

Revision ID: 0164
Revises: 0163
Create Date: 2026-07-08

crux doc `i18n-architecture-design-crux`, 선생님 GO 2026-07-08. 스키마만(콘텐츠 데이터
아님) — [[no-pr-for-data]] 게이트 무관.

설계(순수 additive, 기존 Text 컬럼 무변경):
- `role_templates.role_behaviors_i18n` / `release_notes.title_i18n` — 둘 다 JSONB
  `NOT NULL DEFAULT '{}'::jsonb`. **기존 데이터를 이 컬럼으로 백필하지 않는다** — 빈
  dict로 시작해 완전히 별개 오버레이로만 존재한다. 향후 소비 코드(Phase C 이후)가
  `role_behaviors_i18n.get(locale) or role_behaviors`(레거시 Text 컬럼이 곧 "ko" 캐논
  소스) 순서로 조회하면, en 키가 비어있는 한 자동으로 기존 한글 텍스트로 폴백한다 —
  마이그레이션 시점엔 이 새 컬럼에 아무 콘텐츠 결정도 내리지 않으므로 데이터 변경
  성격이 전혀 없다(순수 구조 추가).
- release_notes는 title만(요청 스코프 — summary/items i18n은 미포함, 필요하면 후속).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0164"
down_revision = "0163"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "role_templates",
        sa.Column(
            "role_behaviors_i18n", postgresql.JSONB(astext_type=sa.Text()),
            nullable=False, server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column(
        "release_notes",
        sa.Column(
            "title_i18n", postgresql.JSONB(astext_type=sa.Text()),
            nullable=False, server_default=sa.text("'{}'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("release_notes", "title_i18n")
    op.drop_column("role_templates", "role_behaviors_i18n")
