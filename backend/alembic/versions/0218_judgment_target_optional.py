"""story #2268 후속(2026-07-30, 오르테가 철회 — target_id 순환 실측) — judgments.target_id를
retraction/refinement/method_error에서도 선택으로 내리고, source_message_id를 신설한다.

배경: target_id가 "이전 판정의 id"인데 처음 쓰는 사람은 이전 판정이 없어 가리킬 것이
없었다("처음 쓰는 사람은 영원히 못 들어가는 순환") — org 전체 정정 기록이 오늘까지 1건뿐이던
원인으로 추정. correction_ids_by_target(judgment_core.py)은 이미 `if corr.target_id is not
None` 가드라 target 없는 행은 그 map에서 조용히 빠질 뿐, 깨지는 소비자 없음.

순수 additive/완화 — CHECK 제약 하나 제거 + nullable 컬럼 하나 추가, 기존 데이터 손상 0.

Revision ID: 0218
Revises: 0217
Create Date: 2026-07-30
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0218"
down_revision = "0217"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_judgments_target_required_for_meta_kinds", "judgments", type_="check",
    )
    op.add_column(
        "judgments",
        sa.Column("source_message_id", postgresql.UUID(as_uuid=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("judgments", "source_message_id")
    op.create_check_constraint(
        "ck_judgments_target_required_for_meta_kinds",
        "judgments",
        "(kind NOT IN ('retraction', 'refinement', 'method_error')) OR (target_id IS NOT NULL)",
    )
