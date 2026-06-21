"""E-DG S28: docs.superseded_by (cross-doc 대체 포인터).

doc resubmit/revision(안A·같은-doc 재상신)은 doc.id/slug 를 stable 하게 유지하고 버전 이력은
DocRevision 이 담당한다. superseded_by 는 **cross-doc 대체**(confirmed→superseded 시 이 doc 을 대체한
별 doc) canonical 링크용 — 재상신 체인엔 안 쓴다. additive·nullable self-FK(ondelete SET NULL)·백필
불요(기존 행 NULL). default-off 동작영향 0.

⚠️baseline schema.sql 은 **건드리지 않는다**(의도): baseline/REVISION=0096 스냅샷 위에 이 마이그가
컬럼을 얹는다. additive 신규 컬럼은 baseline 미변경이 선례 — 0128 status·0129 sprint enum·기존
canonical_slug·slug_locked 전부 post-0096 마이그로만 추가됐고 baseline docs 테이블엔 없다. fresh-DB
CI(baseline + `alembic upgrade head`)가 0130 을 적용하므로 drift 없음. (S26 는 0096 baseline 에
*이미 있던* CHECK 를 넓힌 케이스라 baseline 동반이 필요했던 것 — 그와 구분.)
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
