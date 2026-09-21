"""story #4083(E-RECIPE-1, PO 확定 2026-09-21) — 레시피 게이트 기본 지정 승인자 org 정책.

레시피 stage 게이트(recipe_gate_hooks.py::_resolve_org_owner)가 항상 org owner로만
designated_approver_id를 채워, org owner≠마케팅 담당인 org(실사고: 뭉클랩 org owner=
선생님·운영 담당 sellerking=admin)에서 사람 게이트 4개가 전부 owner 결재함으로 가고
admin은 #3319 rule B로 403이었다. org_gate_policy에 recipe_gate_default_approver_
member_id(nullable UUID)를 추가 — merge_gate_default_approver_member_id(0302)와 동일
패턴: 값이 있으면 신규 생성되는 레시피 게이트의 designated_approver_id로 채워져 그 멤버
1인에게 승인이 좁혀진다. 미설정(None, 기본값)은 현행(org owner) 무변경(회귀 0). 데이터
마이그 없음.

⚠️ 리비전 순서 메모(PO 우선순위 지시, 2026-09-21) — story #4081(인덱스 카드, PR #4458)이
같은 develop HEAD(0383)에서 갈라져 나가 로컬에 0384(자기 것)를 먼저 만들어 뒀으나, 아직
develop에 착지 前이라 그 번호는 실 develop 체인엔 없다. PO가 이 카드(#4083)를 리허설
차단 사유로 먼저 착지시키라 지시해 이 파일이 실 develop head(0383)를 그대로 이어 0384를
가져간다 — #4081이 재개되면 그쪽이 develop 위로 rebase하며 0385로 renumber할 몫(#4197/
#4198류 선례와 동형, 발명 대신 재사용).

Revision ID: 0384
Revises: 0383
Create Date: 2026-09-21
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0384"
down_revision = "0383"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "org_gate_policy",
        sa.Column("recipe_gate_default_approver_member_id", postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("org_gate_policy", "recipe_gate_default_approver_member_id")
