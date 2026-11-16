"""story 4972 — pairing, the new procedure's table (design ② §5-2): the host registers its QR's offer; the phone's commitment, the host's signed nonce and the phone's reveal are carried between them.

The server holds nothing secret and checks no cryptography of the pairing itself (the QR's secret never comes here — the two screens' 8-digit number is the check); what it carries is
public: a 32-byte commitment (an HMAC only the QR's holders can make), the host's random value and its signature over «offer ‖ commitment ‖ value», and the phone's keys · name ·
random value · binding signature. What it ENFORCES is the order and the «one»: one commitment per offer (a second one — from anyone — ends the offer: `burned_at`), one nonce per
commitment, one reveal per nonce; a commitment only from a member of the computer's organization; the window of the QR (≤ 5 min).

A computer that registered such an offer is on the new procedure for good: the old six-digit offer (`remote_device_pairing_offers`) is refused for it afterwards (code, not schema: the table's existence per setup is the mark).

Table: remote_device_pairing_sessions. The CHECKs say the order in the database too: nonce only after a commitment, a reveal only after a nonce, a commitment names who sent it and with which key, a burn names its reason.
Downgrade drops the table (a pairing in flight is lost; nothing paired is touched).
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0481"
down_revision = "0480"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "remote_device_pairing_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("setup_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("offer_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("commit", sa.Text(), nullable=True),
        sa.Column("committed_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("phone_key_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("remote_devices.id", ondelete="CASCADE"), nullable=True),
        sa.Column("committed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("n_m", sa.Text(), nullable=True),
        sa.Column("nonce_sig", sa.Text(), nullable=True),
        sa.Column("nonced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reveal", postgresql.JSONB(), nullable=True),
        sa.Column("revealed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("burned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("burn_reason", sa.Text(), nullable=True),
        sa.UniqueConstraint("setup_id", "offer_id", name="uq_remote_device_pairing_sessions_setup_offer"),
        sa.CheckConstraint(
            "(commit IS NULL) = (committed_by IS NULL) AND (commit IS NULL) = (phone_key_id IS NULL) AND (commit IS NULL) = (committed_at IS NULL)",
            name="ck_pairing_sessions_commit_whole",
        ),
        sa.CheckConstraint(
            "(n_m IS NULL) = (nonce_sig IS NULL) AND (n_m IS NULL) = (nonced_at IS NULL) AND (n_m IS NULL OR commit IS NOT NULL)",
            name="ck_pairing_sessions_nonce_after_commit",
        ),
        sa.CheckConstraint(
            "(reveal IS NULL) = (revealed_at IS NULL) AND (reveal IS NULL OR (n_m IS NOT NULL AND jsonb_typeof(reveal) = 'object'))",
            name="ck_pairing_sessions_reveal_after_nonce",
        ),
        sa.CheckConstraint("(burned_at IS NULL) = (burn_reason IS NULL)", name="ck_pairing_sessions_burn_has_reason"),
        sa.CheckConstraint("commit IS NULL OR char_length(commit) = 43", name="ck_pairing_sessions_commit_size"),
        sa.CheckConstraint("n_m IS NULL OR char_length(n_m) = 22", name="ck_pairing_sessions_nonce_size"),
        sa.CheckConstraint("nonce_sig IS NULL OR char_length(nonce_sig) BETWEEN 16 AND 100", name="ck_pairing_sessions_sig_size"),
    )
    op.create_index("ix_pairing_sessions_setup", "remote_device_pairing_sessions", ["setup_id"])


def downgrade() -> None:
    op.drop_index("ix_pairing_sessions_setup", table_name="remote_device_pairing_sessions")
    op.drop_table("remote_device_pairing_sessions")
