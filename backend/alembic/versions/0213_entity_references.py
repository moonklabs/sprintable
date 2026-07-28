"""story #2259(C-1, E-CONNECT) — entity_references: 참조를 1급 개념으로.

순수 additive — 신규 테이블 생성뿐, 기존 테이블/데이터 손상 0(prod 적용 전제, 되돌릴 수
없는 데이터손실형 아님). 옛 `mentions` 테이블은 이 마이그레이션에서 건드리지 않는다 —
백필은 별도 애플리케이션 코드로, 스키마와 데이터 이관을 한 트랜잭션에 묶지 않는다.

Revision ID: 0213
Revises: 0212
Create Date: 2026-07-28
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0213"
down_revision = "0212"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "entity_references",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_type", sa.Text(), nullable=False),
        # PO 정정(2026-07-28): NOT NULL — 자리가 없는 게 아니라 "본문"이 그 자리다(단일-필드
        # source_type도 "body"를 실제로 적는다). NULL이면 유니크 인덱스에서 NULL<>NULL이라
        # 중복이 안 잡히는 함정(오늘 세션 두 번째 재발) — NOT NULL로 근본에서 막는다.
        sa.Column("source_field", sa.Text(), nullable=False),
        sa.Column("source_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("target_type", sa.Text(), nullable=False),
        sa.Column("target_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("form", sa.Text(), nullable=False),
        sa.Column("proof_payload", postgresql.JSONB(), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("form IN ('mention', 'embed', 'proof')", name="ck_entity_references_form"),
    )
    op.create_index(
        "ix_entity_references_source", "entity_references", ["org_id", "source_type", "source_id"],
    )
    op.create_index(
        "ix_entity_references_target", "entity_references", ["org_id", "target_type", "target_id"],
    )
    # 부분 유니크(PO 판정 2026-07-28): proof 는 뺀다(같은 자리·같은 대상을 다른 범위로 여러 번
    # 인용하는 게 정상 쓰임 — proof_payload 가 정해지기 전까진 그 축으로 유일성을 못 세운다,
    # #2265 몫). source_field가 NOT NULL이라 COALESCE 없이도 그대로 유니크가 성립한다.
    op.execute(
        """
        CREATE UNIQUE INDEX uq_entity_references_non_proof
        ON entity_references (source_type, source_field, source_id, target_type, target_id, form)
        WHERE form <> 'proof'
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_entity_references_non_proof")
    op.drop_index("ix_entity_references_target", table_name="entity_references")
    op.drop_index("ix_entity_references_source", table_name="entity_references")
    op.drop_table("entity_references")
