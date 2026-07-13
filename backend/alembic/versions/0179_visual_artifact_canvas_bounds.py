"""E-CANVAS 뷰어 통합 재설계(story 1948d19d·doc artifact-canvas-viewport-spec §4) — canvas_bounds.

Revision ID: 0179
Revises: 0178
Create Date: 2026-07-13

sandbox iframe이라 콘텐츠 크기를 내부 측정할 수 없어, 렌더 산출물이 자기 프레임 크기({w,h})를
직접 선언하는 아트보드 프레임 규약으로 전환한다.

배치(§4-1 스키마 판단 — 디디 확定): iframe 1개 = **버전 전체 node 합성 렌더**(단일 html_blob
노드가 아니라 `_render_self_contained_html`이 그 버전의 nodes 전부를 하나의 self-contained
문서로 합성) — 프레임 크기는 근본적으로 **버전 단위** 개념이다.

- `artifact_versions.canvas_bounds`(SSOT) — 그 버전이 실제로 선언한 프레임(불변 스냅샷,
  edit마다 새 버전이 자기 값을 갖거나 이전 버전 값을 이어받음).
- `visual_artifacts.canvas_bounds`(denorm 캐시) — latest_version_number 컬럼과 동일 목적
  (매 GET/list마다 버전 서브쿼리 회피). 항상 latest version의 값과 동기화.

둘 다 additive nullable JSONB — 미선언(None)이면 FE가 기본 아트보드 규약으로 폴백(레거시 무회귀).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0179"
down_revision = "0178"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "visual_artifacts",
        sa.Column("canvas_bounds", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "artifact_versions",
        sa.Column("canvas_bounds", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("artifact_versions", "canvas_bounds")
    op.drop_column("visual_artifacts", "canvas_bounds")
