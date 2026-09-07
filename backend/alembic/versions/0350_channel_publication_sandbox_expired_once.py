"""story #3640(BE·샌드박스 리그·소형, 페드루 PO 確定 2026-09-07) — `channel_publications`에
`sandbox_expired_once` additive. `[sandbox:expire-after-publish]` 마커가 media_id에
영구 접미사를 새겨 댓글 수집이 발행물마다 «매번» 401을 던지던 「영구 지뢰」(dev PO
Test Org Sandbox Page 1 실사고)를 닫는다 — 이 발행물이 그 401을 이미 한 번 관측했으면
(양성대조 완료) True, 그 뒤부터 channel_post_comments.py가 접미사를 벗긴 media_id로
재조회해 200을 받는다."""
from __future__ import annotations

from alembic import op

revision = "0350"
down_revision = "0349"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE channel_publications ADD COLUMN IF NOT EXISTS sandbox_expired_once "
        "boolean NOT NULL DEFAULT false"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE channel_publications DROP COLUMN IF EXISTS sandbox_expired_once")
