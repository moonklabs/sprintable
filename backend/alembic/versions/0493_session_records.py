"""[SID:4977 B2] session_records — the person's history (an instruction typed on the phone · an approval's outcome) kept as SEALED records the server cannot open

One row = one record envelope (`chat_line` · `approval_record`, design ② §4-1b) exactly as the writer sealed it: `envelope` is an opaque JSON object — the server never holds the record
key R, so it can neither read nor re-write a word. The columns beside it are the header's own words (conversation · record id · kind · generation · the writer's key id · a size) — what the
server needs to find, page, replace and delete a row, and nothing of the content. No text column, no search column: this table is in no index, no webhook, no notification, no list of the chat
(it is not `conversation_messages`; nothing reads it but its own routes).

- `setup_id` = the computer line the record was written on (no foreign key — the history outlives a computer that is removed or reinstalled; the person keeps it until THEY delete it:
  there is no TTL and no automatic delete here, the 11-16 decision «사용자 기록은 사용자가 지울 때까지 · 자동 삭제는 전달용 복사본만»). A reinstall makes a new setup row of the same machine: the
  reader finds the earlier records through the person's OWN setups of that machine (`desktop_setups.machine_key`, judged at read time) — the table holds no machine word. What does go: a closed
  organization or a deleted account takes its records with it (ON DELETE CASCADE below) — that is the person's own act of deleting, not an aging.
- `conversation_id` → conversations ON DELETE CASCADE (a deleted room takes its records), `org_id` → organizations ON DELETE CASCADE (an account purge takes them).
- `owner_id` = the person (`desktop_setups.confirmed_by`) whose history it is: one record id is one row per (conversation, person) (`uq_session_records_conv_owner_record`) — two persons of one room never meet in
  a key, so a record id of one is no oracle for the other. The same id again is a replace by the same writer (a later counter) or a refusal — judged in the service.
- a deleted record stays as a TOMBSTONE (`deleted_at` set, `envelope` = `{}`: no sealed content, no size, only the ids and counters) so a delayed or replayed envelope of the same id cannot bring it back
  (409 `record_deleted`); a tombstone is no longer counted against a computer's limit and no reader lists it. It goes with its room or its organization.
- `seq` = a database-wide ever-growing number (identity BY DEFAULT) the reader pages by (`after=<seq>`); a record replaced later is given a new one (`nextval`), so it moves to the end of the line and is seen again.

Additive only: a new table, no backfill, nothing of an existing table touched. Why a running old revision lives with it: it never names `session_records`, and no existing table, column,
constraint or index changed. Downgrade drops the table (the records go with it — a downgrade is a rollback of the feature, not a migration of data).

Revision ID: 0493
Revises: 0492
Create Date: 2026-11-21
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0493"
down_revision = "0492"
branch_labels = None
depends_on = None

KINDS = ("chat_line", "approval_record")


def upgrade() -> None:
    op.create_table(
        "session_records",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("setup_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("conversation_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("record_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("rec_gen", sa.Integer(), nullable=False),
        sa.Column("writer", sa.Text(), nullable=False),
        sa.Column("epoch", sa.BigInteger(), nullable=False),
        sa.Column("ctr", sa.BigInteger(), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("envelope", postgresql.JSONB(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("clock_timestamp()"), nullable=False),
        sa.Column("replaced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("kind IN ('chat_line', 'approval_record')", name="ck_session_records_kind"),
        sa.CheckConstraint("jsonb_typeof(envelope) = 'object'", name="ck_session_records_envelope_object"),
        sa.CheckConstraint("rec_gen >= 1 AND epoch >= 0 AND ctr >= 0 AND byte_size > 0", name="ck_session_records_numbers"),
        sa.CheckConstraint("deleted_at IS NULL OR envelope = '{}'::jsonb", name="ck_session_records_tombstone_empty"),
        sa.CheckConstraint("char_length(record_id) BETWEEN 1 AND 256 AND char_length(writer) BETWEEN 1 AND 256", name="ck_session_records_text_len"),
    )
    op.create_index("uq_session_records_conv_owner_record", "session_records", ["conversation_id", "owner_id", "record_id"], unique=True)
    op.create_index("uq_session_records_seq", "session_records", ["seq"], unique=True)
    op.create_index("ix_session_records_setup_seq", "session_records", ["setup_id", "seq"])
    op.create_index("ix_session_records_owner", "session_records", ["owner_id", "org_id"])  # the person's own count (the limit) and the cleanup when they leave


def downgrade() -> None:
    op.drop_table("session_records")
