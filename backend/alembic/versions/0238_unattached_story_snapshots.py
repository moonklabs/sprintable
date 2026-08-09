"""story #2536(E-FLOW-V4 S4) — 프로젝트별 unattached_count 일별 스냅샷 테이블.

append-only(org_member_trust_snapshots 0135류와 동형). v4 강제(S2, #2532)가 신규 story의
가설/목표 부착을 요구하므로 기존 미매달림 총량이 시간에 걸쳐 줄어야 하고, 그 추세를 재는
«측정 도구»가 이 테이블 — 과거 소급 불가라 오늘부터 쌓아야 한다.
"""
from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision = "0238"
down_revision = "0237"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "unattached_story_snapshots",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column(
            "project_id", UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("unattached_count", sa.Integer(), nullable=False),
        sa.Column(
            "computed_at", sa.DateTime(timezone=True),
            server_default=sa.text("now()"), nullable=False,
        ),
    )
    op.create_index(
        "ix_unattached_snapshot_org_project_time",
        "unattached_story_snapshots",
        ["org_id", "project_id", "computed_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_unattached_snapshot_org_project_time", table_name="unattached_story_snapshots")
    op.drop_table("unattached_story_snapshots")
