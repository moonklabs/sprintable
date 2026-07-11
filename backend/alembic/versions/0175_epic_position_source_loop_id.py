"""E-GLANCE wedge #2(story 96b19bc3) — epics.position + epics.source_loop_id 컬럼.

Revision ID: 0175
Revises: 0174
Create Date: 2026-07-11

BE 설계 doc `be-design-roadmap-steer-ortega-events-96b19bc3` §1.1/§4.1. 둘 다 순수
additive nullable — 기존 epic 전부 무영향, 백필 없음.

- position: Story.position(BigInteger, nullable)과 완전 동형 — 로드맵 조타(재정렬)
  큐레이션 필드. null=아직 큐레이션 안 됨(자동도출 순서 유지).
- source_loop_id: loop_runs.id FK(ON DELETE SET NULL) — 어떤 epic이 어느 Loop 결과에서
  파생 제안됐는지 계보 인터페이스만(이 스토리 스코프=컬럼 존재까지, 배선은 후속 P3).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0175"
down_revision = "0174"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "epics",
        sa.Column("position", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "epics",
        sa.Column("source_loop_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_epics_source_loop_id_loop_runs",
        "epics", "loop_runs",
        ["source_loop_id"], ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_epics_source_loop_id_loop_runs", "epics", type_="foreignkey")
    op.drop_column("epics", "source_loop_id")
    op.drop_column("epics", "position")
