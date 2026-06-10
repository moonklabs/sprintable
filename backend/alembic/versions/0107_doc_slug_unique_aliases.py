"""docs PK 드리프트 교정 + slug_locked + doc_slug_aliases (Part A 4dd399c6).

- step0: **docs.id PRIMARY KEY 부재 교정**(baseline/실 DB 스냅샷에 docs_pkey 가 소실 — 다른 43개
  테이블엔 PK 있는데 docs 만 부재. ORM 은 PK 가정하고 동작해 온 실 스키마 드리프트). PK 부재 시만
  추가(idempotent — OSS create_all 모델 경로엔 이미 PK 존재). 이게 있어야 alias FK 가 성립.
- docs.slug_locked: 자동/수동 파생 구분 컬럼. 기존 non-`untitled-%` slug → locked=true 백필.
- doc_slug_aliases: 재슬러그 시 구 slug→doc_id 보존(외부 북마크/Recents/본문 내부링크 유지).

⚠️ (project_id, slug) 유일성은 baseline 의 `docs_project_slug_active`
   (UNIQUE (project_id, slug) WHERE deleted_at IS NULL) 가 **이미 enforce** → 별도 인덱스/
   dedupe 불요. app 레벨(is_slug_taken/resolve_unique_slug)이 409/suffix 로 사전 회피.

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
    # step0: docs.id PK 드리프트 교정 — PK 가 없을 때만 추가(idempotent). id 는 NOT NULL +
    # gen_random_uuid default 라 유일성 보장 → PK 추가 안전. alias FK 의 전제.
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.docs'::regclass AND contype = 'p'
            ) THEN
                ALTER TABLE public.docs ADD CONSTRAINT docs_pkey PRIMARY KEY (id);
            END IF;
        END$$;
        """
    )

    # slug_locked (server_default 로 기존 행 채운 뒤 default 제거 → 앱 레벨 default=False)
    op.add_column(
        "docs",
        sa.Column("slug_locked", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute("UPDATE docs SET slug_locked = true WHERE slug NOT LIKE 'untitled-%'")
    op.alter_column("docs", "slug_locked", server_default=None)

    # doc_slug_aliases — doc_id FK 는 step0 PK 가 성립시킨다. project_id 는 plain UUID.
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


def downgrade() -> None:
    op.drop_table("doc_slug_aliases")
    op.drop_column("docs", "slug_locked")
    # step0 PK 는 드리프트 교정이므로 downgrade 에서 되돌리지 않음(되돌리면 결함 재현).
