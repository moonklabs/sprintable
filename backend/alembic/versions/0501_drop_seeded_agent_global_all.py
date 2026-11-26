"""[SID:5030] C0 — take back the «global / sse / all» notification row that agent creation wrote for every agent.

`insert_default_preferences` (notification_preference_defaults) wrote `global · sse · all` for each new agent. Nobody chose it. The channel router puts an explicit row ahead of the
product default, so an agent with that row kept receiving every word of every group room — and the «agent hears only the words that call it» default (story 2603) never reached it.
Only an agent WITHOUT the row met that default, which is why the August switch-on looked like «some of the team is blocked» (the hotfix 3008 turned the default off). 5030 stops
writing the row (code) and removes the rows that are PROVEN to be the seed (this migration).

A row is removed only when ALL of this holds (a person's choice leaves at least one of these different — and the ones of a person who re-saved the same value differ in `updated_at`):
- the owner is an agent (`members.type = 'agent'`); scope `global`, no scope id, no event key; channel `sse`; level `all` — exactly what the seed wrote;
- `updated_at = created_at` — nobody has written the row since it was made (the preferences API sets `updated_at` on every save, also a save of the same value);
- the row was made within 5 seconds of the agent itself (`members.created_at`) — the seed is written in the request that creates the agent; a row a person made later is not this.
Everything else stays: `in_app` rows, rows another value, rows touched later, and every conversation / project / thread / event-key row (the per-channel «receive all» switch is one of them).

Data only, no schema. On dev (read-only, 11-26) the seed rows were made 0.007 s to 1.14 s after their agent (median 0.04 s, 99% 0.34 s); the rule matched 4,101 of 4,103 agent global rows, no untouched seed-shaped row lies outside the window, and the other two rows are a person's. The window is short on purpose: a person who writes the SAME value for an agent seconds after it was created cannot be told from the seed.
Downgrade does nothing: with the code before 5030 (`agent_group_default_mentions` off) «no row» means `all` — the same as the removed seed — so no row has to be invented back.

Revision ID: 0501
Revises: 0500
Create Date: 2026-11-26
"""
import sqlalchemy as sa

from alembic import op

revision = "0501"
down_revision = "0500"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(sa.text(
        """
        DELETE FROM notification_preferences p
        USING members m
        WHERE m.id = p.member_id
          AND m.type = 'agent'
          AND p.scope_type = 'global'
          AND p.scope_id IS NULL
          AND p.event_key IS NULL
          AND p.channel = 'sse'
          AND p.level = 'all'
          AND p.updated_at = p.created_at
          AND abs(extract(epoch FROM (p.created_at - m.created_at))) < 5
        """
    ))


def downgrade() -> None:
    # Nothing to put back: the code before 5030 reads «no row» as `all` (see the docstring).
    pass
