"""#2092(P0 보안) — deletion_audit_logs에 note(nullable text) 추가.

조직 삭제가 영향도(impact) 확認 없이(=owner가 명시적으로 「확認하지 못한 상태로
삭제합니다」를 인정) 진행된 경우, 그 사실 자체가 감사 기록에 남아야 한다(AC3 4번째
불릿). entity_type을 그 용도로 오버로드하지 않고(향후 다른 엔티티/다른 사유에도
재사용 가능한 범용 컬럼으로) note 하나를 추가한다 — 순수 additive, 기존 스키마 무회귀.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0235"
down_revision = "0234"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("deletion_audit_logs", sa.Column("note", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("deletion_audit_logs", "note")
