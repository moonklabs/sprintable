"""E-DG S22: docs.status (doc decision lifecycle·doc-specific 값).

doc 은 native status 가 없었다(콘텐츠만). S22 결정(A): work status 재사용 없이 doc-전용 lifecycle
값(draft|confirmed|denied|superseded|deprecated)을 native 컬럼으로 추가 → 콘텐츠 승인≠작업 진행
의미 분리 + FE 뱃지/쿼리/readiness. additive·default 'draft'·기존 doc 전부 draft 백필(승인이력 없음·
보수적)·default-off 라 동작영향 0.
"""
from alembic import op
import sqlalchemy as sa

revision = "0128"
down_revision = "0127"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("docs")}
    if "status" not in cols:
        # NN + server_default 'draft' → 기존 행 자동 백필(보수적·승인이력 없음).
        op.add_column(
            "docs",
            sa.Column("status", sa.Text(), nullable=False, server_default="draft"),
        )
        op.create_index("ix_docs_status", "docs", ["status"])


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_docs_status")
    op.drop_column("docs", "status")
