"""story #4424 — desktop setup: one setup code → a person confirms on the web → the desktop app exchanges once for the keys.

- `desktop_setups`: one row per setup code. Only `code_hash` (sha256) of the code is stored, and the PKCE `code_challenge`
  (S256). The web confirmation fills org/project/recipe/who/when and `members` (the stage → member it bound, kind agent|human,
  runtime); the exchange sets `exchanged_at` (the keys were handed over, once); «disconnect this device» sets `revoked_at` /
  `revoked_by`. The row itself is the audit record (who · which device · how many agents/keys · when handed · when cut).
- `agent_api_keys.desktop_setup_id`: the setup a key was handed out by — «disconnect this device» revokes exactly those.
  Nullable (every existing key was made elsewhere); SET NULL if a setup row is ever deleted (the key stays revocable as usual).

Revision ID: 0422
Revises: 0421
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0422"
down_revision = "0421"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "desktop_setups",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("code_hash", sa.Text(), nullable=False),
        sa.Column("code_challenge", sa.Text(), nullable=False),
        sa.Column("device_name", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=True),
        sa.Column("event_definition_key", sa.Text(), nullable=True),
        sa.Column("confirmed_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("members", postgresql.JSONB(), nullable=True),
        sa.Column("exchanged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("keys_issued", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("char_length(device_name) BETWEEN 1 AND 80", name="ck_desktop_setups_device_name_len"),
        sa.CheckConstraint("exchanged_at IS NULL OR confirmed_at IS NOT NULL", name="ck_desktop_setups_exchange_after_confirm"),
    )
    op.create_index("uq_desktop_setups_code_hash", "desktop_setups", ["code_hash"], unique=True)
    op.create_index("ix_desktop_setups_org_id", "desktop_setups", ["org_id"])
    op.add_column(
        "agent_api_keys",
        sa.Column(
            "desktop_setup_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("desktop_setups.id", ondelete="SET NULL", name="fk_agent_api_keys_desktop_setup_id"), nullable=True,
        ),
    )
    op.create_index("ix_agent_api_keys_desktop_setup_id", "agent_api_keys", ["desktop_setup_id"])


def downgrade() -> None:
    op.drop_index("ix_agent_api_keys_desktop_setup_id", table_name="agent_api_keys")
    op.drop_constraint("fk_agent_api_keys_desktop_setup_id", "agent_api_keys", type_="foreignkey")
    op.drop_column("agent_api_keys", "desktop_setup_id")
    op.drop_index("ix_desktop_setups_org_id", table_name="desktop_setups")
    op.drop_index("uq_desktop_setups_code_hash", table_name="desktop_setups")
    op.drop_table("desktop_setups")
