"""[SID:4726] End the org_members rows that belong to organizations deleted before the delete path learned to end them.

Deleting an organization removed only the organizations row (org_members.org_id has no foreign key), so every person who had
deleted an organization kept a live (deleted_at NULL) membership row for it — an owner row counted in the free plan's
owned-organization limit and blocked a new organization (402 «free plan org limit (1)»). The delete path now ends the rows with the
organization (repositories/organization.py delete_by_user); this backfill ends the ones already left behind.

Data only: rows whose organization no longer exists get deleted_at = now(). Nothing else is touched. Running it again changes nothing.
Same soft, reversible way as 0091 (dead-org tombstone of 2026-06-04: «하드 DELETE 안 함»), with the same guard: an empty organizations table is skipped,
because then every row would look orphaned.
The downgrade does nothing (the ended rows belong to organizations that do not exist, so there is nothing to restore them to).

Numbering: 0455 is taken by PR 5132 (desktop_setup_startable, down_revision 0454), which merges first; this one chains after it (down_revision 0455).
"""
from alembic import op

revision = "0456"
down_revision = "0455"
branch_labels = None
depends_on = None

# Exported so the real-DB test runs exactly this statement.
BACKFILL_SQL = """
UPDATE org_members
   SET deleted_at = now()
 WHERE deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM organizations)
   AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = org_members.org_id)
"""


def upgrade() -> None:
    op.execute(BACKFILL_SQL)


def downgrade() -> None:
    pass
