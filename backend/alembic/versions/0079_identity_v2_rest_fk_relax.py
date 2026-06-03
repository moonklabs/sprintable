"""E-MEMBER-SSOT AC3-2 Batch 3: 잔여 식별 컬럼 team_members FK 완화 + v2.

blueprint §4 Phase4 마무리. participation/webhook_configs/reward_ledger/docs/doc_comments/
doc_revisions/notification_preferences의 legacy team_member.id 식별 컬럼을 canonical members.id로
이행. Batch2(assignee_id)와 동형 — team_members FK가 grant-only 휴먼(org_member.id) write 시
실DB FK violation 500을 유발하는 동일 버그 클래스 → FK DROP + *_v2 + alias 백필.

대상 (table, column):
- participation.member_id            (CASCADE, NOT NULL) — 스토리 참가
- notification_preferences.member_id (FK는 0073서 이미 DROP — v2만)
- webhook_configs.member_id          (CASCADE, NOT NULL) — 생성자
- reward_ledger.member_id            (CASCADE, NOT NULL) — 수령자
- reward_ledger.granted_by           (SET NULL, NULL)    — 지급자
- docs.created_by / docs.assignee_id (SET NULL, NULL)
- doc_comments.created_by            (CASCADE, NOT NULL)
- doc_revisions.created_by           (SET NULL, NULL)

백필 = COALESCE(alias.member_id, legacy): 레거시 휴먼 tm→canonical, agent/org-member 보존(orphan-safe 트랩#4).
⚠️ *_v2 FK 보류(트랩#7): write 경로가 _v2 미사용 → 신규행 _v2 NULL → FK 신규검증 회피. 추가형·가역.

Revision ID: 0079
Revises: 0078
Create Date: 2026-06-04
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0079"
down_revision = "0078"
branch_labels = None
depends_on = None

# (table, column, downgrade 재추가용 ondelete | None=재추가 안 함[0073 소유])
_TARGETS: list[tuple[str, str, str | None]] = [
    ("participation", "member_id", "CASCADE"),
    ("notification_preferences", "member_id", None),  # FK는 0073가 소유 — 0079 downgrade서 재추가 안 함
    ("webhook_configs", "member_id", "CASCADE"),
    ("reward_ledger", "member_id", "CASCADE"),
    ("reward_ledger", "granted_by", "SET NULL"),
    ("docs", "created_by", "SET NULL"),
    ("docs", "assignee_id", "SET NULL"),
    ("doc_comments", "created_by", "CASCADE"),
    ("doc_revisions", "created_by", "SET NULL"),
]
# 필터/조회 hot 컬럼에 v2 인덱스(member_id_v2)
_V2_MEMBER_INDEX = ["participation", "notification_preferences", "webhook_configs", "reward_ledger"]


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
        _drop_tm_fk(insp, table, col)
        op.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col}_v2 uuid")
        op.execute(
            f"""
            UPDATE {table} SET {col}_v2 = COALESCE(
                (SELECT a.member_id FROM member_identity_aliases a WHERE a.alias_id = {table}.{col}),
                {table}.{col}
            )
            WHERE {col} IS NOT NULL AND {col}_v2 IS NULL
            """
        )

    for table in _V2_MEMBER_INDEX:
        if table in tables:
            op.execute(
                f"CREATE INDEX IF NOT EXISTS ix_{table}_member_id_v2 ON {table} (member_id_v2)"
            )


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = set(insp.get_table_names())

    for table in _V2_MEMBER_INDEX:
        op.execute(f"DROP INDEX IF EXISTS ix_{table}_member_id_v2")

    for table, col, ondelete in _TARGETS:
        if table not in tables:
            continue
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS {col}_v2")
        if ondelete is None:
            continue
        # 비-team_member 값이 없을 때만 FK 재추가(데이터 안전)
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
