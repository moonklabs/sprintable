"""story #3805(Phase3·3-1·PR 4, 페드루 PO 確定 2026-09-11 12:12Z) — 인바운드 중첩
답글 수집. 그라운딩 확定①: Threads(`replied_to`/`root_post`)·Instagram(`parent_id`)·
Facebook(`parent`) 셋 다 Graph API 문서상 부모-댓글 참조 필드가 있다(Meta 공식
레퍼런스 문서 확認 — 실 dev 연결 응답에 실제로 채워져 오는지는 배포 뒤 PO가 라이브
회차에서 확認).

`parent_comment_id`: 외부 parent id → 내부 id 매핑 결과만 담는다(수집 서비스가
같은 org·publication 안에서 external_comment_id로 조회해 채움). 부모가 아직
수집되지 않았으면 null로 남는다 — 그 경우에도 외부 parent id 자체는 유실 0(`raw`
JSONB에 이미 보존). FK 없음(이 파일·이 테이블의 기존 관례 그대로 — assignee_
member_id/linked_story_id와 동형, 값만 담는 참조).

Revision ID: 0365
Revises: 0364
Create Date: 2026-09-11
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
        "channel_post_comments",
        sa.Column("parent_comment_id", postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("channel_post_comments", "parent_comment_id")
