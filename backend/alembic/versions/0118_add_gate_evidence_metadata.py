"""H1-S3: gate evidence metadata 컬럼 (additive).

Revision ID: 0118
Revises: 0117
Create Date: 2026-06-12

블루프린트 E-H1-VERDICT-GATE S3. merge verdict gate가 결정 근거/증거상태/사람필요 여부를 게이트
행에 남기도록 `gate`에 4컬럼 추가. additive — 기존 스키마/행 무손상.

- requires_human  bool NOT NULL default false — 기존 행은 false backfill(server_default·AC②).
- evidence_status text NULL — 증거 상태(예: present|absent|self_report_only).
- decision_basis  text NULL — 결정 근거(정책+증거 합성 사유).
- auto_decision_reason text NULL — 자동 결정 사유(auto_merge/ask/block 설명).

idempotent: 컬럼 단위 inspect 가드(0117 선례). AC⑤: 마이그 외 수동 SQL 없음.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0118"
down_revision = "0117"
branch_labels = None
depends_on = None

_TABLE = "gate"
_COLUMNS = ("requires_human", "evidence_status", "decision_basis", "auto_decision_reason")


def _existing_columns(conn) -> set[str]:
    insp = sa.inspect(conn)
    if _TABLE not in insp.get_table_names():
        return set()
    return {c["name"] for c in insp.get_columns(_TABLE)}


def upgrade() -> None:
    existing = _existing_columns(op.get_bind())

    if "requires_human" not in existing:
        # NOT NULL + server_default false → 기존 행 자동 backfill(AC②).
        op.add_column(
            _TABLE,
            sa.Column("requires_human", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        )
    if "evidence_status" not in existing:
        op.add_column(_TABLE, sa.Column("evidence_status", sa.Text(), nullable=True))
    if "decision_basis" not in existing:
        op.add_column(_TABLE, sa.Column("decision_basis", sa.Text(), nullable=True))
    if "auto_decision_reason" not in existing:
        op.add_column(_TABLE, sa.Column("auto_decision_reason", sa.Text(), nullable=True))


def downgrade() -> None:
    existing = _existing_columns(op.get_bind())
    # 추가 역순으로 drop(존재 시에만).
    for col in reversed(_COLUMNS):
        if col in existing:
            op.drop_column(_TABLE, col)
