"""story #3365(Phase0 S2·마케팅 운영 블루프린트 v3, 선생님 확定 2026-09-03) — gate에
external_publish 전용 sealing 컬럼 4종 신설. github_check_run_sha/approved_head_sha(merge
gate)와 동형 축 — "이 승인이 귀속된 대상"을 상신 시점에 한 번 기록하고 이후 비교만 한다.
전부 nullable/기본값 안전 — 기존 gate_type은 전혀 안 건드린다(additive).

번호 의존성 — story #3365 S1(PR#3731, 머지 c12c03f0e→647b8fe43)이 이미 0308을 썼고, PR#3732
(미르코, S5)가 developing 中 같은 0308 위에서 시작해 이 PR 머지 뒤 0309로 리베이스한다(페드루
PO 확定 2026-09-03). 이 revision은 그 자리를 피해 0310부터 잡는다.

Revision ID: 0310
Revises: 0308
Create Date: 2026-09-03
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0310"
down_revision = "0308"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("gate", sa.Column("sealed_content_version", sa.Integer(), nullable=True))
    op.add_column("gate", sa.Column("sealed_content_sha256", sa.Text(), nullable=True))
    op.add_column("gate", sa.Column("sealed_content_body", sa.Text(), nullable=True))
    op.add_column(
        "gate",
        sa.Column("reapproval_required", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("gate", "reapproval_required")
    op.drop_column("gate", "sealed_content_body")
    op.drop_column("gate", "sealed_content_sha256")
    op.drop_column("gate", "sealed_content_version")
