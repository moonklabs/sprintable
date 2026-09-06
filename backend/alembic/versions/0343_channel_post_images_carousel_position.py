"""story #3550(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — Instagram 캐러셀
(이미지 2~10장) 저장 모델. `channel_post_images`의 `UniqueConstraint(version_id)`
(버전당 이미지 1행 하드 제약, story 620beefc)를 완화해 버전당 N행을 허용하고,
`position`(0..N-1) 컬럼으로 순서를 명시한다.

봉인 축(`ChannelPostVersion.image_sha256`, `Gate.sealed_media_sha256`)은 이 마이그와
무관 — 이미 있는 단일 Text 컬럼 그대로 두고, N장일 때는 그 컬럼에 "순서 포함 합성
해시"(position 순으로 이어붙인 각 sha256을 재해시, N=1은 항등)를 담는다(디디 설계
메모·PO 確定 안 A — Gate는 site_posts.py 등과 공유하는 테이블이라 스키마 변경
반경을 이 스토리 스코프 밖으로 둔다)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0343"
down_revision = "0342"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "channel_post_images",
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
    )
    op.drop_constraint("uq_channel_post_images_version", "channel_post_images", type_="unique")
    op.create_unique_constraint(
        "uq_channel_post_images_version_position", "channel_post_images", ["version_id", "position"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_channel_post_images_version_position", "channel_post_images", type_="unique")
    op.create_unique_constraint("uq_channel_post_images_version", "channel_post_images", ["version_id"])
    op.drop_column("channel_post_images", "position")
