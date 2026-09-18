"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각③c) —
`publication_commands.content_kind`(channel_post|site_post) 도메인 구분자.

`_process_one_command()`(publication_command.py)이 지금은 `ChannelPostVersion`/
`publish_channel_post_draft`에 하드코딩돼 있다 — `approved_version`이 어느 테이블
(ChannelPostVersion vs SitePostVersion)을 가리키는지 구분할 컬럼이 없어 워커가
site_post/blog 커맨드를 못 판별한다. `kind`(ChannelAdapterConfig, 조각①)와 같은
SSOT 선언 사상 — try-both 테이블 조회(FK 없는 기존 관례를 여기 적용) 대신 명시
컬럼으로 워커가 분기한다.

NOT NULL + server_default='channel_post'(기존 prod 행 전부 이 값으로 채워짐 —
ADD COLUMN with DEFAULT는 Postgres 11+에서 메타데이터만 바뀌어 짧은 락, 페드루
확定) + CHECK(channel_post|site_post) — 페드루 확定 그대로. 멱등키(org_id+
destination+approved_version+operation)는 UUID가 전역 유일이라 이 컬럼 추가와
무관(재설계 불요).

Revision ID: 0323
Revises: 0322
Create Date: 2026-09-04
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0323"
down_revision = "0322"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "publication_commands",
        sa.Column("content_kind", sa.Text(), nullable=False, server_default="channel_post"),
    )
    op.create_check_constraint(
        "ck_publication_commands_content_kind",
        "publication_commands",
        "content_kind IN ('channel_post', 'site_post')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_publication_commands_content_kind", "publication_commands", type_="check")
    op.drop_column("publication_commands", "content_kind")
