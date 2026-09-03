"""story #3373(Phase1·마케팅운영, 그라운딩 doc 6766a399 §7, 선생님 확定 2026-09-03) —
channel_connections: 조직이 연결한 외부 채널 계정의 암호화 credential 원장. 신설 — org_
connector_registry(비밀 저장 금지 설계)와 별개, FK 없음(그라운딩 §9 확定).

⚠️번호 의존성 — story #3367(S2, PR#3733)이 이 시점 아직 develop에 안 머지됐고 0310을 쓰고
있다(sibling-PR). 이 revision은 그 자리를 피해 0311로 잡고 develop 최신(0309) 위에 얹는다 —
S2가 먼저 머지되면 down_revision을 0310으로 rebase(0308→0309 사고와 동형 패턴, 페드루 PO
확定 2026-09-03 06:39Z 선례 그대로 재적용할 것 — 착수 시 확인).

Revision ID: 0311
Revises: 0309
Create Date: 2026-09-03
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0311"
down_revision = "0309"
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
