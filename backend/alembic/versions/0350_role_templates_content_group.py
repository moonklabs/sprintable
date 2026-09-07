"""story #3631(콘텐츠/채널 도구 toolset 그룹 신설) 후속 데이터 정합 —
role_templates.default_tool_groups에 "content" 추가.

Revision ID: 0350
Revises: 0349
Create Date: 2026-09-07

0181(canvas)과 동형 — 그룹만 신설하고 role_template.default_tool_groups에 아무도
이 토큰을 안 가지면 「만들어졌는데 도는 자리 없음」(fail-closed, 등록만으로는 아무
role도 자동으로 못 씀). 대상 role 선정 근거(0160_role_templates_marketing_roster.py
grep) — `category="marketing"` role은 performance-marketer 1개뿐이고, 채널 포스트
초안/댓글 수집(channel_posts.py·channel_post_comments.py, story #3516 자체 서술
"블루프린트 v3 §2 「댓글·반응 대응」·마케팅운영")은 이 role의 실 업무 범위와 정확히
겹친다. growth-hacker(category="growth", 0160에서 performance-marketer와 동시 seed
·같은 tool_groups 튜플을 공유)도 퍼널/캠페인 콘텐츠를 다루는 인접 직군이라 함께
추가한다 — 전용 "content marketer"/"social media manager" role_template은 아직
카탈로그에 없다(0156~0348 grep 확認, 신설은 이 스토리 범위 밖). pm/qa 등은 0181과
같은 이유로 스코프 밖(필요 시 별건).

PO 요청(2026-09-07) — dev 실측(뭉클랩=customer zero, GET /api/v2/team-members?type=
agent + 활성 11 에이전트 각각 GET /api/v2/agent-personas?agent_id=)으로 실제 recruit
된 role_template과 교차 확認: growth-hacker=담롱 온찬 1명·performance-marketer=댄
어윈 1명, 그 외 9명(pm·ui-designer·qa-engineer·backend·frontend·mobile·security-
engineer, +시스템 계정 2개 persona 0건)은 이 그룹과 무관한 role — 활성 11개 전체를
훑어도 이 2 role 밖에서 recruit된 콘텐츠/소셜 전담 role은 0건. 대상 2종이 이미 "우리가
쓰는 자리"의 전부임을 확認(고객이 못 쓰는 자리가 따로 있는 게 아니었다).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0350"
down_revision = "0349"
branch_labels = None
depends_on = None

_ROLES = ("growth-hacker", "performance-marketer")


def upgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE role_templates "
            "SET default_tool_groups = array_append(default_tool_groups, 'content') "
            "WHERE slug = ANY(:roles) AND NOT ('content' = ANY(default_tool_groups))"
        ).bindparams(sa.bindparam("roles", value=list(_ROLES), type_=sa.ARRAY(sa.Text)))
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE role_templates "
            "SET default_tool_groups = array_remove(default_tool_groups, 'content') "
            "WHERE slug = ANY(:roles)"
        ).bindparams(sa.bindparam("roles", value=list(_ROLES), type_=sa.ARRAY(sa.Text)))
    )
