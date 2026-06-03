"""E-MEMBER-SSOT AC3-3: standup author/feedback 식별자를 canonical members.id로 정규화.

blueprint §6. 기존 standup_entries.author_id·standup_feedback.feedback_by_id는 #1167 transitional로
레거시 휴먼 team_member.id가 섞여 있다. AC3-3 코드가 write/missing/카드를 canonical로 옮기므로,
기존 행도 canonical(org_member.id)로 정규화해야 신/구 데이터가 한 신원으로 정합(멀티프로젝트 휴먼 단일
신원, 48e653e9). 백필 = COALESCE(alias.member_id, legacy) (orphan-safe 트랩#4). FK는 0074서 이미 DROP.

⚠️ preflight 병합: author_id→canonical 매핑이 (org,project,date)에서 충돌하면(레거시 tm.id 행 +
이미 canonical 행) 최신(updated_at) 1행만 남기고 나머지의 feedback을 keeper로 재귀속 후 삭제 —
중복 author_id로 upsert SELECT(scalar_one)가 깨지지 않도록.

Revision ID: 0081
Revises: 0080
Create Date: 2026-06-04
"""
from __future__ import annotations

from alembic import op

revision = "0081"
down_revision = "0080"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. preflight 병합: canonical 충돌 그룹에서 keeper(최신) 외 행의 feedback 재귀속 후 삭제
    op.execute(
        """
        WITH canon AS (
            SELECT se.id, se.org_id, se.project_id, se.date,
                   COALESCE(a.member_id, se.author_id) AS cid, se.updated_at
            FROM standup_entries se
            LEFT JOIN member_identity_aliases a ON a.alias_id = se.author_id
        ),
        ranked AS (
            SELECT id,
                   row_number() OVER (PARTITION BY org_id, project_id, date, cid
                                      ORDER BY updated_at DESC, id DESC) AS rn,
                   first_value(id) OVER (PARTITION BY org_id, project_id, date, cid
                                         ORDER BY updated_at DESC, id DESC) AS keeper_id
            FROM canon
        )
        UPDATE standup_feedback sf SET standup_entry_id = r.keeper_id
        FROM ranked r
        WHERE sf.standup_entry_id = r.id AND r.rn > 1
        """
    )
    op.execute(
        """
        WITH canon AS (
            SELECT se.id, se.org_id, se.project_id, se.date,
                   COALESCE(a.member_id, se.author_id) AS cid, se.updated_at
            FROM standup_entries se
            LEFT JOIN member_identity_aliases a ON a.alias_id = se.author_id
        ),
        ranked AS (
            SELECT id,
                   row_number() OVER (PARTITION BY org_id, project_id, date, cid
                                      ORDER BY updated_at DESC, id DESC) AS rn
            FROM canon
        )
        DELETE FROM standup_entries se USING ranked r WHERE se.id = r.id AND r.rn > 1
        """
    )

    # 2. canonical 정규화(레거시 휴먼 team_member.id → alias의 member_id). orphan-safe(alias 없으면 유지).
    op.execute(
        """
        UPDATE standup_entries se SET author_id = a.member_id
        FROM member_identity_aliases a
        WHERE a.alias_id = se.author_id AND se.author_id <> a.member_id
        """
    )
    op.execute(
        """
        UPDATE standup_feedback sf SET feedback_by_id = a.member_id
        FROM member_identity_aliases a
        WHERE a.alias_id = sf.feedback_by_id AND sf.feedback_by_id <> a.member_id
        """
    )


def downgrade() -> None:
    # 일방향 데이터 정규화(canonical) — 역변환 불가(alias는 N 레거시→1 canonical, project별 team_member.id
    # 복원이 모호). canonical id는 유효 식별자로 유지; 코드 롤백(resolve_member→resolve_auth_member)이
    # 가역 부분. no-op(0075 백필과 동일 정책).
    pass
