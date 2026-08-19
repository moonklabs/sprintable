"""story #2810(2790 라우터 은퇴에서 분리) — role_templates.default_workflow_recipe_slug
죽은 컬럼 제거.

배경: 이 컬럼은 구 `workflow_recipes` 라우터(story #2790 P1 후속, PR #3240으로 은퇴 완료)의
recipe slug를 느슨 참조(FK 강제 없음)했으나, FE 소비는 애초에 0건이었다(recruit.ts 타입
미러만 있고 어느 화면도 렌더 안 함 — [[workflow-recipes-fe-consumption-map-2792]] §1 표#5,
[[workflow-recipes-router-retirement-consumption-map-2790]] §2-B로 이미 실측·확認됨). 로직
연결도 0(읽기 패스스루뿐, 별도 검증/분기 없음) — 2790 설계카드에도 "인접 발견"으로만
등재됐지 어느 처분 계획에도 없던 컬럼이다.

PO 지시(2026-08-19): 컬럼 은퇴 마이그+참조 0건 표 방식으로 정리(라우터 은퇴와 동일 패턴).

downgrade는 컬럼만 복원한다(nullable, 값은 복원 불가 — 죽은 필드였으므로 데이터 손실 리스크
없음, is_builtin 24+행 전부 NULL로 재생성됨을 감수).

Revision ID: 0261
Revises: 0260
Create Date: 2026-08-19
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0261"
down_revision = "0260"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("role_templates", "default_workflow_recipe_slug")


def downgrade() -> None:
    op.add_column(
        "role_templates",
        sa.Column("default_workflow_recipe_slug", sa.Text(), nullable=True),
    )
