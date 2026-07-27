"""편집 캔버스 핀 저작(story 7fe16274·doc artifact-pin-authoring-spec §2) — artifact_spec_pins.

Revision ID: 0180
Revises: 0179
Create Date: 2026-07-13

그라운딩(§2·기존 코멘트 앵커 모델 재사용 vs 신설 — 디디 판단): 신설. ArtifactComment와 같은
캔버스 핀 레이어를 공유하지만(FE 시각 구분) 생명주기가 근본적으로 다르다 —
  · 버전 스코프(canvas_bounds·artifact_nodes와 동형) — 코멘트는 artifact 레벨 영속, 스펙 핀은
    그 버전 레이아웃의 스냅샷이라 edit마다 carry-forward(무-mutate 버전 원칙).
  · 스레드/resolve 없음(단일값 description) — 코멘트 전용 컬럼을 스펙 핀 행에 방치하지 않으려
    분리.
  · anchor_type 명시 판별자 + CHECK — 코멘트의 암묵적 nullable 타이핑과 달리 anchor 오타입
    no-op 함정을 스키마 레벨에서 차단.
  · 감시금지(doc §4) — created_by 등 attribution 컬럼 자체를 두지 않음(ArtifactNode와 동형).

신규 테이블(신설 — 기존 테이블 변경 없음, additive).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0180"
down_revision = "0179"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "artifact_spec_pins",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "artifact_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("visual_artifacts.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column(
            "version_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("artifact_versions.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("anchor_type", sa.Text(), nullable=False),
        sa.Column("anchor_x", sa.Float(), nullable=True),
        sa.Column("anchor_y", sa.Float(), nullable=True),
        sa.Column(
            "node_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("artifact_nodes.id", ondelete="CASCADE"), nullable=True,
        ),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "(anchor_type = 'coord' AND anchor_x IS NOT NULL AND anchor_y IS NOT NULL AND node_id IS NULL) OR "
            "(anchor_type = 'node' AND node_id IS NOT NULL AND anchor_x IS NULL AND anchor_y IS NULL)",
            name="ck_artifact_spec_pins_anchor_consistency",
        ),
    )
    op.create_index("ix_artifact_spec_pins_artifact_id", "artifact_spec_pins", ["artifact_id"])
    op.create_index("ix_artifact_spec_pins_version_id", "artifact_spec_pins", ["version_id"])
    op.create_index("ix_artifact_spec_pins_node_id", "artifact_spec_pins", ["node_id"])


def downgrade() -> None:
    op.drop_index("ix_artifact_spec_pins_node_id", table_name="artifact_spec_pins")
    op.drop_index("ix_artifact_spec_pins_version_id", table_name="artifact_spec_pins")
    op.drop_index("ix_artifact_spec_pins_artifact_id", table_name="artifact_spec_pins")
    op.drop_table("artifact_spec_pins")
