"""A2A 발견 스킬 갭(story 10c6ecbd) 후속 — 마케팅 직군 2종 role_templates seed.

Revision ID: 0160
Revises: 0159
Create Date: 2026-07-07

PO(선생님 확定) 정의: 담롱 온찬(Growth Hacker)·댄 어윈(Performance Marketer)을 억지로 기존
엔지니어링 template(growth-engineer)에 우겨넣거나 미배정으로 두지 않고, 마케팅 직군을 카탈로그에
정식으로 추가한다. 0157과 동일한 5요소 role_behaviors 구조 + 6번째 품질 게이트 규칙을 따른다.

⚠️ **tool_groups 정정(실측)**: PO가 준 "skills"(user-acquisition·funnel-experimentation·
marketing-automation·paid-acquisition·attribution·roas·ad-analytics·creative-testing 등)는
`mcp_toolset.ALL_GROUPS`(stories/tasks/sprints/epics/chat/docs/analytics/retro/standup/meetings/
notifications/webhooks/rewards/audit/agent_runs/admin/core) 실 vocabulary에 없다 — 그대로
default_tool_groups에 넣으면 validate_tool_groups가 unknown-group으로 reject한다. 그 서술은
description/role_behaviors 미션 텍스트로 반영하고, tool_groups는 growth-engineer(같은 growth
카테고리)와 동형인 실 그룹(stories/tasks/chat/docs/analytics/hypotheses)으로 채운다.
"""
from __future__ import annotations

import uuid

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0160"
down_revision = "0159"
branch_labels = None
depends_on = None


def _behaviors(role: str, mission: str, tools: str, extra_rule: str) -> str:
    """0156/0157과 동일한 5요소 템플릿 — claim→lock→status→소통 표준 오프닝."""
    return f"""# {role} — 자율 운영 지침

당신은 이 프로젝트의 {role}입니다. {mission}

## 스스로 판단해 운영하는 법
1. `sprintable_list_backlog` 또는 `sprintable_get_unassigned_stories`로 착수할 작업을 찾습니다.
2. `sprintable_claim_story`로 claim하고 `sprintable_update_story_status`로 in-progress로 옮깁니다.
3. 여러 에이전트가 같은 파일을 동시에 건드릴 수 있는 작업이면 `sprintable_lock_files`로 잠그고, 끝나면 `sprintable_unlock_files`로 풉니다.
4. 진행 상황·질문·블로커는 침묵하지 말고 `sprintable_send_chat_message`로 관련자에게 즉시 공유합니다.
5. 완료 기준(AC)을 만족하면 `sprintable_update_story_status`로 다음 단계(in-review 등)로 옮깁니다.
{extra_rule}

## 막히면 스스로 확인하세요
플랫폼이 매턴 지시하지 않습니다 — 방식이 낯설거나 막히면 스스로 `sprintable_get_workflow_guide`를 불러 최신 운영법을 확인하세요(추측 금지).

## 자주 쓰는 도구
{tools}
확실하지 않은 도구 이름을 지어내지 마세요 — 위 목록에 없으면 `sprintable_get_workflow_guide`로 먼저 확인하세요.

## 런타임 노트
이 지침은 런타임(claude-code 등)에 관계없이 동일합니다. MCP 연결/스코프는 채용 시점 번들이 처리합니다.
"""


_ROLE_BEHAVIORS = {
    "growth-hacker": _behaviors(
        "Growth Hacker",
        "성장 실험·유저 획득·퍼널 최적화·리텐션 분석을 데이터 기반으로 자율 주도합니다"
        "(user acquisition·funnel experimentation·marketing automation·retention analytics).",
        "`sprintable_create_hypothesis`·`sprintable_confirm_hypothesis`·"
        "`sprintable_get_recent_activity`·`sprintable_get_sprint_velocity_history`·"
        "`sprintable_send_chat_message`.",
        "6. 실험/캠페인 결과는 반드시 실 지표(전환율·리텐션·유입 데이터)로 검증한 뒤에만 완료로 표시하세요(가설/추정만으론 안 됩니다).",
    ),
    "performance-marketer": _behaviors(
        "Performance Marketer",
        "유료 획득·캠페인 최적화·어트리뷰션/ROAS 성과 운영을 자율 주도합니다"
        "(paid acquisition·campaign optimization·attribution·ad analytics·creative testing).",
        "`sprintable_get_recent_activity`·`sprintable_create_hypothesis`·"
        "`sprintable_confirm_hypothesis`·`sprintable_get_sprint_velocity_history`·"
        "`sprintable_send_chat_message`.",
        "6. 캠페인 최적화는 실 성과 지표(ROAS·어트리뷰션 데이터)로 검증한 뒤에만 완료로 표시하세요(예상치·집행 완료만으론 안 됩니다).",
    ),
}

# (slug, name, category, description, default_tool_groups, default_workflow_recipe_slug)
_SEED = [
    ("growth-hacker", "Growth Hacker", "growth",
     "성장 실험·유저 획득·퍼널 최적화를 데이터 기반으로 주도하는 그로스 해커.",
     ["stories", "tasks", "chat", "docs", "analytics", "hypotheses"], "loop-agency"),
    ("performance-marketer", "Performance Marketer", "marketing",
     "유료 획득·캠페인 최적화·어트리뷰션/ROAS 성과를 운영하는 퍼포먼스 마케터.",
     ["stories", "tasks", "chat", "docs", "analytics", "hypotheses"], "loop-agency"),
]

_role_templates = sa.table(
    "role_templates",
    sa.column("id", postgresql.UUID(as_uuid=True)),
    sa.column("slug", sa.Text),
    sa.column("name", sa.Text),
    sa.column("category", sa.Text),
    sa.column("description", sa.Text),
    sa.column("role_behaviors", sa.Text),
    sa.column("default_tool_groups", postgresql.ARRAY(sa.Text)),
    sa.column("default_workflow_recipe_slug", sa.Text),
    sa.column("runtime_overrides", postgresql.JSONB),
    sa.column("is_builtin", sa.Boolean),
    sa.column("is_published", sa.Boolean),
    sa.column("tier", sa.Text),
    sa.column("version", sa.Integer),
)

_NEW_SLUGS = [slug for slug, *_ in _SEED]


def upgrade() -> None:
    op.bulk_insert(
        _role_templates,
        [
            {
                "id": uuid.uuid4(),
                "slug": slug,
                "name": name,
                "category": category,
                "description": description,
                "role_behaviors": _ROLE_BEHAVIORS[slug],
                "default_tool_groups": tool_groups,
                "default_workflow_recipe_slug": recipe_slug,
                "runtime_overrides": {},
                "is_builtin": True,
                "is_published": True,
                "tier": "free",
                "version": 1,
            }
            for slug, name, category, description, tool_groups, recipe_slug in _SEED
        ],
    )


def downgrade() -> None:
    op.execute(
        sa.text("DELETE FROM role_templates WHERE slug = ANY(:slugs)").bindparams(
            sa.bindparam("slugs", value=_NEW_SLUGS, type_=postgresql.ARRAY(sa.Text))
        )
    )
