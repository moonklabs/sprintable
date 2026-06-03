"""E-MEMBER-SSOT AC3-1: agent_api_keys.member_id 추가 + 백필 (canonical members.id).

0075에서 agent member.id = team_member.id **1:1**이라 member_id = team_member_id 백필이
ID 보존 = API key 인증 신원 불변(무중단 핵심). NOT VALID FK(기존 행 검증 보류).
additive·가역 — 코드 cut은 config 플래그(member_ssot_apikey_cut, 기본 off) 뒤.

Revision ID: 0076
Revises: 0075
Create Date: 2026-06-03
"""
from __future__ import annotations

from alembic import op

revision = "0076"
down_revision = "0075"
branch_labels = None
depends_on = None

_TABLE = "agent_api_keys"


def upgrade() -> None:
    op.execute(f"ALTER TABLE {_TABLE} ADD COLUMN IF NOT EXISTS member_id uuid")
    # 백필: member_id = team_member_id (1:1 ID 보존)
    op.execute(f"UPDATE {_TABLE} SET member_id = team_member_id WHERE member_id IS NULL")
    op.execute(f"CREATE INDEX IF NOT EXISTS ix_agent_api_keys_member_id ON {_TABLE} (member_id)")
    # NOT VALID FK — 기존 행 검증 보류(members 백필이 agent team_member.id 보존하므로 정합)
    op.execute(
        """
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_agent_api_keys_member') THEN
                ALTER TABLE agent_api_keys
                    ADD CONSTRAINT fk_agent_api_keys_member
                    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE NOT VALID;
            END IF;
        END $$;
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE agent_api_keys DROP CONSTRAINT IF EXISTS fk_agent_api_keys_member")
    op.execute(f"DROP INDEX IF EXISTS ix_agent_api_keys_member_id")
    op.execute(f"ALTER TABLE {_TABLE} DROP COLUMN IF EXISTS member_id")
