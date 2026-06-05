"""E-MEMBER-SSOT AC3-1: agent_api_keys.member_id 추가 + 백필 (canonical members.id).

0075에서 agent member.id = team_member.id **1:1**이라 member_id = team_member_id 백필이
ID 보존 = API key 인증 신원 불변(무중단 핵심). member_id FK는 신규 INSERT 검증이 신규 agent
생성을 깨므로(QA H1) **생략** — AC3-1b(anchor write-sync) 후 cutover에서 재추가.
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
    # ⚠️ FK는 의도적으로 생략(QA H1): NOT VALID FK도 신규 INSERT는 검증하므로, 신규 agent 생성 시
    # auto API key dual-write(member_id=team_member_id)가 아직 members 행이 없어 FK 위반→agent 생성
    # 500(생명선). dual-write는 유지(forward-compat, 기존 agent는 0075 members 보존)하되 FK는
    # 신규 agent의 members/agent_project_profiles 동기화(AC3-x anchor write-sync) 완료 후 cutover에서 추가.


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_agent_api_keys_member_id")
    op.execute(f"ALTER TABLE {_TABLE} DROP COLUMN IF EXISTS member_id")
