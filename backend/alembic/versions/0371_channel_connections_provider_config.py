"""story #3813(Phase3·3-4 PR5-b, 페드루 PO 確定 2026-09-12) — 실 stibee 발행에
필요한 발신자 정보(senderEmail·senderName)를 저장할 자리 신설.

`account_id`/`account_label` 둘로는 부족하다(stibee는 이미 account_id="default"
고정·account_label=사람이 입력한 주소록 ID로 둘 다 채워져 있다, PR5-a) — 세 번째
값이 필요해진 첫 채널. `channel_post_versions.channel_payload`(0370, "컬럼 이름에
채널 이름 안 붙임")와 같은 설계 원칙 — 채널마다 각자 컬럼을 늘리지 않고 범용
JSONB 슬롯 하나를 공유한다(다음 채널이 또 필드가 필요해져도 신규 마이그 0)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0371"
down_revision = "0370"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("channel_connections", sa.Column("provider_config", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("channel_connections", "provider_config")
