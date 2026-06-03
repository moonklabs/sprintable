"""notification_preferences.member_id team_members FK 완화 (AC2-2 grant-only 휴먼).

FK drop: 컬럼·인덱스 유지, 데이터 무변경. 0069(conv/events) 동일 패턴.
공유 dev/prod DB — idempotent 가드(존재할 때만 drop). 가역: 비-team_member id가
없을 때만 재추가(데이터 안전).

Revision ID: 0073
Revises: 0072
Create Date: 2026-06-03
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0073"
down_revision = "0072"
branch_labels = None
depends_on = None

_TABLE = "notification_preferences"
_COL = "member_id"


def _fks_referencing_team_members(insp: sa.Inspector, table: str) -> list[dict]:
    return [
        fk for fk in insp.get_foreign_keys(table)
        if fk.get("referred_table") == "team_members"
    ]


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if _TABLE not in set(insp.get_table_names()):
        return
    # idempotent: member_id를 참조하는 team_members FK가 있을 때만 drop
    for fk in _fks_referencing_team_members(insp, _TABLE):
        if _COL in fk.get("constrained_columns", []):
            fk_name = fk.get("name")
            if fk_name:
                op.drop_constraint(fk_name, _TABLE, type_="foreignkey")


def downgrade() -> None:
    """비-team_member id(grant-only org_member.id)가 없을 때만 FK 재추가."""
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if _TABLE not in set(insp.get_table_names()):
        return

    existing = {fk["name"] for fk in _fks_referencing_team_members(insp, _TABLE)}
    fk_name = f"{_TABLE}_{_COL}_fkey"
    if fk_name in existing:
        return

    # 데이터 오염(비-team_member id) 있으면 재추가 생략
    non_tm = conn.execute(
        sa.text(
            f"SELECT 1 FROM {_TABLE} t"
            f" WHERE t.{_COL} IS NOT NULL"
            f"   AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = t.{_COL})"
            f" LIMIT 1"
        )
    ).scalar_one_or_none()
    if non_tm is not None:
        return

    op.create_foreign_key(
        fk_name, _TABLE, "team_members", [_COL], ["id"], ondelete="CASCADE"
    )
