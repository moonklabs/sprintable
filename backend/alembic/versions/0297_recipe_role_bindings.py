"""story #3288(도메인탈고정 축2-ⓐ) — recipe_role_bindings 신설: EventDefinition.stage_metadata
의 role(현재 표시 텍스트뿐)을 실제 org/project의 TeamMember(에이전트)에 바인딩해, routing
해석기(event_routing_resolver.py)가 발행 시점에 "이 stage는 실제로 누구인가"를 조회할 수 있게
한다. AgentRoutingRule 재사용은 폐기(doc axis2-recipe-mechanism-event-definitions-design 참고
— rule_evaluator.py가 구세대 trigger 어휘 전용이라 신세대 트리거를 아예 못 읽음).

project_id nullable — NULL은 org 전역 바인딩(모든 project 적용), NOT NULL은 그 project 전용
(조회 시 project 특이성이 org 전역보다 우선 — WebhookConfig의 project_id-nullable-scope
패턴과 동형).

Revision ID: 0297
Revises: 0296
Create Date: 2026-09-01

⚠️ 마이그 번호 조정(2026-09-01, PO 조율) — 원래 0296으로 작성했으나 PR#3685(축1·
0296_org_domain_label)가 먼저 그 번호를 썼다(둘 다 develop 최신 0295에서 분기한 형제
충돌). 3685가 먼저 develop에 착지하므로 이쪽을 0297로 밀고 down_revision을 0296(3685의
번호)으로 체인.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0297"
down_revision = "0296"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "recipe_role_bindings",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", UUID(as_uuid=True), nullable=True),
        sa.Column("event_definition_key", sa.Text, nullable=False),
        sa.Column("stage", sa.Text, nullable=False),
        sa.Column("agent_member_id", UUID(as_uuid=True), nullable=False),
        sa.Column("created_by", UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_recipe_role_bindings_org_id", "recipe_role_bindings", ["org_id"])
    op.create_index("ix_recipe_role_bindings_project_id", "recipe_role_bindings", ["project_id"])
    op.create_index(
        "ix_recipe_role_bindings_lookup", "recipe_role_bindings",
        ["org_id", "event_definition_key", "stage"],
    )
    # NULLS NOT DISTINCT 미지원(PG16 이하 호환) — project_id NULL(org 전역)은 org당 1개만
    # 허용하려는 의도지만, 표준 UNIQUE 제약은 NULL끼리 서로 다르다고 봐 여러 org-전역 행이
    # 통과해버린다(재적용 시 upsert가 새 행을 또 만듦). 부분 unique index 2개로 분리해
    # "NULL(org 전역)은 org당 1개"와 "NOT NULL(project 특이성)은 (org,project,key,stage)당
    # 1개"를 각각 강제한다.
    op.create_index(
        "uq_recipe_role_bindings_org_scope", "recipe_role_bindings",
        ["org_id", "event_definition_key", "stage"],
        unique=True, postgresql_where=sa.text("project_id IS NULL"),
    )
    op.create_index(
        "uq_recipe_role_bindings_project_scope", "recipe_role_bindings",
        ["org_id", "project_id", "event_definition_key", "stage"],
        unique=True, postgresql_where=sa.text("project_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_table("recipe_role_bindings")
