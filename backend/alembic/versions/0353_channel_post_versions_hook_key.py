"""story #3645(Phase2·BE, 페드루 PO 確定 2026-09-07 — 3pt·BE만·#3987 뒤) —
`channel_post_versions`에 `hook_key` additive. 훅(캡션 도입부) A/B 태깅용 순수 분석
라벨 — 봉인 축(body_sha256/image_sha256)엔 안 들어간다(값이 바뀌어도 재승인 사유가
아니다). 발행 시점에 evidence payload로 값을 복사해 두므로, 발행 뒤 이 컬럼을 고쳐도
이미 기록된 evidence는 안 바뀐다.

down_revision을 0352(#3987/#3635)로 고정 — 그 슬롯이 먼저 develop에 착지한다는
PO 사전 지정(순서: 3649 > #3987 > 3645 > 3646). 로컬 head가 아직 0351이면 #3987이
착지하기 前이라는 뜻 — 착지 뒤 rebase로 자연히 이어진다(이 세션의 기존 재넘버 관례
그대로)."""
from __future__ import annotations

from alembic import op

revision = "0353"
down_revision = "0352"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE channel_post_versions ADD COLUMN IF NOT EXISTS hook_key text")


def downgrade() -> None:
    op.execute("ALTER TABLE channel_post_versions DROP COLUMN IF EXISTS hook_key")
