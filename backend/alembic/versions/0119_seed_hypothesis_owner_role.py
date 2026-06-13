"""HO-S3: bet owner participation role seed (hypothesis_owner).

Revision ID: 0119
Revises: 0118
Create Date: 2026-06-13

블루프린트 §3.3 Story3. HO-S2의 outcome→verdict 배선이 bet verdict를 기록하려면 각 org에
`ParticipationRole.key='hypothesis_owner'` 역할이 있어야 한다(없으면 ensure_review_participation이
None을 반환해 bet verdict graceful skip). 본 마이그가 모든 org에 그 역할을 보장한다.

- org-custom role 구조 재사용 — enum 하드코딩 0(participation_role은 범용 역할 테이블).
- 멱등: 0063이 만든 uq_participation_role_org_key(org_id,key)로 ON CONFLICT DO NOTHING → 기존
  org 중복 0·이미 가진 org skip. 데이터 seed만(스키마 변경 0).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0119"
down_revision = "0118"
branch_labels = None
depends_on = None

_ROLE_KEY = "hypothesis_owner"
_ROLE_LABEL = "가설 책임자"


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if "participation_role" not in insp.get_table_names() or "organizations" not in insp.get_table_names():
        return  # 테이블 부재(이론상 없음) — no-op.

    # 각 org에 hypothesis_owner 역할 1행 보장. uq(org_id,key)로 멱등(중복 org skip).
    op.execute(
        sa.text(
            "INSERT INTO participation_role (id, org_id, key, label, is_default, created_at) "
            "SELECT gen_random_uuid(), o.id, :key, :label, false, now() FROM organizations o "
            "ON CONFLICT (org_id, key) DO NOTHING"
        ).bindparams(key=_ROLE_KEY, label=_ROLE_LABEL)
    )


def downgrade() -> None:
    op.execute(
        sa.text("DELETE FROM participation_role WHERE key = :key").bindparams(key=_ROLE_KEY)
    )
