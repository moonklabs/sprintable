"""story #3734(결함·high, 선생님 UI 점검 지시 2026-09-09 06:22Z 후속) — site_post_drafts·
channel_post_drafts에 `deleted_at`(SoftDeleteMixin, 레포 SSOT — 15+ 모델 기존 관례,
서비스단 `.where(deleted_at.is_(None))`) additive. 스모크/테스트 표본을 «치울 방법»이
제품에 없어(delete/archive API 0·목록 액션 0) PO 손조작 없이는 목록에서 절대 안 사라지던
결함의 근본 처방 — «보관»(화면 낱말, 유나 定) 원시. 발행/승인 기록(Gate·SitePost·
ChannelPublication)은 이 컬럼과 무관 — 삭제가 아니라 목록에서만 빼는 소프트 축이라
#3291(external_publish 항상-수동 게이트) 무변."""
from __future__ import annotations

from alembic import op

revision = "0356"
down_revision = "0355"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE site_post_drafts ADD COLUMN IF NOT EXISTS deleted_at timestamptz")
    op.execute("ALTER TABLE channel_post_drafts ADD COLUMN IF NOT EXISTS deleted_at timestamptz")


def downgrade() -> None:
    op.execute("ALTER TABLE channel_post_drafts DROP COLUMN IF EXISTS deleted_at")
    op.execute("ALTER TABLE site_post_drafts DROP COLUMN IF EXISTS deleted_at")
