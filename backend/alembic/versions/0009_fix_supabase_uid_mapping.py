"""Fix Supabase UID mapping: replace stale Supabase auth.users UUIDs with Cloud SQL users.id

Revision ID: 0009
Revises: 0008
Create Date: 2026-05-04

MV-S2: Supabase→Cloud SQL 마이그레이션 시 team_members.user_id 및 org_members.user_id에
Supabase auth.users UUID가 그대로 유입됨. 등록된 2명의 매핑 정보를 기반으로 Cloud SQL users.id로
UPDATE.

매핑 출처: 등록된 2명(당시 org owner/admin)의 Supabase auth.users UUID → Cloud SQL users.id
매핑 조사 결과. 실 매핑값은 아래 _MAPPINGS(코드)에만 존재한다 — story #3008(공개 레포 위생,
2026-08-24)에서 이 docstring이 UUID를 사람 이름과 나란히 재진술하던 것을 걷어냈다(코드의
UUID 자체는 이미 적용된 마이그레이션 이력이라 변경 불가 — 이름과의 연결고리만 제거).
"""
from __future__ import annotations

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

_MAPPINGS = [
    (
        "a306ae71-58ad-468b-84c0-667850d28fb1",
        "aac01791-5a99-4f5c-99c1-29f35c84cc61",
    ),
    (
        "cccaed24-e082-4b7b-ae82-eae588a64f58",
        "fb474687-aeef-4f4e-a5e9-c97c0cb427f3",
    ),
]


def upgrade() -> None:
    for supabase_uid, cloud_sql_uid in _MAPPINGS:
        op.execute(
            f"UPDATE team_members SET user_id = '{cloud_sql_uid}' "
            f"WHERE user_id = '{supabase_uid}'"
        )
        op.execute(
            f"UPDATE org_members SET user_id = '{cloud_sql_uid}' "
            f"WHERE user_id = '{supabase_uid}'"
        )


def downgrade() -> None:
    for supabase_uid, cloud_sql_uid in _MAPPINGS:
        op.execute(
            f"UPDATE team_members SET user_id = '{supabase_uid}' "
            f"WHERE user_id = '{cloud_sql_uid}'"
        )
        op.execute(
            f"UPDATE org_members SET user_id = '{supabase_uid}' "
            f"WHERE user_id = '{cloud_sql_uid}'"
        )
