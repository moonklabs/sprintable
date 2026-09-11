"""story #3805(Phase3·3-1·PR 3, 페드루 PO 確定 2026-09-11 09:31Z) — 「반응」(Engagement)
답글 편입. 그라운딩 PR1 스코프였던 channel_post_comments의 triage 3컬럼(0362)을
channel_post_comment_replies에도 동형으로 얹는다 — 큐가 댓글·답글 둘 다 「미처리/
처리 중/완료/넘김」 같은 경로로 다루게 한다(PR1의 댓글 전용 갭을 닫는다).

- triage_status: open|in_progress|done|skipped, default open(0362와 동일 규약).
- assignee_member_id: nullable, FK 없음(0362와 동형 관례).
- linked_story_id: nullable — 「작업으로 전환」 양방향 링크(0362와 동형, 답글에도
  같은 개념 적용).

Revision ID: 0365
Revises: 0364
Create Date: 2026-09-11

CI 정정(sibling-PR revision numbering, 페드루 전달 2026-09-11 10:03Z) —
PR#4176(디디)이 0364를 선점 — 단일 체인 0362→0363→0364→0365로 이 마이그를
그 뒤에 체이닝한다.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0365"
down_revision = "0364"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "channel_post_comment_replies",
        sa.Column("triage_status", sa.Text(), nullable=False, server_default="open"),
    )
    op.add_column(
        "channel_post_comment_replies",
        sa.Column("assignee_member_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "channel_post_comment_replies",
        sa.Column("linked_story_id", postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("channel_post_comment_replies", "linked_story_id")
    op.drop_column("channel_post_comment_replies", "assignee_member_id")
    op.drop_column("channel_post_comment_replies", "triage_status")
