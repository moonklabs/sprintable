"""story #3497(Phase2·마케팅운영, 페드루 決定 2026-09-05) — `insight_snapshots` 신설 +
`evidence.payload` additive 컬럼. 블루프린트 v3 §2(d)·§3 「인사이트 수집·Evidence
정규화」의 저장 축.

`insight_snapshots`는 FK 없음(publication_commands·channel_connections와 동일 관례,
그라운딩 §9) — `publication_id`가 hosted_site면 site_posts.id, 외부 목적지면
channel_publications.id를 가리킬 뿐 이 테이블 자체는 그 구분을 모른다.

`publication_kind`(TEXT NOT NULL, 페드루 REQUEST_CHANGES①)가 그 구분을 명시한다
('site_post'|'channel_publication') — "channel=hosted_site면 site_post"라는 암묵
규칙에 기대지 않는다. `work_item_id`(UUID NOT NULL, REQUEST_CHANGES②)는 비정규화 —
조각 2 tick이 evidence를 쓸 때 3단 조인 없이 바로 쓰고, 조회 API의 work item 축에도
쓴다(등록 시점엔 이미 안다).

`evidence.payload`(JSONB NULL) — type="metric" evidence가 note(사람용 한 줄)와 별개로
정규화된 7키+captured_at+source+snapshot_id를 구조화해서 싣는다. note만으로는 "채널
원본 지표와 evidence 대조"(§7)가 text 파싱에 얹히는 두 번째 지름길이 된다는 페드루
판단 — additive라 기존 evidence 행(payload=NULL)은 회귀 0.

down_revision=0331은 story #3492(#3841, channel_connections.secret_hint) — 이 스토리
착수 시점에 develop 미착지였다(gh pr list로 실물 확인, 열린 PR 스택(#3835→#3836→
#3837→#3841)의 alembic/versions까지가 SSOT, 0327 이후 이 세션 전체가 써 온 관례)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0332"
down_revision = "0331"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "insight_snapshots",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("publication_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("publication_kind", sa.Text(), nullable=False),
        sa.Column("work_item_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("external_id", sa.Text(), nullable=True),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=False, index=True),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=True),
        # 'pending'|'captured'|'unsupported'|'failed'|'dead_letter' — Text(CHECK
        # 없음, publication_commands.status와 동형 관례).
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("raw_payload", postgresql.JSONB(), nullable=True),
        sa.Column("normalized", postgresql.JSONB(), nullable=True),
        sa.Column("source", sa.Text(), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_unique_constraint(
        "uq_insight_snapshots_publication_due_at", "insight_snapshots", ["publication_id", "due_at"],
    )
    op.add_column("evidence", sa.Column("payload", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("evidence", "payload")
    op.drop_table("insight_snapshots")
