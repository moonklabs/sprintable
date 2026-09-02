"""story #3319(2026-09-02, 선생님 처방 확定) — 머지 게이트 기본 지정 승인자 org 정책.

머지 게이트가 designated_approver_id=None으로 생성돼 rule B(gates.py::
_non_doc_gate_approvable)가 project owner/admin 전원(org owner 포함)에게 «승인 가능»으로
노출했다(실사고: PR#3706 머지 게이트를 QA 前에 선생님이 서명). org_gate_policy에
merge_gate_default_approver_member_id(nullable UUID)를 추가 — 값이 있으면 신규 생성되는
머지 게이트의 designated_approver_id로 채워져 그 멤버 1인에게만 승인 자격이 좁혀진다.
미설정(None, 기본값)은 현행 무변경(회귀 0). 0276(gate.designated_approver_id 신설)과 동형
패턴 — 데이터 마이그 없음.

Revision ID: 0302
Revises: 0301
Create Date: 2026-09-02
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0302"
down_revision = "0301"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "org_gate_policy",
        sa.Column("merge_gate_default_approver_member_id", postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("org_gate_policy", "merge_gate_default_approver_member_id")
