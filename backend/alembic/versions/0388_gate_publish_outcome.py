"""story #4090([E-RECIPE-1] Publisher 슬롯) AC2 — 레시피 자동발행 훅이 "왜 발행 안 됐는지
/됐는지"를 사람이 보는 자리에 남길 **기계 소유 필드** 하나(페드루 PO 確定 2026-09-21,
resolution_note 정정 라운드). `gate.resolution_note`는 승인자 본인 문장 전용(기계 문장을
섞지 않는다 — 사람 글과 시스템 상태를 한 칸에 두면 어느 게 승인자 의도였는지 구분이 샌다)
이라 여기 못 쓴다. `neutral_facts`도 게이트 생성(seal) 시점 스냅샷이라 승인 *후* 벌어지는
발행 결과를 담을 자리가 아니다(둘 다 기존 계약 무변경, 새 컬럼 신설이 최소 침습).

값은 닫힌 어휘가 아니라 자유 텍스트(evidence_status·auto_decision_reason과 동형 관례 —
이 도메인은 "정확한 사유 문자열"이 계속 늘어나는 편이라 CHECK로 미리 잠그지 않는다).
external_publish 게이트(scope_key="")에서만 채워진다 — 그 외 gate_type/scope는 항상 NULL.

레시피와 무관한 다른 external_publish 게이트(scope_key=connection_id)의 승인/거부는
이 필드를 절대 건드리지 않는다(이 스토리의 자동발행 훅은 scope_key=="" 게이트에서만
동작 — gate_service.py::publish_recipe_approved_draft 가드 참고, 회귀 0).

Revision ID: 0388
Revises: 0387
Create Date: 2026-09-21
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0388"
down_revision = "0387"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("gate", sa.Column("publish_outcome", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("gate", "publish_outcome")
