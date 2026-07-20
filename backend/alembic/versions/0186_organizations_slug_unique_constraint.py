"""story 139d2405(S-slug-infra) 후속 발견: organizations.slug UNIQUE 제약 누락 봉합.

Revision ID: 0186
Revises: 0185
Create Date: 2026-07-15

⚠️renumber(2026-07-15): 병렬 BE PR(#2168 push_devices)이 동시에 "0184"를 채번해 develop에
dual-head가 발생 — 이 마이그는 0185→0186으로 renumber(원 revision/down_revision은 각각
0185/0184였음). 내용 변경 없음.

SQLAlchemy 모델(app/models/organization.py)은 `slug: Mapped[str] = mapped_column(..., unique=True)`
로 선언돼 있었지만, baseline schema.sql부터 실제 DB엔 이 제약이 한 번도 반영된 적이 없었다
(PRIMARY KEY(id)만 존재 — 실측 확인, alembic/baseline/schema.sql:1489-1497). 지금까지는
`OrganizationRepository.create()`의 app-level `slug_exists()` 사전체크만으로 유일성을 지켜왔는데,
이 슬라이스가 추가하는 workspace slug resolution API(전역 유일 전제)가 이 갭 위에 서면 안 되므로
발견 즉시 봉합한다.

방어적 적용: 제약 추가 전 기존 중복 slug가 있으면(이론상 가능 — DB 제약이 없었으므로) 나중에
생성된 행부터 `-2`,`-3`… suffix로 결정적 해소한 뒤 제약을 건다(마이그레이션 자체가 dirty data로
실패하지 않도록 — 8f15ae56/823f08cd류 prod 안전 선례와 동형: 실행 시점에 자가치유).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0186"
down_revision = "0185"
branch_labels = None
depends_on = None


def upgrade() -> None:
    _dedupe_organization_slugs()
    op.create_unique_constraint("uq_organizations_slug", "organizations", ["slug"])


def _dedupe_organization_slugs() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, slug FROM organizations ORDER BY created_at ASC")
    ).fetchall()

    seen: set[str] = set()
    for row in rows:
        slug = row.slug
        if slug not in seen:
            seen.add(slug)
            continue
        n = 2
        while f"{slug}-{n}" in seen:
            n += 1
        new_slug = f"{slug}-{n}"
        seen.add(new_slug)
        conn.execute(
            sa.text("UPDATE organizations SET slug = :slug WHERE id = :id"),
            {"slug": new_slug, "id": row.id},
        )


def downgrade() -> None:
    op.drop_constraint("uq_organizations_slug", "organizations", type_="unique")
