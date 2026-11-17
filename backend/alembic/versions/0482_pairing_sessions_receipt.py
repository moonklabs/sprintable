"""story 4972 (wiring 4a) — the computer's signed receipt on a pairing session: «I confirmed THIS offer».

Two nullable columns on `remote_device_pairing_sessions`: `confirmed_sig` (the computer's signature over the offer, the phone's keys, both nonces, the number, the bit and the name — the phone checks it with the
computer's key from the QR; the server only carries it) and `confirmed_at`. The CHECKs say the same in the database: both or neither · only after a reveal · the size of the nonce's signature.
Additive: nothing reads the columns until a phone and a computer of the next steps do (a receipt-less offer is exactly what it was). Downgrade drops them (a receipt in flight is lost; nothing paired is touched).
"""
import sqlalchemy as sa
from alembic import op

revision = "0482"
down_revision = "0481"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("remote_device_pairing_sessions", sa.Column("confirmed_sig", sa.Text(), nullable=True))
    op.add_column("remote_device_pairing_sessions", sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint("ck_pairing_sessions_confirm_whole", "remote_device_pairing_sessions", "(confirmed_sig IS NULL) = (confirmed_at IS NULL)")
    op.create_check_constraint("ck_pairing_sessions_confirm_after_reveal", "remote_device_pairing_sessions", "confirmed_sig IS NULL OR reveal IS NOT NULL")
    op.create_check_constraint("ck_pairing_sessions_confirm_size", "remote_device_pairing_sessions", "confirmed_sig IS NULL OR char_length(confirmed_sig) BETWEEN 16 AND 100")


def downgrade() -> None:
    op.drop_constraint("ck_pairing_sessions_confirm_size", "remote_device_pairing_sessions", type_="check")
    op.drop_constraint("ck_pairing_sessions_confirm_after_reveal", "remote_device_pairing_sessions", type_="check")
    op.drop_constraint("ck_pairing_sessions_confirm_whole", "remote_device_pairing_sessions", type_="check")
    op.drop_column("remote_device_pairing_sessions", "confirmed_at")
    op.drop_column("remote_device_pairing_sessions", "confirmed_sig")
