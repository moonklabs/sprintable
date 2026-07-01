"""E-LOOP-LEDGER S2(story 9731403a): loop_artifacts(variant) 테이블 + S1 지연 FK 마무리.

Revision ID: 0150
Revises: 0149
Create Date: 2026-07-01

블루프린트 §1/§2. variant 후보 + per-variant 결정/이유(choose/rejection reason=moat 신호원).

- `loop_runs.chosen_artifact_id`의 FK를 여기서 잠근다(S1이 컬럼만 만들어둔 것 — 이 테이블이
  이제 존재하므로 ALTER TABLE ADD CONSTRAINT, 컬럼 재생성 없음).
- partial UNIQUE(loop_id, variant_group) WHERE decision='chosen' — 슬롯당 승자 ≤1.
- asset_links.source_type CHECK를 넓혀 'loop_artifact' 추가(DROP+CREATE — Postgres는 CHECK
  in-place ALTER 불가, 0145 phase CHECK 확장과 동일 패턴).

idempotent: 테이블 단위 inspect 가드(0113/0149 선례와 동일 클래스).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0150"
down_revision = "0149"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = set(insp.get_table_names())

    if "loop_artifacts" not in existing:
        op.create_table(
            "loop_artifacts",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column(
                "loop_id",
                UUID(as_uuid=True),
                sa.ForeignKey("loop_runs.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "asset_id",
                UUID(as_uuid=True),
                sa.ForeignKey("assets.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("variant_group", sa.Text(), nullable=False),
            sa.Column("variant_label", sa.Text(), nullable=False),
            sa.Column("decision", sa.String(16), nullable=False, server_default="pending"),
            sa.Column("choose_reason", sa.Text(), nullable=True),
            # ⭐moat 신호원 — 왜 반려했나. 필수화(게이트 강제)는 S5 스코프, 스키마는 nullable.
            sa.Column("rejection_reason", sa.Text(), nullable=True),
            sa.Column(
                "generation_metadata",
                JSONB,
                nullable=False,
                server_default=sa.text("'{}'::jsonb"),
            ),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            # FK 비강제(hypotheses.owner_member_id 동형 컨벤션) — resolve_member 서비스 해소.
            sa.Column("created_by_member_id", UUID(as_uuid=True), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                onupdate=sa.func.now(),
                nullable=False,
            ),
            sa.CheckConstraint(
                "decision IN ('pending','chosen','rejected')",
                name="ck_loop_artifacts_decision",
            ),
        )
        op.create_index("ix_loop_artifacts_org_id", "loop_artifacts", ["org_id"])
        op.create_index(
            "ix_loop_artifacts_loop_variant_group",
            "loop_artifacts",
            ["loop_id", "variant_group", "sort_order"],
        )
        op.create_index("ix_loop_artifacts_asset_id", "loop_artifacts", ["asset_id"])
        # 슬롯(variant_group)당 승자 ≤1 — chosen 행만 대상인 partial unique(0108 doc_share_tokens
        # active 1개 보장과 동일 패턴).
        op.create_index(
            "uq_loop_artifacts_chosen_per_group",
            "loop_artifacts",
            ["loop_id", "variant_group"],
            unique=True,
            postgresql_where=sa.text("decision = 'chosen'"),
        )

    # S1 지연 FK 마무리 — loop_runs.chosen_artifact_id는 컬럼만 있었다.
    existing_fks = {fk["name"] for fk in insp.get_foreign_keys("loop_runs")}
    if "fk_loop_runs_chosen_artifact_id" not in existing_fks:
        op.create_foreign_key(
            "fk_loop_runs_chosen_artifact_id",
            "loop_runs",
            "loop_artifacts",
            ["chosen_artifact_id"],
            ["id"],
            ondelete="SET NULL",
        )

    # asset_links.source_type CHECK 확장 — Postgres는 CHECK in-place ALTER 불가라 DROP+CREATE
    # (0145 retro_sessions.phase CHECK 확장과 동일 패턴).
    op.drop_constraint("ck_asset_links_source_type", "asset_links", type_="check")
    op.create_check_constraint(
        "ck_asset_links_source_type",
        "asset_links",
        "source_type IN ('conversation_message','story','doc','manual','loop_artifact')",
    )


def downgrade() -> None:
    # 주의: asset_links에 source_type='loop_artifact' 행이 이미 있으면 아래 CHECK 재축소가
    # 위반으로 실패한다(0145 phase CHECK 축소와 동일 한계 — best-effort, 데이터 역매핑 없음).
    conn = op.get_bind()
    insp = sa.inspect(conn)

    op.drop_constraint("ck_asset_links_source_type", "asset_links", type_="check")
    op.create_check_constraint(
        "ck_asset_links_source_type",
        "asset_links",
        "source_type IN ('conversation_message','story','doc','manual')",
    )

    existing_fks = {fk["name"] for fk in insp.get_foreign_keys("loop_runs")}
    if "fk_loop_runs_chosen_artifact_id" in existing_fks:
        op.drop_constraint("fk_loop_runs_chosen_artifact_id", "loop_runs", type_="foreignkey")

    existing = set(insp.get_table_names())
    if "loop_artifacts" in existing:
        op.drop_table("loop_artifacts")
