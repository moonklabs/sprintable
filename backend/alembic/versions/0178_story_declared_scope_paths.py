"""E-UI-DAEGBYEON P0-05 후속(story 174be6bc·doc scope-violation-signal-design §3) — stories.declared_scope_paths.

Revision ID: 0178
Revises: 0177
Create Date: 2026-07-13

scope-violation 신호의 판정 기반 — 작업 착수 시점 선언한 파일-경로 글롭 배열(list[str]). additive
nullable JSONB, FK 없음(스칼라 값 배열이라 FK 대상 자체가 없음 — P0-03/ff6cb90d와는 다른 이유로 무FK).
미설정(None)이면 판정 로직이 항상 무신호(§2 결정 그대로) — 기존 스토리 전부 무회귀.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0178"
down_revision = "0177"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "stories",
        sa.Column("declared_scope_paths", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("stories", "declared_scope_paths")
