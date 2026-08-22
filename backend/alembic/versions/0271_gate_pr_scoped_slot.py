"""story #2893(설계안 gate-auto-creation-design-2893 §2 A1) — gate PR단위 슬롯.

같은 스토리에 열린 PR이 복수면 merge-type gate가 «work_item_id+gate_type» 1슬롯을
공유해 나중 push한 PR의 SHA로 재바인딩됐다(실사고1/2 — story #2893 AC 본문). 멱등 키에
`pr_number`를 편입해 PR마다 독립 gate row를 갖게 한다 — PR A 서명이 PR B의 SHA를
물 수 있는 구조 자체를 없앤다(재-pending 로직으로 사후 보정하는 게 아니라 격리가
설계로 보장됨).

백필: GitHub API 역조회 불요 — `evaluate_merge_gate()`가 매 호출마다
`neutral_facts.pr_number`를 이미 적어 왔다(merge_verdict_gate.py facts dict, story
#2156부터). 기존 merge-type row는 거기서 그대로 끌어온다. pr_number<=0(board-preflight
"no-substance" 경로, PR 컨텍스트 자체가 없던 평가)은 의도적으로 NULL 유지 — 있지도
않은 PR 번호를 지어내지 않는다. merge 이외 gate_type(doc_approval 등)은 애초에 PR
개념이 없어 항상 NULL.

제약 재설계: 기존 `uq_gate_work_item_gate_type UNIQUE(org_id, work_item_id,
work_item_type, gate_type)`을 그대로 두면 PG가 NULL 여러 개를 허용해(NULL≠NULL) PR
미상 gate들의 "스토리당 1행" 보장이 통째로 사라진다 — 부분 유니크 인덱스 2개로
쪼갠다: pr_number IS NULL 구간은 옛 계약 그대로(스토리+gate_type당 1행), pr_number IS
NOT NULL 구간은 새 계약(스토리+gate_type+PR당 1행). 두 구간은 겹치지 않으므로(NULL
XOR NOT NULL) 합쳐서 "같은 일을 두 번 허용"하는 사각은 없다.

Revision ID: 0271
Revises: 0270
Create Date: 2026-08-22
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0271"
down_revision = "0270"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("gate", sa.Column("pr_number", sa.Integer(), nullable=True))

    op.execute(
        """
        UPDATE gate
        SET pr_number = (neutral_facts->>'pr_number')::integer
        WHERE gate_type = 'merge'
          AND neutral_facts ? 'pr_number'
          AND (neutral_facts->>'pr_number') ~ '^[0-9]+$'
          AND (neutral_facts->>'pr_number')::integer > 0
        """
    )

    op.drop_constraint("uq_gate_work_item_gate_type", "gate", type_="unique")
    op.create_index(
        "uq_gate_work_item_gate_type_no_pr",
        "gate",
        ["org_id", "work_item_id", "work_item_type", "gate_type"],
        unique=True,
        postgresql_where=sa.text("pr_number IS NULL"),
    )
    op.create_index(
        "uq_gate_work_item_gate_type_pr",
        "gate",
        ["org_id", "work_item_id", "work_item_type", "gate_type", "pr_number"],
        unique=True,
        postgresql_where=sa.text("pr_number IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_gate_work_item_gate_type_pr", table_name="gate")
    op.drop_index("uq_gate_work_item_gate_type_no_pr", table_name="gate")
    op.create_unique_constraint(
        "uq_gate_work_item_gate_type",
        "gate",
        ["org_id", "work_item_id", "work_item_type", "gate_type"],
    )
    op.drop_column("gate", "pr_number")
