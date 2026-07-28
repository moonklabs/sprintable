"""story #2249(2026-07-28): gate.status_entered_at / evidence_status_entered_at — "이 상태에
들어간 시각" 신설.

근본: `updated_at`(onupdate=func.now())은 이 목적에 못 쓴다 — 실측(로컬 실 Postgres·실 ORM):
merge_verdict_gate.evaluate_merge_gate가 CI/PR 재평가마다 evidence_status를 같은 값으로
재대입해도 onupdate가 발동해, updated_at이 "이 상태가 된 시각"이 아니라 "재평가 횟수"를
재고 있었다. status/evidence_status는 서로 다른 축이라(Gate.status vs Gate.evidence_status)
컬럼도 분리한다.

값 갱신 규율(AC4, PO 지시): 값이 «실제로 바뀔 때만» 갱신 — 같은 값 재대입은 no-op. 그 판정은
`app/models/gate.py`의 `set_gate_status()`/`set_gate_evidence_status()` 헬퍼 한 곳에서만 한다
(모든 쓰기 지점이 그 헬퍼를 경유하도록 gate_service.py·merge_verdict_gate.py·workflow_report.py·
doc.py 전수 배선 — 직접 `gate.status = ...` 대입 잔존 0건 확認).

Revision ID: 0212
Revises: 0211
Create Date: 2026-07-28
"""
from __future__ import annotations

from alembic import op

revision = "0212"
down_revision = "0211"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE gate ADD COLUMN IF NOT EXISTS status_entered_at timestamptz")
    op.execute("ALTER TABLE gate ADD COLUMN IF NOT EXISTS evidence_status_entered_at timestamptz")


def downgrade() -> None:
    op.execute("ALTER TABLE gate DROP COLUMN IF EXISTS evidence_status_entered_at")
    op.execute("ALTER TABLE gate DROP COLUMN IF EXISTS status_entered_at")
