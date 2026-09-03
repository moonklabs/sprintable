"""story #3373(Phase1·마케팅운영, 그라운딩 doc 6766a399 §7, 선생님 확定 2026-09-03) —
channel_connections: 조직이 연결한 외부 채널 계정의 암호화 credential 원장. 신설 — org_
connector_registry(비밀 저장 금지 설계)와 별개, FK 없음(그라운딩 §9 확定).

⚠️번호 의존성(페드루 PO 확定 2026-09-03 07:26Z) — 이 시점 develop은 아직 0309까지만
머지됐고, S2(story #3367, PR#3733)가 0310(revision 5cb28dfe5)·S3(story #3369, PR#3734,
feature/3369-publish-projection)가 0311(commit 80337e0ab)을 sibling-PR로 각각 쓰고
있다. 머지 순서는 S2(0310) → S3(0311) → 이 PR이라 down_revision을 0311로 미리 잡는다
— S2·S3 두 브랜치를 로컬에 fetch해 0309→0310→0311→0312 전체 사슬 upgrade/downgrade/
re-upgrade 왕복까지 실PG로 확認 완료(둘 다 develop에 아직 없어 로컬 임시 사본으로
검증, 커밋엔 포함 안 함 — 실제 파일은 그 PR들이 머지되며 develop에 들어온다). 실
머지 순서가 이 스냅샷과 달라지면(예: S3가 rebase로 번호가 바뀌면) 착수 시 재확認할 것.

Revision ID: 0312
Revises: 0311
Create Date: 2026-09-03
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0312"
down_revision = "0311"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "channel_connections",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("account_id", sa.Text(), nullable=False),
        sa.Column("account_label", sa.Text(), nullable=True),
        sa.Column("credential_kind", sa.Text(), nullable=False, server_default="oauth"),
        sa.Column("encrypted_access_token", sa.Text(), nullable=True),
        sa.Column("encrypted_refresh_token", sa.Text(), nullable=True),
        sa.Column("token_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("refresh_mode", sa.Text(), nullable=False, server_default="manual"),
        sa.Column("scopes", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="[]"),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column("last_refreshed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("connected_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("org_id", "channel", "account_id", name="uq_channel_connections_org_channel_account"),
    )
    op.create_index("ix_channel_connections_org_id", "channel_connections", ["org_id"])
    # 만료 임박 조회(cron)의 조건 컬럼 — status='active' 부분 인덱스로 스캔 범위를 좁힌다.
    op.create_index(
        "ix_channel_connections_token_expires_at", "channel_connections", ["token_expires_at"],
        postgresql_where=sa.text("status = 'active'"),
    )


def downgrade() -> None:
    op.drop_index("ix_channel_connections_token_expires_at", table_name="channel_connections")
    op.drop_index("ix_channel_connections_org_id", table_name="channel_connections")
    op.drop_table("channel_connections")
