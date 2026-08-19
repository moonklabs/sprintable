"""story #2815(§5-④, Gate→GitHub required check 관측모드 판별) —
`github_installation.enforced_check_repos` 신설.

배경: story #2813로 `sprintable/gate` check 발행 자체는 만들어졌지만, `gate.github_check_run_id`
가 계속 null인 이유(①check가 아직 발행 안 됨 vs ②이 저장소가 애초에 branch protection에
required로 등록 안 된 "관측모드"라 영원히 null)를 FE가 구분할 방법이 없었다(미르코군 그라운딩
doc gate-github-check-fe-grounding-2814 §5-④ 적출).

설계 판단(디디군, 2026-08-20) — GitHub branch-protection API 실측 조회 대신 **수동 플래그**:
실측 조회는 `administration:read`라는 story #2813 §2-4의 `checks:write`와 별개 신규 권한이
필요해 승인 마찰을 배로 늘린다. PO가 이미 "check 실발행 시작 後에만 branch protection을 건다"는
순서를 직접 통제하므로(story #2813 R4) 그 등록 시점을 PO 자신이 정확히 아는 유일한 주체다 —
라이브 API 실측 전환은 후속(stale 위험 트레이드오프는 문서화).

Revision ID: 0263
Revises: 0262
Create Date: 2026-08-20
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0263"
down_revision = "0262"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "github_installation",
        sa.Column("enforced_check_repos", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("github_installation", "enforced_check_repos")
