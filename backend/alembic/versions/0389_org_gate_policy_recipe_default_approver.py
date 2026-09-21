"""story #4083(E-RECIPE-1, PO 확定 2026-09-21) — 레시피 게이트 기본 지정 승인자 org 정책.

레시피 stage 게이트(recipe_gate_hooks.py::_resolve_org_owner)가 항상 org owner로만
designated_approver_id를 채워, org owner≠마케팅 담당인 org(실사고: 뭉클랩 org owner=
선생님·운영 담당 sellerking=admin)에서 사람 게이트 4개가 전부 owner 결재함으로 가고
admin은 #3319 rule B로 403이었다. org_gate_policy에 recipe_gate_default_approver_
member_id(nullable UUID)를 추가 — merge_gate_default_approver_member_id(0302)와 동일
패턴: 값이 있으면 신규 생성되는 레시피 게이트의 designated_approver_id로 채워져 그 멤버
1인에게 승인이 좁혀진다. 미설정(None, 기본값)은 현행(org owner) 무변경(회귀 0). 데이터
마이그 없음.

⚠️ 리비전 순서 메모(재-넘버링, 2026-09-21 07:33Z) — 최초 0384는 그 시점 develop head
기준이었으나 이 카드가 Phase 3로 보류되는 사이 #4081(0384)·#4086(0385)·#4092(0386 예정)·
디디군 #4090 1/2(0387 예정)·미르코 #4088 2/2(0388)가 먼저 자리를 잡았다. 이 카드는 그
사슬 맨 뒤(0389)로 다시 붙는다 — 착지 순서가 바뀌면 재조율(이 세션 #4081↔#4083/#4086↔
#4092/#4088 0387→0388 선례와 동형 절차).

Revision ID: 0389
Revises: 0388
Create Date: 2026-09-21
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0389"
down_revision = "0388"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "org_gate_policy",
        sa.Column("recipe_gate_default_approver_member_id", postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("org_gate_policy", "recipe_gate_default_approver_member_id")
