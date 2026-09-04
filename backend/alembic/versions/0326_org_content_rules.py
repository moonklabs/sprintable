"""story #3471(Phase1·마케팅운영, 페드루 PO 確定 2026-09-05) — 조직 콘텐츠 규칙 저장소
(`org_content_rules`) 신설 + 초안 draft에 lint 결과 캐시 컬럼.

블루프린트 v3 §2(f)·처분표(3b9960cb) 8행 "조직 규칙 lint" — 제품이 기계로 검사하는
것은 금칙어(banned_terms)·UTM 필수(require_utm) 둘뿐(rules JSONB에 자유 형식으로
저장 — 톤·택소노미·채널 우선순위·브랜드 킷은 에이전트가 읽는 선언 슬롯이라 같은
JSONB 안에 같이 담기되 서버가 lint하지 않는다). 이력 테이블은 두지 않는다 —
`version`(PUT마다 +1)+`updated_by_member_id`로 감사 충분(story #3397의 "파생
가능한 합계를 별도 저장하지 않는다" 원칙과 동형 — 규칙 diff는 audit log가 아니라
이 시점 스냅샷만 필요).

`lint_result`(channel_post_drafts·site_post_drafts) — draft 축에 저장(버전 축
아님, AC5 "규칙 PUT 뒤에도 이미 저장된 draft.lint_result.rules_version은 그대로"
明示 — 이 값은 매번 실시간 재계산되는 게 아니라 "마지막 편집 시점의 lint 결과"
스냅샷이고, 그 스냅샷의 rules_version이 그대로 남아야 회귀가 성립한다).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0326"
down_revision = "0325"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "org_content_rules",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False, unique=True),
        sa.Column("rules", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="{}"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_by_member_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.add_column(
        "channel_post_drafts",
        sa.Column("lint_result", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "site_post_drafts",
        sa.Column("lint_result", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("site_post_drafts", "lint_result")
    op.drop_column("channel_post_drafts", "lint_result")
    op.drop_table("org_content_rules")
