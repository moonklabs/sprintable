"""story 037a8aa8(에이전트 발견성 3층 fix — PO 판정) — ui-designer/design-system
role_templates.default_tool_groups에 "canvas" 추가.

Revision ID: 0182
Revises: 0181
Create Date: 2026-07-14

그라운딩(story 78f07614·PO 성장 지시): E-CANVAS 캔버스 능력을 다 만들었지만 실제 canvas
toolgroup을 보유한 role_template은 backend·frontend 2개뿐(0181)이었다 — 디자인 저작을 전담하는
ui-designer·design-system은 애초 canvas MCP 툴을 tools/list에서 보지도 못했다(핵심 발견성 갭).
PO 판정: 이번 라운드는 write 권한이 확실히 필요한 디자인 저작 2역할만 추가 — pm/technical-writer/
ux-researcher의 read 권한은 실사용 필요 근거 부재로 보류(과부여 회피, 필요 드러나면 별건).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0182"
down_revision = "0181"
branch_labels = None
depends_on = None

_ROLES = ("ui-designer", "design-system")


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
