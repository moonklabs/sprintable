"""story #3815(Phase3·3-5 PR2, 페드루 PO 確定 2026-09-12) — `channel_publications.
privacy_locked`. YouTube API 감사 미완 프로젝트(settings.youtube_api_audit_
incomplete)면 발행 시 privacyStatus를 요청값 무관 private로 강제한다(PO 決定②)
— 이 사실은 발행 "그 순간"의 판정이라 나중에 감사가 끝나 플래그가 꺼져도
과거 발행물이 그때 잠겼었다는 사실 자체는 안 바뀌어야 한다(연결 전역 플래그가
아니라 발행물 행에 못박는 이유). `status`는 그대로 "published" 유지(페드루 明示
④ — 이 열은 status 밖의 별개 사실, FE가 "게시됨(비공개)" 라벨을 조합할 때 참고).

다른 채널(threads/instagram/facebook 등)은 이 열을 절대 안 건드려 server_default
false 그대로(0369 sequence 열과 동형 안전성 논증 — additive, 회귀 0).

Revision ID: 0372
Revises: 0371
Create Date: 2026-09-12

페드루 PO 지적(2026-09-12 11:12Z) — 이 파일을 처음 0371로 썼을 때 develop엔
이미 실 0371(`0371_channel_connections_provider_config.py`, story #3813 PR5-b
#4222 착지분)이 있었다(내 브랜치가 그 착지 前에 갈라져 로컬엔 안 보였다) —
alembic heads 2=CI 체인 RED가 됐을 자리. 0372·down_revision=0371로 재번호
(4223 착지 뒤 develop HEAD로 rebase할 때 그대로 유지)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0372"
down_revision = "0371"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "channel_publications",
        sa.Column("privacy_locked", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("channel_publications", "privacy_locked")
