"""story #3603(Phase2·BE·소형·결함, 페드루 PO 確定 2026-09-07, 유나 3597 관찰) —
`channel_connections`에 `last_error_code`·`last_error_at` additive. `_promote_
connection_status`(댓글)·`_promote_connection_status_for_snapshot`(인사이트)가
CONNECTION 실패로 expired 승격할 때 이 둘을 채워야 /organization/channels 행의
「서버 응답 보기」가 «왜 만료됐나»를 보일 수 있다 — 기존 `last_error`는 원문
그대로 두는 관례(2026-09-03 07:09Z PO 확定)를 안 건드린다.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0347"
down_revision = "0346"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("channel_connections", sa.Column("last_error_code", sa.Text(), nullable=True))
    op.add_column(
        "channel_connections",
        sa.Column("last_error_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("channel_connections", "last_error_at")
    op.drop_column("channel_connections", "last_error_code")
