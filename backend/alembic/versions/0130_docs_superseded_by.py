"""E-DG S28: docs.superseded_by (cross-doc 대체 포인터).

doc resubmit/revision(안A·같은-doc 재상신)은 doc.id/slug 를 stable 하게 유지하고 버전 이력은
DocRevision 이 담당한다. superseded_by 는 **cross-doc 대체**(confirmed→superseded 시 이 doc 을 대체한
별 doc) canonical 링크용 — 재상신 체인엔 안 쓴다. additive·nullable self-FK(ondelete SET NULL)·백필
불요(기존 행 NULL). default-off 동작영향 0. ⚠️baseline schema.sql 동반 갱신(S26 CHECK·S27 l2_trigger
처럼 baseline-parity 빠뜨리면 fresh-DB drift→RC).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0130"
down_revision = "0129"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("docs")}
    if "superseded_by" not in cols:
        op.add_column(
            "docs",
            sa.Column("superseded_by", postgresql.UUID(as_uuid=True), nullable=True),
        )
        op.create_foreign_key(
            "docs_superseded_by_fkey", "docs", "docs",
            ["superseded_by"], ["id"], ondelete="SET NULL",
        )
        op.create_index("ix_docs_superseded_by", "docs", ["superseded_by"])


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_docs_superseded_by")
    op.execute("ALTER TABLE docs DROP CONSTRAINT IF EXISTS docs_superseded_by_fkey")
    op.drop_column("docs", "superseded_by")
