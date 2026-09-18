"""story #3645(Phase2·BE, 페드루 PO 確定 2026-09-07 — 3pt·BE만·#3987 뒤) —
`channel_post_versions`에 `hook_key` additive. 훅(캡션 도입부) A/B 태깅용 순수 분석
라벨 — 봉인 축(body_sha256/image_sha256)엔 안 들어간다(값이 바뀌어도 재승인 사유가
아니다). 발행 시점에 evidence payload로 값을 복사해 두므로, 발행 뒤 이 컬럼을 고쳐도
이미 기록된 evidence는 안 바뀐다.

down_revision=0351(develop 현재 head) — 페드루 PO CHANGES(2026-09-07): PR#3987이
qa:changes로 길어져 이 PR이 그걸 기다리지 않게 순서를 바꿨다. #3987의 0352는 이 PR
착지 뒤 0354(down_revision=0353)로 재번호된다(그쪽 PR 몫)."""
from __future__ import annotations

from alembic import op

revision = "0353"
down_revision = "0351"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE channel_post_versions ADD COLUMN IF NOT EXISTS hook_key text")


def downgrade() -> None:
    op.execute("ALTER TABLE channel_post_versions DROP COLUMN IF EXISTS hook_key")
