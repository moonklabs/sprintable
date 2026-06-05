"""docs 테이블 tsvector 컬럼 + GIN 인덱스 추가 (D4-2 전문 검색)

Revision ID: 0047
Revises: 0046
"""
from alembic import op

revision = "0047"
down_revision = "0046"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE docs
        ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
        GENERATED ALWAYS AS (
            to_tsvector('simple',
                coalesce(title, '') || ' ' || coalesce(content, ''))
        ) STORED
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_docs_search_vector ON docs USING GIN(search_vector)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_docs_search_vector")
    op.execute("ALTER TABLE docs DROP COLUMN IF EXISTS search_vector")
