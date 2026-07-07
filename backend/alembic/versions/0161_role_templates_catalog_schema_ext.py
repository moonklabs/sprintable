"""~300직군 카탈로그 트랙 S1(문서 role-template-crud-api-crux): division·emoji·skills 컬럼 추가.

Revision ID: 0161
Revises: 0160
Create Date: 2026-07-07

agency-agents 참고 상위 산업/부문 분류(division)·시각코딩(emoji)·A2A 발견 키(skills, app.schemas.
a2a.AgentSkill 형태 그대로 재사용)를 role_templates에 추가한다. 전부 nullable 또는 server_default
있는 additive 컬럼이라 기존 24개 seed(0156/0157/0160) 무회귀 — skills는 기본값 `[]`로 채워져
_build_agent_card가 아직 이를 소비하지 않는 한(S4 예정) 회귀 없음.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0161"
down_revision = "0160"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("role_templates", sa.Column("division", sa.Text(), nullable=True))
    op.add_column("role_templates", sa.Column("emoji", sa.Text(), nullable=True))
    op.add_column(
        "role_templates",
        sa.Column(
            "skills", postgresql.JSONB(), nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("role_templates", "skills")
    op.drop_column("role_templates", "emoji")
    op.drop_column("role_templates", "division")
