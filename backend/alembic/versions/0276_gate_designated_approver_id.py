"""story #2985(PO 설계 확定 2026-08-24) — 결재선(수신자) 개념 신설.

Gate에 「누가 해야 하는지」(사전 지정)를 담을 컬럼이 없었다 — resolver_id는 해소 後
누가 했는지(사후)뿐. 상신 시 approver를 명시 지정하면 그 1인에게만 액션 카드,
나머지 org/project owner+admin은 정보성 카드로 강등(대신 처리 폴드는 유지)한다.
미지정이면 현행(권한자 전원 액션 브로드캐스트) 그대로 — 회귀 0.

nullable — 3 호출부(doc.py/gates.py::create_decision_request/merge_verdict_gate.py) 전부
당장은 optional 파라미터로 얹는다(강제 아님).

Revision ID: 0276
Revises: 0275
Create Date: 2026-08-24
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0276"
down_revision = "0275"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "gate",
        sa.Column("designated_approver_id", postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("gate", "designated_approver_id")
