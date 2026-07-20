"""story b07ad526(E-AUTH-REBUILD M2 Phase1-S1): auth_identities/auth_migrations/
auth_migration_events additive 스키마(doc firebase-auth-identity-platform-migration-poc §3.2).

Revision ID: 0188
Revises: 0187
Create Date: 2026-07-15

전부 additive — 기존 스키마 무회귀. 신규 테이블만 신설, 기존 users/auth 경로 무변경.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0188"
down_revision = "0187"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "auth_identities",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("issuer", sa.Text(), nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=True),
        sa.Column("subject", sa.Text(), nullable=False),
        sa.Column("provider_id", sa.Text(), nullable=True),
        sa.Column("provider_subject", sa.Text(), nullable=True),
        sa.Column("email_at_link", sa.Text(), nullable=True),
        sa.Column("email_verified_at_link", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("linked_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("unlinked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_auth_identities_user_id", "auth_identities", ["user_id"])
    op.create_unique_constraint("uq_auth_identities_issuer_subject", "auth_identities", ["issuer", "subject"])
    op.create_index(
        "uq_auth_identities_issuer_provider_subject",
        "auth_identities",
        ["issuer", "provider_id", "provider_subject"],
        unique=True,
        postgresql_where=sa.text("unlinked_at IS NULL"),
    )

    op.create_table(
        "auth_migrations",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("state", sa.Text(), nullable=False, server_default="legacy"),
        sa.Column("method", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("firebase_uid", sa.Text(), nullable=True),
        sa.Column("legacy_auth_allowed_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("mfa_reenroll_required", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("last_error_code", sa.Text(), nullable=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )

    op.create_table(
        "auth_migration_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("from_state", sa.Text(), nullable=True),
        sa.Column("to_state", sa.Text(), nullable=False),
        sa.Column("method", sa.Text(), nullable=True),
        sa.Column("reason_code", sa.Text(), nullable=True),
        sa.Column("request_id", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_auth_migration_events_user_id", "auth_migration_events", ["user_id"])


def downgrade() -> None:
    op.drop_table("auth_migration_events")
    op.drop_table("auth_migrations")
    op.drop_index("uq_auth_identities_issuer_provider_subject", table_name="auth_identities")
    op.drop_constraint("uq_auth_identities_issuer_subject", "auth_identities", type_="unique")
    op.drop_index("ix_auth_identities_user_id", table_name="auth_identities")
    op.drop_table("auth_identities")
