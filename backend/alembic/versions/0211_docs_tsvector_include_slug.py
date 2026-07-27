"""docs.search_vector 에 slug 포함 (story #2167 — slug 검색 허용)

Revision ID: 0211
Revises: 0210
"""
from alembic import op

revision = "0211"
down_revision = "0210"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # generated column의 expression은 in-place ALTER가 안 된다 — drop 후 재생성.
    # STORED라 재생성 시 기존 행 전체가 재계산된다(docs 테이블 규모상 허용 범위로 판단).
    op.execute("DROP INDEX IF EXISTS idx_docs_search_vector")
    op.execute("ALTER TABLE docs DROP COLUMN IF EXISTS search_vector")
    op.execute(
        """
        ALTER TABLE docs
        ADD COLUMN search_vector TSVECTOR
        GENERATED ALWAYS AS (
            to_tsvector('simple',
                coalesce(title, '') || ' ' || coalesce(slug, '') || ' ' || coalesce(content, ''))
        ) STORED
        """
    )
    op.execute(
        "CREATE INDEX idx_docs_search_vector ON docs USING GIN(search_vector)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_docs_search_vector")
    op.execute("ALTER TABLE docs DROP COLUMN IF EXISTS search_vector")
    op.execute(
        """
        ALTER TABLE docs
        ADD COLUMN search_vector TSVECTOR
        GENERATED ALWAYS AS (
            to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))
        ) STORED
        """
    )
    op.execute(
        "CREATE INDEX idx_docs_search_vector ON docs USING GIN(search_vector)"
    )
