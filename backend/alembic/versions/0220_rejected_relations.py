"""story #2221 후속(오르테가 판정, 2026-07-30) — rejected_relations 테이블 신설(관계 단위
기각 기록).

배경: `reference_semantic_candidates`는 어제(#2328, 2026-07-29) 이미 라이브였다(status DB
CHECK·declare 승격 경로 둘 다 확認됨). 남은 갭은 사람이 「아니오」를 누른 관계가 다음 산문
임포트에 또 뜨는 것을 막을 자리(=관계 단위 기각 기록)가 없던 것 — 이 마이그레이션이 그것만
채운다. relation_kind에 6번째 종(superseded)을 더하는 것은 PR#2702(디디, 0219)가 이미
한다 — 이 판(0220)은 그 위에 얹혀 rejected_relations 테이블만 신설한다.

순수 additive — 신규 테이블뿐, 기존 테이블/데이터 손상 0.

⛔rejected_by는 NOT NULL이다(오르테가 지시, 2026-07-30) — 여러 사람이 같은 후보 목록을
보므로 「누가 이걸 아니라고 했나」가 없으면 되살릴 때 판단이 안 선다.

Revision ID: 0220
Revises: 0219
Create Date: 2026-07-30
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0220"
down_revision = "0219"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rejected_relations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_type", sa.Text(), nullable=False),
        sa.Column("source_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("target_type", sa.Text(), nullable=False),
        sa.Column("target_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("rejected_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("rejected_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint(
            "source_type", "source_id", "target_type", "target_id",
            name="uq_rejected_relations_pair",
        ),
    )
    op.create_index(
        "ix_rejected_relations_source", "rejected_relations", ["org_id", "source_type", "source_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_rejected_relations_source", table_name="rejected_relations")
    op.drop_table("rejected_relations")
