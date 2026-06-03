"""standup_entries.author_id / standup_feedback.feedback_by_id team_members FK 완화.

resolve_member가 grant-only/정식 휴먼 모두 org_member.id(canonical member.id 방향)를
반환하므로 standup author/feedback의 team_members FK 제약을 제거. (6a1e8b1d B3)

FK drop: 컬럼·인덱스 유지, 데이터 무변경. 0069(conv/events)·0073(notif) 동일 패턴.
공유 dev/prod DB — inspector 기반 idempotent(존재할 때만 drop) + 가역(비-team_member
id 없을 때만 재추가). author_id는 PUT self-save가 실제 OM id 기록(active), feedback_by_id는
동일 latent 패턴 선제 완화.

Revision ID: 0074
Revises: 0073
Create Date: 2026-06-03
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0074"
down_revision = "0073"
branch_labels = None
depends_on = None

# (table, column, downgrade ondelete)
_FK_TARGETS: list[tuple[str, str, str]] = [
    ("standup_entries", "author_id", "CASCADE"),
    ("standup_feedback", "feedback_by_id", "CASCADE"),
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

    for table, col, _ in _FK_TARGETS:
        if table not in tables:
            continue
        for fk in _fks_referencing_team_members(insp, table):
            if col in fk.get("constrained_columns", []):
                fk_name = fk.get("name")
                if fk_name:
                    op.drop_constraint(fk_name, table, type_="foreignkey")


def downgrade() -> None:
    """비-team_member id(grant-only org_member.id)가 없는 컬럼에만 FK 재추가."""
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = set(insp.get_table_names())

    for table, col, ondelete in _FK_TARGETS:
        if table not in tables:
            continue
        existing = {fk["name"] for fk in _fks_referencing_team_members(insp, table)}
        fk_name = f"{table}_{col}_fkey"
        if fk_name in existing:
            continue

        non_tm = conn.execute(
            sa.text(
                f"SELECT 1 FROM {table} t"
                f" WHERE t.{col} IS NOT NULL"
                f"   AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = t.{col})"
                f" LIMIT 1"
            )
        ).scalar_one_or_none()
        if non_tm is not None:
            continue  # 데이터 오염 — 재추가 생략

        op.create_foreign_key(
            fk_name, table, "team_members", [col], ["id"], ondelete=ondelete
        )
