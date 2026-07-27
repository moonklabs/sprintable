"""story bea25062(§17d-1 RED 포워딩 BLOCKER 2·산티아고 2026-07-16): auth_native_bootstrap_codes에
원본 Firebase ID token `auth_time` 보존 컬럼 추가.

⚠️`created_at`(코드 발급 시각)과 `auth_time`(그 코드를 발급받기 위해 제시된 ID token이 실제로
Firebase에 인증된 시각)은 다른 값이다 — revoke 이후 예전(pre-cutover) ID token으로 새 코드를
발급받으면 `created_at`은 revoke보다 늦지만 `auth_time`은 여전히 revoke 이전이라 cutover
우회가 가능했다(BLOCKER 2). 이 컬럼이 issue/consume 양쪽에서 cutover 재검증의 기준이 된다.

additive — nullable(기존 행 없음, 아직 활성화 전 default-off 상태).

Revision ID: 0192
Revises: 0191
Create Date: 2026-07-16

⚠️renumber(2026-07-16, PO 채번 조율 실패 정정): #2213(C1) develop 0190 선점으로 밀림 —
로직 무변, 파일번호+down_revision만.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0192"
down_revision = "0191"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "auth_native_bootstrap_codes",
        sa.Column("auth_time", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("auth_native_bootstrap_codes", "auth_time")
