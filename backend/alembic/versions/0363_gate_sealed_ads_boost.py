"""story #3806(Phase3·3-2 PR2, 페드루 PO 確定 2026-09-11) — `gate.sealed_ads_budget_minor`
+`sealed_ads_currency`+`sealed_ads_starts_at`+`sealed_ads_ends_at`+`sealed_ads_objective`
+`sealed_ads_connection_id` 신설(additive, nullable). `ads_boost` 전용 봉인 축(0345
`sealed_doc_id`/concept_approval과 동형 관례) — 그 gate_type이 아니면 항상 null.
`ads_boost`는 새 gate_type이라 CHECK 제약 갱신 불요(gate_type 컬럼은 free-form Text,
story #3806 PR2 그라운딩 확認).

`sealed_ads_connection_id`는 페드루 PO 追加 確定(2026-09-11, PR 3 착수 직전 보완) —
광고 계정도 승인 대상의 일부다("이 예산을 이 계정에"). FK 없음(channel_connections·
channel_post_drafts와 동일 관례) — org의 meta_ads/ads_sandbox 연결에 유일성 제약이
없어(PR 1이 복수 계정 전제로 설계) 어느 계정에 태울지를 게이트 자신이 봉인해야만
PR 3(실행)가 모호함 없이 destination을 고를 수 있다.

`sealed_ads_boost_version_id`도 같은 追加 確定 — PR 3의 `publication_command`
idempotency 키(org_id, destination, approved_version, operation)에 쓸 approved_
version. site_posts.py/channel_posts.py는 실 SitePostVersion/ChannelPostVersion.id를
그대로 쓰지만(3367 sealed_content_version 동형 질문에 대한 페드루 답), ads_boost는
그런 버전 테이블이 없다 — "PR 2 실물에 맞춰" 매 재봉인(request_ads_boost 호출: 신규·
pending 재봉인·approved 재오픈 전부)마다 새 UUID를 발급하는 쪽으로 PR2 실물에 맞춘다
(정수 카운터가 아니라 UUID인 이유 — approved_version 컬럼 자체가 UUID 타입)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0363"
down_revision = "0362"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("gate", sa.Column("sealed_ads_budget_minor", sa.Integer(), nullable=True))
    op.add_column("gate", sa.Column("sealed_ads_currency", sa.Text(), nullable=True))
    op.add_column("gate", sa.Column("sealed_ads_starts_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("gate", sa.Column("sealed_ads_ends_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("gate", sa.Column("sealed_ads_objective", sa.Text(), nullable=True))
    op.add_column("gate", sa.Column("sealed_ads_connection_id", UUID(as_uuid=True), nullable=True))
    op.add_column("gate", sa.Column("sealed_ads_boost_version_id", UUID(as_uuid=True), nullable=True))


def downgrade() -> None:
    op.drop_column("gate", "sealed_ads_boost_version_id")
    op.drop_column("gate", "sealed_ads_connection_id")
    op.drop_column("gate", "sealed_ads_objective")
    op.drop_column("gate", "sealed_ads_ends_at")
    op.drop_column("gate", "sealed_ads_starts_at")
    op.drop_column("gate", "sealed_ads_currency")
    op.drop_column("gate", "sealed_ads_budget_minor")
