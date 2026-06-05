"""E-MEMBER-SSOT AC3-2d 배치1(🔴): 잔여 team_members FK 컬럼 완화 + canonical 정규화.

(A) resolver-cutover 통일. AC3-2c까지 안 닿은 🔴 8테이블 12컬럼의 team_members FK를 완화하고(grant-only
휴먼 write 500 해소) 기존 legacy 휴먼 team_member.id를 canonical members.id로 정규화(alias). write 경로의
canonical화(canonicalize_member_id)는 코드에서, 이 마이그는 **FK 완화 + 기존 데이터 정규화**.

대상 (table, column):
- retro_sessions.created_by / retro_items.author_id / retro_votes.voter_id / retro_actions.assignee_id
- file_locks.member_id / member_gate_override.member_id (hitl) / invitations.invited_by
- meetings.created_by / policy_documents.created_by
- story_comments.created_by / story_activities.created_by (pm.created_by)
- agent_runs.agent_id

- FK 완화: inspector 기반 idempotent DROP(0069/0079 패턴, 컬럼·데이터·인덱스 유지).
- 정규화 백필 = alias.member_id (레거시 휴먼 team_member.id → canonical). orphan-safe(트랩#4: alias 없으면
  legacy 유지 — agent id·org_member.id는 이미 canonical이라 alias 없음→불변). 추가형·가역(FK downgrade는
  비-team_member 값 없을 때만 재추가).

Revision ID: 0085
Revises: 0084
Create Date: 2026-06-04
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0085"
down_revision = "0084"
branch_labels = None
depends_on = None

# (table, column, downgrade 재추가 ondelete)
_TARGETS: list[tuple[str, str, str]] = [
    ("retro_sessions", "created_by", "SET NULL"),
    ("retro_items", "author_id", "SET NULL"),
    ("retro_votes", "voter_id", "CASCADE"),
    ("retro_actions", "assignee_id", "SET NULL"),
    ("file_locks", "member_id", "CASCADE"),
    ("member_gate_override", "member_id", "CASCADE"),
    ("invitations", "invited_by", "CASCADE"),
    ("meetings", "created_by", "SET NULL"),
    ("policy_documents", "created_by", "SET NULL"),
    ("story_comments", "created_by", "CASCADE"),
    ("story_activities", "created_by", "CASCADE"),
    ("agent_runs", "agent_id", "CASCADE"),
]


def _drop_tm_fk(insp: sa.Inspector, table: str, col: str) -> None:
    for fk in insp.get_foreign_keys(table):
        if fk.get("referred_table") == "team_members" and col in fk.get("constrained_columns", []):
            if fk.get("name"):
                op.drop_constraint(fk["name"], table, type_="foreignkey")


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = set(insp.get_table_names())

    for table, col, _ in _TARGETS:
        if table not in tables:
            continue
        # 1. team_members FK 완화
        _drop_tm_fk(insp, table, col)
        # 2. 레거시 휴먼 team_member.id → canonical(alias) 정규화. orphan-safe(alias 없으면 불변).
        op.execute(
            f"""
            UPDATE {table} SET {col} = a.member_id
            FROM member_identity_aliases a
            WHERE a.alias_id = {table}.{col} AND {table}.{col} <> a.member_id
            """
        )


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = set(insp.get_table_names())

    for table, col, ondelete in _TARGETS:
        if table not in tables:
            continue
        already = any(
            fk.get("referred_table") == "team_members" and col in fk.get("constrained_columns", [])
            for fk in insp.get_foreign_keys(table)
        )
        if already:
            continue
        non_tm = conn.execute(
            sa.text(
                f"SELECT 1 FROM {table} t WHERE t.{col} IS NOT NULL"
                f" AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = t.{col}) LIMIT 1"
            )
        ).scalar_one_or_none()
        if non_tm is not None:
            continue
        op.create_foreign_key(f"{table}_{col}_fkey", table, "team_members", [col], ["id"], ondelete=ondelete)
