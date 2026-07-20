"""SPR-36 — 무증거 작업 게이팅 org opt-in: `org_gate_policy.require_human_without_evidence`.

도그푸드 실측(2026-07-19): CI/PR 증거가 없는 report-done은 게이트 미실체화 + auto done —
문서·설정 작업이 사람 싸인을 영영 거치지 않고, 에이전트가 증거를 빼면 게이트를 우회할 수
있다. 결정(옵션 1): org 단위 opt-in — 이 플래그가 true인 org만 무증거 작업도 merge 게이트를
실체화해 ask_human으로 보낸다. 기본 false = 현행 no-substance no-gate(빈 shell 게이트 양산
방지, E-DG-REAL 1ff89d23) 완전 보존 — 롤아웃 안전.

Revision ID: 0202
Revises: 0201
Create Date: 2026-07-20
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0202"
down_revision = "0201"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "org_gate_policy",
        sa.Column(
            "require_human_without_evidence",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("org_gate_policy", "require_human_without_evidence")
