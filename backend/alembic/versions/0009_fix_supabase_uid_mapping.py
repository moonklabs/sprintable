"""Fix Supabase UID mapping: replace stale Supabase auth.users UUIDs with Cloud SQL users.id

Revision ID: 0009
Revises: 0008
Create Date: 2026-05-04

MV-S2: Supabase→Cloud SQL 마이그레이션 시 team_members.user_id 및 org_members.user_id에
Supabase auth.users UUID가 그대로 유입됨. 등록된 2명의 매핑 정보를 기반으로 Cloud SQL users.id로
UPDATE.

매핑 출처: backend/scripts/fk_null_survey_result.json (registered_users_mapping)
  - 송윤재: a306ae71-58ad-468b-84c0-667850d28fb1 → aac01791-5a99-4f5c-99c1-29f35c84cc61
  - 윤도선: cccaed24-e082-4b7b-ae82-eae588a64f58 → fb474687-aeef-4f4e-a5e9-c97c0cb427f3
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
