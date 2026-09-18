"""story #3360(발행 구조·서버, 선생님 확定 2026-09-03 00:53Z·00:55Z) — 자사 사이트 글을
Sprintable 백엔드에 저장(site_posts). 발행 = 승인 게이트(external_publish) 통과한 글 1행 —
코드 저장소 커밋(#3352 site_git)은 «오늘 실물»용 지름길이었고 제품 구조가 아니다(선생님
명시). unique(org_id, lang, slug) — 재발행은 같은 행 upsert.

⚠️번호 의존성 — story #3354(PR#3728, `0306_pageview_counter.py`)의 `org_metering_keys`를
공개 읽기 API의 «org 공개키»로 그대로 재사용한다(새 키 개념 발명 0, 페드루 확定). 그래서 이
브랜치는 feat/3354-pageview-counter 위에서 시작했고, 0306은 이미 실존해 down_revision을
바로 정확한 값으로 잡을 수 있었다(#3337/#3340류의 "임시 번호 뒤 rebase" 우회가 불필요 —
#3728이 develop에 머지되면 이 브랜치를 그 위로 다시 rebase하는 것만으로 충돌 없이 이어진다).

Revision ID: 0307
Revises: 0306
Create Date: 2026-09-03
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0307"
down_revision = "0306"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "site_posts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("lang", sa.Text(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("tags", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="[]"),
        sa.Column("body_md", sa.Text(), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_story_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("gate_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_by_member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("unpublished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("org_id", "lang", "slug", name="uq_site_posts_org_lang_slug"),
    )
    op.create_index("ix_site_posts_org_id", "site_posts", ["org_id"])


def downgrade() -> None:
    op.drop_index("ix_site_posts_org_id", table_name="site_posts")
    op.drop_table("site_posts")
