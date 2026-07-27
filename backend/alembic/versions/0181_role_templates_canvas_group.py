"""story b4027b2e(SEC) 후속 데이터 정합 — backend/frontend role_templates.default_tool_groups에
"canvas" 추가.

Revision ID: 0181
Revises: 0180
Create Date: 2026-07-13

이 스토리가 visual_artifacts REST/MCP를 cross-cutting always-allow에서 전용 "canvas" toolgroup으로
재분류한다(app/services/mcp_toolset.py). `default_tool_groups`는 API key scope로 그대로 흘러가
(role_template.py 주석 확인) 채용 시점에 구워진다 — "canvas"는 이 그룹 신설 전 seed(0156)라 어떤
role_template에도 있을 수 없었고, backend/frontend 역할로 채용된 에이전트가 canvas 그룹-스코프
키를 쓴다면 이 리클래스로 artifact/pin MCP 도구·REST 접근이 즉시 회귀한다(그라운딩에서 라이브
키 분포는 ADC 재인증 함정으로 실측 불가 — 코드상 default_tool_groups→scope 직결 경로가 확인된
가장 구체적인 실 사용처라 선제 반영). backend(E-CANVAS BE 저작 전담)·frontend(뷰어 구현·QA
dogfooding) 두 역할만 추가 — qa/pm은 이 스토리 스코프 밖(필요 시 별건).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0181"
down_revision = "0180"
branch_labels = None
depends_on = None

_ROLES = ("backend", "frontend")


def upgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE role_templates "
            "SET default_tool_groups = array_append(default_tool_groups, 'canvas') "
            "WHERE slug = ANY(:roles) AND NOT ('canvas' = ANY(default_tool_groups))"
        ).bindparams(sa.bindparam("roles", value=list(_ROLES), type_=sa.ARRAY(sa.Text)))
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE role_templates "
            "SET default_tool_groups = array_remove(default_tool_groups, 'canvas') "
            "WHERE slug = ANY(:roles)"
        ).bindparams(sa.bindparam("roles", value=list(_ROLES), type_=sa.ARRAY(sa.Text)))
    )
