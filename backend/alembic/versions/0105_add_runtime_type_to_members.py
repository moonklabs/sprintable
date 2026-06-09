"""members.runtime_type 컬럼 추가 — 에이전트 런타임 식별 (E-CHAT-CMD S1 토대).

에이전트(member.type='agent')의 런타임 종류(opencode·openclaw·hermes·gemini·grok·cursor·codex·
pi·claude-code). nullable — 휴먼/미설정은 NULL(= capability lookup 에서 미지원 처리). 9 enum 은
앱 레이어(RuntimeType)에서 강제(코드 컨벤션 = 네이티브 PG enum 미사용·신규 런타임 확장 용이).
컬럼 추가는 의존 뷰 team_members 무영향(뷰는 명시 컬럼만 SELECT).

Revision ID: 0105
Revises: 0104
Create Date: 2026-06-09
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0105"
down_revision = "0104"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    cols = {c["name"] for c in insp.get_columns("members")}
    if "runtime_type" not in cols:
        op.add_column("members", sa.Column("runtime_type", sa.Text, nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    cols = {c["name"] for c in insp.get_columns("members")}
    if "runtime_type" in cols:
        op.drop_column("members", "runtime_type")
