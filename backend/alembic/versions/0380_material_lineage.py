"""story #4058(E-RECIPE-1 성공기준 4, 페드루 PO 확定 v3 2026-09-19) — `material_lineage`
신설. 마스터→변주(릴스/쇼츠/광고) 계보 + 소재·훅 단위 성과 회수의 관계 테이블. 노드는 둘 다
기존 엔티티 참조(blob 신규 저장 0, SaaS 경계) — app/models/material_lineage.py 모듈
docstring 참조.

down_revision=0378 — 이 스토리 착수 시점 실물 head(`alembic heads` 확인, 2026-09-19).
0379는 열린 형제 PR 3건(#4039/#4363/#4364)이 동시에 점유해 이미 확定 충돌 상태라(#4419
가드 로그 실측) 그 번호를 또 쓰지 않는다 — 머지 순서가 정해지는 시점에 이 레포 관례대로
renumber로 해소되는 자리(코드 결함 아님, 신규 충돌을 안 늘리려 0380을 선택)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0380"
down_revision = "0378"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "material_lineage",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=True, index=True),
        sa.Column("source_evidence_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("derived_kind", sa.Text(), nullable=False),
        sa.Column("derived_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("relation_kind", sa.Text(), nullable=False),
        sa.Column("variant_axis", sa.Text(), nullable=True),
        sa.Column("hook_key", sa.Text(), nullable=True, index=True),
        sa.Column("work_item_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_unique_constraint(
        "uq_material_lineage_source_derived_relation", "material_lineage",
        ["source_evidence_id", "derived_kind", "derived_id", "relation_kind"],
    )
    op.create_check_constraint(
        "ck_material_lineage_derived_kind",
        "material_lineage",
        "derived_kind IN ('channel_post_draft', 'channel_publication')",
    )
    op.create_check_constraint(
        "ck_material_lineage_relation_kind",
        "material_lineage",
        "relation_kind IN ('platform_cut', 'aspect_adapt', 'hook_variant')",
    )


def downgrade() -> None:
    op.drop_table("material_lineage")
