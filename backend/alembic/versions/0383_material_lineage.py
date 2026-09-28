"""story #4058(E-RECIPE-1 성공기준 4, 페드루 PO 확定 v3 2026-09-19) — `material_lineage`
신설. 마스터→변주(릴스/쇼츠/광고) 계보 + 소재·훅 단위 성과 회수의 관계 테이블. 노드는 둘 다
기존 엔티티 참조(blob 신규 저장 0, SaaS 경계) — app/models/material_lineage.py 모듈
docstring 참조.

revision=0383·down_revision=0382 — 17:12 배치 renumber(PO 확定, 2026-09-19). 0379/0380은
열린 형제 PR(#4363/#4364)이 점유해 충돌 존이라(#4419 가드 로그 실측) 그 위 free 블록에
얹었다: #4419(0381)→#4423(0382)→이 파일(0383) 배치 체인 세 번째 장. 최초 리비전 번호는
0380(down_revision=0378)이었다 — 이 갱신본이 그 위에 정정."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0383"
down_revision = "0382"
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
