"""[SID:8cf8946e] Close the computers that deleted accounts left open — the same values `desktop_setup.close_setups_of_deleted_account` writes

Until story 4767 an account deletion never touched the `desktop_setups` the person had confirmed in an organization that outlived the account: the device
token, the keys the setup handed out and the agents it made stayed alive, and the owner's list kept the computer as handed over. The deletion now closes them;
this migration closes the ones EARLIER deletions left (security lens 4767: closing only the token and the setup row would leave a live agent key and an active
agent on every such row — the keys are what a deleted person's Mac still uses in someone else's organization).

One set-based pass, the same closing values for every open setup whose confirming account is closed or deleted:
  · device tokens revoked · the keys the setup handed out revoked · open commands (`queued` · `delivered`) rejected `device_disconnected` · clock views dropped ·
    the agents the setup made (not the ones it only attached) deactivated · the setup row revoked (`revoked_by` = the confirming person, `revoked_reason` =
    `account_deleted`) — written LAST, so every statement above still sees the rows as open and a run that stops halfway leaves nothing half closed (one transaction).
Idempotent: a second run finds no open setup of a gone person and changes nothing. Data only — no schema change; `downgrade` is a no-op (a closed computer is not
re-opened). An organization that closed with the account took its setups with it (cascade) and is not in the set.
"""
import sqlalchemy as sa

from alembic import op

revision = "0463"
down_revision = "0462"
branch_labels = None
depends_on = None

# the open computers of a person whose account is closed or deleted
_GONE = (
    "SELECT s.id FROM desktop_setups s JOIN users u ON u.id = s.confirmed_by "
    "WHERE s.revoked_at IS NULL AND (u.is_active IS NOT TRUE OR u.deleted_at IS NOT NULL)"
)

STATEMENTS = (
    f"UPDATE desktop_device_tokens SET revoked_at = now() WHERE revoked_at IS NULL AND setup_id IN ({_GONE})",
    f"UPDATE agent_api_keys SET revoked_at = now() WHERE revoked_at IS NULL AND desktop_setup_id IN ({_GONE})",
    (
        "UPDATE desktop_commands SET state = 'rejected', result_code = 'device_disconnected', finished_at = now() "
        f"WHERE state IN ('queued', 'delivered') AND setup_id IN ({_GONE})"
    ),
    f"DELETE FROM desktop_clock_views WHERE setup_id IN ({_GONE})",
    # the agents the setup MADE (its `members` line has no `existing` mark), in the setup's own organization — an agent it only attached keeps running elsewhere
    (
        "UPDATE members m SET is_active = false, updated_at = now() "
        "FROM desktop_setups s, "
        "LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.members) = 'array' THEN s.members ELSE '[]'::jsonb END) AS e "
        f"WHERE s.id IN ({_GONE}) "
        "AND e->>'kind' = 'agent' AND COALESCE(e->>'existing', 'false') <> 'true' "
        "AND e->>'member_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' "
        "AND m.id = (e->>'member_id')::uuid AND m.org_id = s.org_id AND m.type = 'agent' AND m.is_active"
    ),
    (
        "UPDATE desktop_setups SET revoked_at = now(), revoked_by = confirmed_by, revoked_reason = 'account_deleted' "
        f"WHERE id IN ({_GONE})"
    ),
)


def upgrade() -> None:
    for statement in STATEMENTS:
        op.execute(sa.text(statement))


def downgrade() -> None:
    pass  # data only: a computer closed because its person is gone is not re-opened
