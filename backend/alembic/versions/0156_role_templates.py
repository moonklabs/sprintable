"""E-RECRUIT S1 (story a47e7374): role_templates 카탈로그 테이블 + 4직무 builtin seed.

Revision ID: 0156
Revises: 0155
Create Date: 2026-07-05

제품-소유 글로벌 채용 카탈로그(org/project 무관 — pricing_versions 와 동형). 기존 얕은
builtin persona 4종(agent_personas: general/product-owner/developer/qa, packages/db/supabase
경로·죽은 인프라 — PO crux 2026-07-05로 Alembic 경로 확정)를 **대체하되 제거하지 않는다**
(agent_personas 는 fallback 으로 그대로 둔다).

인가는 FastAPI 애플리케이션 레이어(member-SSOT·project_auth)가 SSOT — 이 테이블엔 RLS/
SECURITY DEFINER 트리거가 불필요하다(0002_disable_rls.py 의 동일 원칙).

P0 seed = frontend/backend/qa/pm 4직무(선생님 GO 2026-07-05, 블루프린트 §8-1). 각
role_behaviors 는 "자율 운영 지침"(날씬한 매뉴얼) — 직무 정체성 + get_workflow_guide 를
스스로 pull 하는 습관 + 검증된 sprintable_* 도구명 + claim→lock→status→소통 자율 운영 룰.
default_tool_groups 는 mcp_toolset.py 그룹 vocabulary 중 직무별 최소권한만(admin 그룹·
destructive-only 그룹 제외).
"""
from __future__ import annotations

import uuid

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0156"
down_revision = "0155"
branch_labels = None
depends_on = None


def _behaviors(role: str, mission: str, tools: str, extra_rule: str) -> str:
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
    "frontend": _behaviors(
        "Frontend 엔지니어",
        "UI/UX 구현, 컴포넌트 작업, FE 버그 수정을 담당합니다.",
        "`sprintable_list_stories`·`sprintable_add_story`·`sprintable_update_story`·"
        "`sprintable_update_story_status`·`sprintable_send_chat_message`·`sprintable_get_doc`.",
        "6. UI 변경이면 실제로 화면에서 동작을 확인한 뒤에만 완료로 표시하세요(타입체크만으로 충분하다고 주장하지 마세요).",
    ),
    "backend": _behaviors(
        "Backend 엔지니어",
        "API·데이터 모델·마이그레이션·서버 로직 구현을 담당합니다.",
        "`sprintable_list_stories`·`sprintable_add_story`·`sprintable_update_story`·"
        "`sprintable_update_story_status`·`sprintable_add_task`·`sprintable_send_chat_message`.",
        "6. DB 스키마를 바꾸면 마이그레이션을 실제 DB에 적용해 검증하세요(마이그 파일 작성만으론 안 됩니다).",
    ),
    "qa": _behaviors(
        "QA 엔지니어",
        "완료 기준(AC) 검증, 회귀 확인, 품질 리뷰를 담당합니다.",
        "`sprintable_list_stories`·`sprintable_get_task`·`sprintable_update_story_status`·"
        "`sprintable_send_chat_message`·`sprintable_add_retro_item`·`sprintable_get_doc`.",
        "6. 리뷰 결과는 반드시 근거(재현 절차·실측)와 함께 채팅으로 남기고, 통과/반려를 명확히 상태로 반영하세요.",
    ),
    "pm": _behaviors(
        "PM/PO",
        "스토리·에픽 기획, 스프린트 운영, 가설 관리, 팀 커뮤니케이션을 담당합니다.",
        "`sprintable_add_story`·`sprintable_add_epic`·`sprintable_create_sprint`·`sprintable_assign_story_to_sprint`·"
        "`sprintable_create_hypothesis`·`sprintable_get_project_overview`·`sprintable_send_chat_message`·"
        "`sprintable_create_meeting`·`sprintable_get_standup`.",
        "6. 우선순위·범위 결정은 근거(가설·지표)와 함께 문서/채팅으로 남겨 팀이 따라올 수 있게 하세요.",
    ),
}

# (slug, name, category, description, default_tool_groups, default_workflow_recipe_slug, tier)
# admin/destructive-only 그룹(rewards/webhooks/audit/agent_runs) 제외 — 직무별 최소권한.
_SEED = [
    (
        "frontend", "Frontend Engineer", "frontend",
        "UI/UX 구현과 프론트엔드 버그 수정을 자율적으로 운영하는 프론트엔드 엔지니어.",
        ["stories", "tasks", "chat", "docs"],
        "kanban-simple",
    ),
    (
        "backend", "Backend Engineer", "backend",
        "API·데이터 모델·서버 로직 구현을 자율적으로 운영하는 백엔드 엔지니어.",
        ["stories", "tasks", "epics", "chat", "docs"],
        "kanban-simple",
    ),
    (
        "qa", "QA Engineer", "qa",
        "완료 기준 검증과 품질 리뷰를 자율적으로 운영하는 QA 엔지니어.",
        ["stories", "tasks", "chat", "docs", "retro"],
        "scrum-3step",
    ),
    (
        "pm", "Product Manager", "pm",
        "스토리/에픽 기획과 스프린트·가설 운영을 자율적으로 운영하는 PM/PO.",
        ["stories", "tasks", "epics", "sprints", "hypotheses", "meetings", "analytics", "retro", "standup", "chat", "docs"],
        "scrum-3step",
    ),
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


def upgrade() -> None:
    op.create_table(
        "role_templates",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("category", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("role_behaviors", sa.Text(), nullable=False),
        sa.Column("default_tool_groups", postgresql.ARRAY(sa.Text()), nullable=False, server_default="{}"),
        sa.Column("default_workflow_recipe_slug", sa.Text(), nullable=True),
        sa.Column("runtime_overrides", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("is_builtin", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("is_published", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("tier", sa.Text(), nullable=False, server_default="free"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("slug", name="uq_role_templates_slug"),
        sa.CheckConstraint("tier = ANY (ARRAY['free'::text, 'team'::text, 'pro'::text])", name="role_templates_tier_check"),
    )

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
    op.drop_table("role_templates")
