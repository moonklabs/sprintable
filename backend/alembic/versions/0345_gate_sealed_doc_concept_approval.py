"""story #3561(Phase2·BE, 페드루 PO 確定 2026-09-06) — `gate.sealed_doc_id`+
`gate.sealed_doc_body_sha256` 신설(additive, nullable). `concept_approval` 전용
봉인 축(0333 sealed_estimated_cost_minor와 동형 관례) — 그 gate_type이 아니면
항상 null."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0345"
down_revision = "0344"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("gate", sa.Column("sealed_doc_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("gate", sa.Column("sealed_doc_body_sha256", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("gate", "sealed_doc_body_sha256")
    op.drop_column("gate", "sealed_doc_id")
