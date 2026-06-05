"""E-MEMBER-SSOT AC3-2d 배치2(🟡): webhook/reward/docs/notif_prefs 식별 컬럼 canonical 정규화.

(A) resolver-cutover 통일. 🟡 그룹(0079서 FK 기완화) + notification_preferences.member_id(0073서 FK 기완화,
0085 _TARGETS 누락분)의 기존 legacy 휴먼 team_member.id를 canonical members.id로 정규화. FK DROP 없음
(이미 완화) — alias 기반 canonicalize UPDATE만(0085 §2 동형).

⚠️ write canonical(코드)과 **동반 필수**(특히 notif_prefs): 데이터만 canonicalize하고 write/read가 tm.id-first면
기존 휴먼 prefs가 매칭 실패로 유실(split-brain). 같은 PR에서 write도 canonical 전환.

대상 (table, column):
- webhook_configs.member_id
- reward_ledger.member_id / reward_ledger.granted_by
- docs.created_by / docs.assignee_id
- doc_comments.created_by / doc_revisions.created_by
- notification_preferences.member_id

정규화 = alias.member_id (레거시 휴먼 tm.id → canonical). orphan-safe(트랩#4: alias 없으면 불변 →
agent id·canonical은 alias 없어 불변). 잔존 휴먼 tm.id-키 행 없는 컬럼은 0행 UPDATE(무해). 추가형·가역(no-op down).

Revision ID: 0086
Revises: 0085
Create Date: 2026-06-04
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0086"
down_revision = "0085"
branch_labels = None
depends_on = None

_TARGETS: list[tuple[str, str]] = [
    ("webhook_configs", "member_id"),
    ("reward_ledger", "member_id"),
    ("reward_ledger", "granted_by"),
    ("docs", "created_by"),
    ("docs", "assignee_id"),
    ("doc_comments", "created_by"),
    ("doc_revisions", "created_by"),
    ("notification_preferences", "member_id"),
]


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = set(insp.get_table_names())
    for table, col in _TARGETS:
        if table not in tables:
            continue
        # 레거시 휴먼 team_member.id → canonical(alias). orphan-safe(alias 없으면 불변).
        op.execute(
            f"""
            UPDATE {table} SET {col} = a.member_id
            FROM member_identity_aliases a
            WHERE a.alias_id = {table}.{col} AND {table}.{col} <> a.member_id
            """
        )


def downgrade() -> None:
    # 일방향 canonical 정규화 — 역변환 불가·불요(0075/0085 정책). no-op.
    pass
