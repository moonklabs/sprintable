"""story #3502(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 성과 보드 API(조직 전체
publication 표) 서비스 쿼리를 받쳐 줄 인덱스. 두 테이블(hosted_site=`site_posts`·외부
채널=`channel_publications`)을 org 단위로 `published_at` 내림차순 정렬·페이지네이션
하는 UNION ALL 쿼리(app/services/insights_board.py)가 이 인덱스 없이는 org_id 단일
인덱스만 타 시퀀스 스캔+정렬이 된다.

`published_at DESC`만 두고 `id`는 인덱스에 안 넣는다 — 커서의 2차 정렬키(id)는 동률
구간(같은 published_at)에서만 필요한데 그 구간이 좁아 인덱스 없이도 실용적으로 빠르다
(과도한 인덱스 확장 회피, story 確定 그대로 "두 열"만).

down_revision=0333은 story #3498(#3847)의 마이그 — 이 스토리 착수 시점에 develop
미착지였다(gh pr list로 실물 확인, 스택 관례 그대로)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0334"
down_revision = "0333"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_site_posts_org_id_published_at", "site_posts", ["org_id", sa.text("published_at DESC")],
    )
    op.create_index(
        "ix_channel_publications_org_id_published_at", "channel_publications",
        ["org_id", sa.text("published_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_channel_publications_org_id_published_at", table_name="channel_publications")
    op.drop_index("ix_site_posts_org_id_published_at", table_name="site_posts")
