"""story #3953(마케팅·안전장치·블루프린트 §1-5, 페드루 PO 確定 2026-09-16) — 조직
전체 「외부 발행 일시 중지」 스위치. AC1 그라운딩(디디, 같은 날) — `organizations`엔
이런 운영 플래그를 실을 컬럼이 0(모델 자체가 id/name/slug/plan/timezone뿐)이고,
후보였던 `org_content_rules.rules`(JSONB)는 모델 자체 docstring이 "콘텐츠 린트
전용 자루"라 의미상 안 맞는다(그라운딩 결론, PO 確認).

`agent_session.py`·`github_installation.py` 둘 다 이미 쓰는 `suspended_at:
datetime|None` 관례(존재=불리언+"언제부터"를 컬럼 하나로 겸함)를 그대로 미러 —
`paused_at`(nullable, 존재=중지 中) + `paused_by`(nullable, FK 無 —
publication_command.py::requested_by_member_id와 동형 관례. team_members는 실
테이블이 아니라 뷰라 FK 대상이 될 수 없다 — 마이그 최초 시도 실측
`WrongObjectType: referenced relation "team_members" is not a table`) +
`pause_reason`(nullable text, owner가 적는 사유).

Revision ID: 0393
Revises: 0392
Create Date: 2026-09-16 (rebase 시점 개명 2026-09-22, 미르코 — 페드루 PO 지시:
parking/axis-b 착지순 사다리 재배정, 4364(0392) 바로 위)
"""
from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0393"
down_revision = "0392"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("organizations", sa.Column("external_publish_paused_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "organizations",
        sa.Column("external_publish_paused_by", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column("organizations", sa.Column("external_publish_pause_reason", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("organizations", "external_publish_pause_reason")
    op.drop_column("organizations", "external_publish_paused_by")
    op.drop_column("organizations", "external_publish_paused_at")
