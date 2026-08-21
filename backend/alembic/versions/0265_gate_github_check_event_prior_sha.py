"""story #2819([Gate 강제·BE], PR#3246 미르코 발견) — gate_github_check_event 원장에
prior_sha 컬럼 신설, 재-pending 사유 완전화.

`reopen_gate_if_new_sha`(gate_github_check.py)가 무효화된 승인이 귀속됐던 SHA를 지역변수
`prior_sha`로만 로깅하고 원장(`re_pending` 행)엔 `head_sha`(새 SHA)만 저장했다 — `gate.
approved_head_sha`로 메꾸려 해도 같은 함수가 재-pending 즉시 그 필드를 null로 리셋해버려
FE 조회 시점엔 이미 사라지고 없었다(FE는 "새 커밋(SHA {new})으로 이전 승인이 무효화됨"까지만
표시, "어느 SHA에서"는 못 보여줌).

`re_pending` 행 전용(published/resolved 행이나 마이그레이션 이전 re_pending 행은 NULL —
소급 불가라 정직하게 표시, FE는 이미 null 폴백 설계·PR#3246).

Revision ID: 0265
Revises: 0264
Create Date: 2026-08-20
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0265"
down_revision = "0264"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("gate_github_check_event", sa.Column("prior_sha", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("gate_github_check_event", "prior_sha")
