"""story 139d2405(S-slug-infra): projects.slug additive+백필(이름 kebab 파생·org-scoped 유일) +
entity_slug_history 테이블(rename 이력·향후 301용).

Revision ID: 0184
Revises: 0183
Create Date: 2026-07-15

organizations.slug는 이미 존재하는 컬럼(모델 unique=True 선언)·이 마이그와 무관 — 단, 실측
결과 DB 레벨 UNIQUE 제약이 baseline부터 누락돼있던 별개 갭을 발견해 0185에서 봉합한다(발견
즉시 수정). 순수 additive — 기존 스키마 무회귀. 백필: name→slugify(app.services.doc_slug와
동일 유니코드 NFC 계약)·org 내 충돌은 `-2`,`-3`… suffix(생성 순서=created_at ASC로 결정적)로
해소.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0184"
down_revision = "0183"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "entity_slug_history",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("entity_type", sa.Text(), nullable=False),
        sa.Column("entity_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("old_slug", sa.Text(), nullable=False),
        sa.Column("new_slug", sa.Text(), nullable=False),
        sa.Column("changed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_entity_slug_history_org_id", "entity_slug_history", ["org_id"])
    op.create_index("ix_entity_slug_history_entity_id", "entity_slug_history", ["entity_id"])

    # ⚠️nullable 유지(NOT NULL 아님) — 이 리포 전역에 raw Project(...) 시더가 수백 곳(실DB 테스트)이라
    # NOT NULL로 걸면 그 전부가 즉시 깨진다(실측: 666건). 백필은 여전히 기존 실 데이터를 채우고,
    # 신규 API 경로는 항상 값을 채워 넣어 실질적으로 non-null. UNIQUE(org_id, slug)는 여러 NULL을
    # 서로 다른 값으로 취급해 무해(app/models/project.py 주석 참고).
    op.add_column("projects", sa.Column("slug", sa.Text(), nullable=True))

    _backfill_project_slugs()

    op.create_unique_constraint("uq_projects_org_slug", "projects", ["org_id", "slug"])


def _backfill_project_slugs() -> None:
    from app.services.doc_slug import slugify

    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, org_id, name FROM projects ORDER BY created_at ASC")
    ).fetchall()

    used_per_org: dict[str, set[str]] = {}
    for row in rows:
        org_key = str(row.org_id)
        used = used_per_org.setdefault(org_key, set())
        base = slugify(row.name or "") or "project"
        candidate = base
        n = 2
        while candidate in used:
            candidate = f"{base}-{n}"
            n += 1
        used.add(candidate)
        conn.execute(
            sa.text("UPDATE projects SET slug = :slug WHERE id = :id"),
            {"slug": candidate, "id": row.id},
        )


def downgrade() -> None:
    op.drop_constraint("uq_projects_org_slug", "projects", type_="unique")
    op.drop_column("projects", "slug")
    op.drop_index("ix_entity_slug_history_entity_id", table_name="entity_slug_history")
    op.drop_index("ix_entity_slug_history_org_id", table_name="entity_slug_history")
    op.drop_table("entity_slug_history")
