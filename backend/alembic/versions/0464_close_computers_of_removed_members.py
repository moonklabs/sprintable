"""[SID:5b561c3b] Close the computers that members removed from an organization left open — the same values the removal's closer writes

Until story 4769 removing a member from an organization (`DELETE /api/v2/org-members/{id}`) never touched the `desktop_setups` the person had confirmed IN THAT
organization: the account lives on, so the device token, the keys the setup handed out and the agents it made stayed alive, and the owner's list kept the computer as
handed over. The removal now closes them; this migration closes the ones EARLIER removals left (a token + setup-row close alone would leave a live agent key and an
active agent on every such row).

The same one set-based pass as 0463, for every open setup whose confirming person has a seat row in the SETUP'S organization that is soft-deleted (`org_members.deleted_at`):
  · device tokens revoked · the keys the setup handed out revoked · open commands (`queued` · `delivered`) rejected `device_disconnected` (an `answered` permission request
    of a rejected answer moves to rejected; a rejected clock edit loses its typed words) · clock views dropped · the agents the setup made (not the ones it only
    attached) deactivated · the setup row revoked (`revoked_by` = the confirming person — the remover of old rows is not recorded, `revoked_reason` = `member_removed`)
    — written LAST, one transaction. The agent member rows then the setup rows are locked first, in the service's one order, so the migration cannot deadlock with a live
    exchange, disconnect, deletion or removal.
Idempotent; data only; `downgrade` is a no-op. A person who was removed and later rejoined (seat row active again) is not in the set; a person whose ACCOUNT was
deleted was closed by 0463. Not done here: the pushes `reject_open_commands` schedules to the person who answered (a migration sends nothing).
"""
import sqlalchemy as sa

from alembic import op

revision = "0464"
down_revision = "0463"
branch_labels = None
depends_on = None

# the open computers of a person who was removed from the setup's organization (a soft-deleted seat row)
_GONE = (
    "SELECT s.id FROM desktop_setups s JOIN org_members om ON om.org_id = s.org_id AND om.user_id = s.confirmed_by "
    "WHERE s.revoked_at IS NULL AND om.deleted_at IS NOT NULL"
)

# the agents a setup MADE (its `members` line has no `existing` mark), as uuids. The cast sits inside a CASE so that a malformed legacy id can never be cast: a regex in a
# separate WHERE predicate would not guarantee the order the planner evaluates them in.
_MADE = (
    "SELECT x.mid AS id, s.id AS setup_id, s.org_id AS org_id FROM desktop_setups s, "
    "LATERAL (SELECT CASE WHEN e->>'member_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (e->>'member_id')::uuid END AS mid "
    "FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.members) = 'array' THEN s.members ELSE '[]'::jsonb END) AS e "
    "WHERE e->>'kind' = 'agent' AND COALESCE(e->>'existing', 'false') <> 'true') x "
    f"WHERE x.mid IS NOT NULL AND s.id IN ({_GONE})"
)

STATEMENTS = (
    # the service's one lock order first (desktop_setup._lock_in_order: the agent member rows by id, then the setup rows by id) — every live path (an exchange, a disconnect,
    # the account deletion) takes its rows in that order and then updates keys and tokens, so taking them first here keeps this transaction from deadlocking with them
    f"SELECT m.id FROM members m WHERE m.id IN (SELECT id FROM ({_MADE}) made) ORDER BY m.id FOR UPDATE",
    f"SELECT s.id FROM desktop_setups s WHERE s.id IN ({_GONE}) ORDER BY s.id FOR UPDATE",
    # what `reject_open_commands` does besides the commands: an answer a person gave that never reached the device stops reading «answered» (the request moves to rejected)
    (
        "UPDATE agent_permission_requests r SET state = 'rejected', result_code = 'device_disconnected' FROM desktop_commands c "
        f"WHERE c.setup_id IN ({_GONE}) AND c.state IN ('queued', 'delivered') AND c.kind = 'answer_approval' "
        "AND r.setup_id = c.setup_id AND r.state = 'answered' AND r.request_id::text = c.payload->>'request_id' "
        "AND r.stage = CASE WHEN c.payload->>'stage' = 'confirm' THEN 'confirm' ELSE 'ask' END"
    ),
    (
        "UPDATE desktop_commands SET state = 'rejected', result_code = 'device_disconnected', finished_at = now() "
        f"WHERE state IN ('queued', 'delivered') AND setup_id IN ({_GONE})"
    ),
    # …and the typed words of a clock edit that will never reach the computer leave the stored command (desktop_clock._SCRUB_EDIT_SQL, for the rows just rejected)
    (
        "UPDATE desktop_commands SET payload = jsonb_set(payload, '{edit}', jsonb_build_object('base_rev', payload #> '{edit,base_rev}')) "
        f"WHERE setup_id IN ({_GONE}) AND kind = 'clock' AND jsonb_exists(payload, 'edit') "
        "AND (payload #> '{edit}') <> jsonb_build_object('base_rev', payload #> '{edit,base_rev}') AND state IN ('done', 'failed', 'rejected')"
    ),
    f"UPDATE desktop_device_tokens SET revoked_at = now() WHERE revoked_at IS NULL AND setup_id IN ({_GONE})",
    f"UPDATE agent_api_keys SET revoked_at = now() WHERE revoked_at IS NULL AND desktop_setup_id IN ({_GONE})",
    f"DELETE FROM desktop_clock_views WHERE setup_id IN ({_GONE})",
    (
        "UPDATE members m SET is_active = false, updated_at = now() FROM "
        f"({_MADE}) made WHERE m.id = made.id AND m.org_id = made.org_id AND m.type = 'agent' AND m.is_active"
    ),
    (
        "UPDATE desktop_setups SET revoked_at = now(), revoked_by = confirmed_by, revoked_reason = 'member_removed' "
        f"WHERE id IN ({_GONE})"
    ),
)


def upgrade() -> None:
    for statement in STATEMENTS:
        op.execute(sa.text(statement))


def downgrade() -> None:
    pass  # data only: a computer closed because its person left the organization is not re-opened
