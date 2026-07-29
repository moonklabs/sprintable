"""story #2327(재정의) — github_webhook_delivery.skipped_reason 신설.

배경: `_process_webhook_event`가 "ignored" 상태로 반환할 때 그 사유(no_installation_id·
installation_not_registered_or_suspended·resolve_story_for_pr 실패·no_actionable_signal 등)를
HTTP 응답 본문으로만 돌려주고 DB에는 안 남겼다 — 웹훅은 GitHub이 호출하는 쪽이라 그 응답을
아무도 안 읽는다. 실측(dev, 2026-07-29): pull_request 이벤트 2468건 중 2건만 processed,
나머지 2466건이 ignored인데 **어느 분기로 얼마나 갔는지 회고로 측정 불가**했다(원인: 이
컬럼 부재). 다음부터는 잴 수 있게 이 컬럼을 남긴다 — 이 마이그 자체가 그 스토리의
AC1(재정의판) 산출물이다.

Revision ID: 0215
Revises: 0214
Create Date: 2026-07-29
"""
from __future__ import annotations

from alembic import op

revision = "0215"
down_revision = "0214"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE github_webhook_delivery ADD COLUMN IF NOT EXISTS skipped_reason varchar(64)")


def downgrade() -> None:
    op.execute("ALTER TABLE github_webhook_delivery DROP COLUMN IF EXISTS skipped_reason")
