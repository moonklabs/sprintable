"""docs slug 유일성 + slug_locked + doc_slug_aliases (Part A 4dd399c6).

- docs.slug_locked: 자동/수동 파생 구분 컬럼. 기존 non-`untitled-%` slug → locked=true 백필
  (의미있는 주소가 제목 재저장 시 자동교정되지 않게).
- (project_id, slug) 비삭제 **중복 dedupe-first**(가장 오래된 1건 유지·나머지 suffix) 후
  partial unique index — 기존 데이터에 중복이 있으면 인덱스 생성이 실패하므로 선행 필수
  (standup_entries 스키마 갭 전례). soft-deleted 는 충돌 허용(partial WHERE deleted_at IS NULL).
- doc_slug_aliases: 재슬러그 시 구 slug→doc_id 보존(외부 북마크/Recents/본문 내부링크 유지).

Revision ID: 0107
Revises: 0106
Create Date: 2026-06-10
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0107"
down_revision = "0106"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1) slug_locked 컬럼 (server_default false 로 기존 행 채운 뒤 default 제거 → 앱 레벨 default 유지)
    op.add_column(
        "docs",
        sa.Column("slug_locked", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute("UPDATE docs SET slug_locked = true WHERE slug NOT LIKE 'untitled-%'")

    # 2) dedupe-first: 같은 (project_id, slug) 비삭제 중복 → 오래된 1건 유지, 나머지 `-N` suffix
    op.execute(
        """
        WITH dups AS (
            SELECT id,
                   row_number() OVER (PARTITION BY project_id, slug ORDER BY created_at, id) AS rn
            FROM docs
            WHERE deleted_at IS NULL
        )
        UPDATE docs d
        SET slug = left(d.slug, 190) || '-' || dups.rn::text
        FROM dups
        WHERE d.id = dups.id AND dups.rn > 1
        """
    )
    # 2b) suffix 후 잔여 충돌(예: 기존에 base-2 가 실재) → id 단편으로 유일 보장(드묾)
    op.execute(
        """
        WITH dups AS (
            SELECT id,
                   row_number() OVER (PARTITION BY project_id, slug ORDER BY created_at, id) AS rn
            FROM docs
            WHERE deleted_at IS NULL
        )
        UPDATE docs d
        SET slug = left(d.slug, 180) || '-' || substr(replace(d.id::text, '-', ''), 1, 8)
        FROM dups
        WHERE d.id = dups.id AND dups.rn > 1
        """
    )

    # 3) partial unique index (비삭제 행만 — soft-deleted 중복 허용)
    op.create_index(
        "uq_docs_project_slug",
        "docs",
        ["project_id", "slug"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )

    # 4) doc_slug_aliases
    op.create_table(
        "doc_slug_aliases",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("old_slug", sa.Text(), nullable=False),
        sa.Column(
            "doc_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("docs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("project_id", "old_slug", name="uq_doc_slug_alias_project_old"),
    )
    op.create_index("ix_doc_slug_aliases_doc_id", "doc_slug_aliases", ["doc_id"])
    op.create_index("ix_doc_slug_aliases_project_id", "doc_slug_aliases", ["project_id"])

    # server_default 제거 — 이후 INSERT 는 앱(default=False)이 책임
    op.alter_column("docs", "slug_locked", server_default=None)


def downgrade() -> None:
    op.drop_table("doc_slug_aliases")
    op.drop_index("uq_docs_project_slug", table_name="docs")
    op.drop_column("docs", "slug_locked")
