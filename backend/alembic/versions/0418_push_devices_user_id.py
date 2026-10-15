"""story #4397 — a push device belongs to a person, not to one org: `push_devices.user_id`.

A device row was bound to one org + one org-scoped member (the upsert re-homes the row to the registering session's org), and
sending filtered by org + member. Someone in two orgs got only the org they last opened the app in; the other org's
notifications went nowhere. Sending by person (behind the `push_devices_by_user` setting) needs the person on the row.

Additive only (nullable column + index): the code running in prod before this deploy never reads it.

Backfill — the member id on a row comes from `resolve_member().id`: a human is an `org_members.id` (= `members.id` since 0075),
an agent a `team_members` / `members` id. An old row may point at a member removed since (soft delete) or at a legacy id kept
in `member_identity_aliases`. The person is taken from the first of, in order:
1. org_members (live) · 2. org_members (soft-deleted) · 3. members (human) · 4. member_identity_aliases → members (human).
Agent rows stay NULL (not a person's device). Rows still unresolved are counted in the migration log.

Revision ID: 0418
Revises: 0417
"""
import logging

import sqlalchemy as sa

from alembic import op

revision = "0418"
down_revision = "0417"
branch_labels = None
depends_on = None

_log = logging.getLogger("alembic.runtime.migration")

_BACKFILL = """
UPDATE push_devices pd SET user_id = src.user_id
FROM (
  SELECT d.id AS device_id, coalesce(
    (SELECT om.user_id FROM org_members om WHERE om.id = d.member_id AND om.deleted_at IS NULL),
    (SELECT om.user_id FROM org_members om WHERE om.id = d.member_id AND om.deleted_at IS NOT NULL LIMIT 1),
    (SELECT m.user_id FROM members m WHERE m.id = d.member_id AND m.type = 'human'),
    (SELECT m.user_id FROM member_identity_aliases a JOIN members m ON m.id = a.member_id
      WHERE a.alias_id = d.member_id AND m.type = 'human' LIMIT 1)
  ) AS user_id
  FROM push_devices d
  WHERE d.user_id IS NULL
) src
WHERE pd.id = src.device_id AND src.user_id IS NOT NULL
"""

_UNRESOLVED = """
SELECT
  count(*) AS total,
  count(*) FILTER (WHERE user_id IS NULL) AS unresolved,
  count(*) FILTER (WHERE user_id IS NULL AND is_active) AS unresolved_active,
  count(*) FILTER (WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM members m WHERE m.id = push_devices.member_id AND m.type = 'agent'))
    AS unresolved_agent
FROM push_devices
"""


def upgrade() -> None:
    op.add_column("push_devices", sa.Column("user_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=True))
    op.create_index("ix_push_devices_user_id", "push_devices", ["user_id"])
    bind = op.get_bind()
    bind.execute(sa.text(_BACKFILL))
    row = bind.execute(sa.text(_UNRESOLVED)).mappings().one()
    _log.info(
        "0418 push_devices.user_id backfill: total=%s unresolved=%s (active=%s · agent rows=%s)",
        row["total"], row["unresolved"], row["unresolved_active"], row["unresolved_agent"],
    )


def downgrade() -> None:
    op.drop_index("ix_push_devices_user_id", table_name="push_devices")
    op.drop_column("push_devices", "user_id")
