"""story #3805(Phase3·3-1, 페드루 PO 確定 2026-09-11) — 「반응」(Engagement) 화면
배정·처리 상태. 그라운딩 ④: 새 테이블 0 — channel_post_comments에 컬럼 3개만
additive로 얹는다.

- triage_status: open|in_progress|done|skipped(ko 「넘김」·en Skipped — 08:14Z
  낱말 정정, `ignored` 대신 유나 대안 채택), default open(기존 행도 open으로
  보수적으로 낙착 — "아직 안 본 것"으로 취급하는 편이 "이미 처리됨"으로 지어내는
  것보다 안전, fail-closed).
- assignee_member_id: nullable, FK 없음(파일 머리 관례 — channel_connections류와
  동형, 값만 담는 참조).
- linked_story_id: nullable — 「작업으로 전환」의 양방향 링크(그라운딩 ③).

Revision ID: 0362
Revises: 0360
Create Date: 2026-09-11

CI 정정(2026-09-11, sibling-PR revision collision guard) — 원래 0361로 지었으나
PR #4174(gate_sealed_ads_boost)도 같은 시각 0361을 써 충돌 — 0362로 재번호(다른
필드/로직 변경 없음, down_revision은 그대로 0360).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0362"
down_revision = "0360"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "channel_post_comments",
        sa.Column("triage_status", sa.Text(), nullable=False, server_default="open"),
    )
    op.add_column(
        "channel_post_comments",
        sa.Column("assignee_member_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "channel_post_comments",
        sa.Column("linked_story_id", postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("channel_post_comments", "linked_story_id")
    op.drop_column("channel_post_comments", "assignee_member_id")
    op.drop_column("channel_post_comments", "triage_status")
