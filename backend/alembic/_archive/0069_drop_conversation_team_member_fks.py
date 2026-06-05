"""conversation*/events 테이블의 team_members FK 완화 (Phase 0 grant-only 휴먼 지원).

FK drop: 컬럼·인덱스 유지, 데이터 무변경. 가역: 비-team_member id 없을 때만 재추가.

Revision ID: 0069
Revises: 0068
Create Date: 2026-06-01
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0069"
down_revision = "0068"
branch_labels = None
depends_on = None

# (table, column, referencing team_members)
_FK_TARGETS: list[tuple[str, str]] = [
    ("conversations", "created_by"),
    ("conversations", "resolved_by"),
    ("conversation_participants", "member_id"),
    ("conversation_messages", "sender_id"),
    ("events", "sender_id"),
    ("events", "recipient_id"),
]


def _fks_referencing_team_members(insp: sa.Inspector, table: str) -> list[dict]:
    return [
        fk for fk in insp.get_foreign_keys(table)
        if fk.get("referred_table") == "team_members"
    ]


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = set(insp.get_table_names())

    for table, col in _FK_TARGETS:
        if table not in tables:
            continue
        for fk in _fks_referencing_team_members(insp, table):
            if col in fk.get("constrained_columns", []):
                fk_name = fk.get("name")
                if fk_name:
                    op.drop_constraint(fk_name, table, type_="foreignkey")


def downgrade() -> None:
    """비-team_member id가 없는 컬럼에만 FK 재추가 (데이터 안전 확인 후)."""
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = set(insp.get_table_names())

    specs = [
        ("conversations", "created_by", "SET NULL"),
        ("conversations", "resolved_by", "SET NULL"),
        ("conversation_participants", "member_id", "CASCADE"),
        ("conversation_messages", "sender_id", "SET NULL"),
        ("events", "sender_id", "SET NULL"),
        ("events", "recipient_id", "CASCADE"),
    ]

    for table, col, ondelete in specs:
        if table not in tables:
            continue
        existing = {fk["name"] for fk in _fks_referencing_team_members(insp, table)}
        fk_name = f"{table}_{col}_fkey"
        if fk_name in existing:
            continue

        # 비-team_member id가 있으면 FK 재추가 중단
        non_tm = conn.execute(
            sa.text(
                f"SELECT 1 FROM {table} t"
                f" WHERE t.{col} IS NOT NULL"
                f"   AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = t.{col})"
                f" LIMIT 1"
            )
        ).scalar_one_or_none()
        if non_tm is not None:
            continue  # 데이터 오염 — 이 컬럼은 재추가 생략

        op.create_foreign_key(
            fk_name, table, "team_members", [col], ["id"], ondelete=ondelete
        )
