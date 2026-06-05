"""E-MEMBER-SSOT AC3-2 Batch 2: stories/tasks/epics assignee_id team_members FK 완화 + v2.

blueprint §4 Phase4. assignee_id가 team_members FK라 grant-only 휴먼(org_member.id) 할당 시
FK 위반 500(AC6 라이브 근거 1154dd9e). FK DROP으로 해소 + assignee_id_v2(canonical) + alias 백필.

- assignee_id team_members FK(ondelete SET NULL) DROP — 0069/0073/0074 inspector 패턴(컬럼·데이터 유지).
- assignee_id_v2 + 백필=COALESCE(alias.member_id, legacy)(orphan-safe 트랩#4): 레거시 휴먼 tm→canonical,
  agent/org-member 보존.
- ⚠️ assignee_id_v2 FK 보류(트랩#7): write 경로(할당 API)가 _v2 미사용 → 신규행 _v2 NULL → FK 신규검증 회피.
  read-cut 후 cutover서 추가. 추가형·가역.

Revision ID: 0078
Revises: 0077
Create Date: 2026-06-03
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0078"
down_revision = "0077"
branch_labels = None
depends_on = None

_TARGETS = ["epics", "stories", "tasks"]
_COL = "assignee_id"


def _fks_to_team_members(insp: sa.Inspector, table: str) -> list[dict]:
    return [fk for fk in insp.get_foreign_keys(table) if fk.get("referred_table") == "team_members"]


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = set(insp.get_table_names())

    for table in _TARGETS:
        if table not in tables:
            continue
        # 1. assignee_id team_members FK DROP (grant-only 할당 500 해소)
        for fk in _fks_to_team_members(insp, table):
            if _COL in fk.get("constrained_columns", []):
                fk_name = fk.get("name")
                if fk_name:
                    op.drop_constraint(fk_name, table, type_="foreignkey")
        # 2. assignee_id_v2 + alias 백필(orphan-safe)
        op.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {_COL}_v2 uuid")
        op.execute(
            f"""
            UPDATE {table} SET {_COL}_v2 = COALESCE(
                (SELECT a.member_id FROM member_identity_aliases a WHERE a.alias_id = {table}.{_COL}),
                {table}.{_COL}
            )
            WHERE {_COL} IS NOT NULL AND {_COL}_v2 IS NULL
            """
        )
        op.execute(f"CREATE INDEX IF NOT EXISTS ix_{table}_assignee_id_v2 ON {table} ({_COL}_v2)")


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = set(insp.get_table_names())

    for table in _TARGETS:
        if table not in tables:
            continue
        op.execute(f"DROP INDEX IF EXISTS ix_{table}_assignee_id_v2")
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS {_COL}_v2")
        # 비-team_member assignee_id가 없을 때만 FK 재추가(데이터 안전)
        existing = {fk["name"] for fk in _fks_to_team_members(insp, table)}
        fk_name = f"{table}_{_COL}_fkey"
        if fk_name in existing:
            continue
        non_tm = conn.execute(
            sa.text(
                f"SELECT 1 FROM {table} t WHERE t.{_COL} IS NOT NULL"
                f" AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = t.{_COL}) LIMIT 1"
            )
        ).scalar_one_or_none()
        if non_tm is not None:
            continue
        op.create_foreign_key(fk_name, table, "team_members", [_COL], ["id"], ondelete="SET NULL")
