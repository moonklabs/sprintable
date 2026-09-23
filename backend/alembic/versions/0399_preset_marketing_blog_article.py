"""story #4174(E-RECIPE-2·레시피 2호) — «블로그 글» 프리셋 시드(org_id NULL → 모든 조직 갤러리).

규격: doc «레시피 프리셋 추가 규격 + 발행 표면별 게이트 경로 대조»(story #4172, 7ca3cab5) §4.

흐름(7단계):
  draft(Creator) 주제·키워드 기획
  → concept_confirmed(Director, gate=concept_approval) 기획 승인 — 미승인이면 블로그 초안 제출이 막힌다
    (site_posts 제출의 concept_approval 검사, doc §2)
  → editing(Creator, capability=draft_site_post) 블로그 초안 작성
  → verification(Creator) 콘텐츠 규칙 검수 후 제출 — 제출이 규칙 검사(lint)를 다시 돈다
  → pending_approval(Director, gate=external_publish) 최종 발행 승인
  → published(Publisher, capability=publish_site_post) 승인된 블로그에 게시
  → publish_checked(Publisher) 공개 주소로 게시 결과 확인

발행 단계 capability는 `channel_connection`이 아니다 — 그 target은 승인 즉시 채널 초안을 자동 발행하는
경로(`publish_recipe_approved_draft`)라 블로그 초안을 찾지 못한다. 블로그는 게이트 승인 뒤 Publisher가
publish_site_post로 게시한다(자사 블로그는 동기 발행 · 외부 블로그는 승인 시 이미 만들어진 발행 명령을
그대로 돌려받는다 — story #4190). 두 kind(draft_site_post·publish_site_post)는 에이전트 자기 도구
kind라 멘션에 도구 안내가 붙고, 적용 화면 준비 경고의 org 커넥터 검사 대상이 아니다
(events._AGENT_TOOL_CAPABILITY_KINDS).

역할 3종·게이트 2종 재사용(코드 0). 새 stage slug `publish_checked`는 같은 PR에서 FE 라벨 등록.

Revision ID: 0399
Revises: 0398
Create Date: 2026-09-23
"""
from __future__ import annotations

import json
import uuid

import sqlalchemy as sa
from alembic import op

revision = "0399"
down_revision = "0398"
branch_labels = None
depends_on = None

_KEY = "preset.marketing.blog_article"
_OWNER = "org_owner"

_STAGES = [
    "draft", "concept_confirmed", "editing", "verification", "pending_approval", "published", "publish_checked",
]

_PAYLOAD_SCHEMA = {
    "type": "object",
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": _STAGES},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
    },
    "additionalProperties": False,
}

_ROUTING = {"escalation": {"kind": "server_derived", "target": "none"}, "broadcast": {"kind": "recipe_role_binding"}}

_BLOCK_TEMPLATE = {
    "blocks": [
        {"type": "header", "text": "블로그 글 워크플로우"},
        {"type": "text", "text": "**{{label.stage}}** 단계로 넘어갔습니다"},
        {"type": "fields", "fields": [{"label": "대상", "value": "{{label.work_item_target}}"}]},
    ],
}

_STAGE_METADATA = {
    "draft": {"role": "Creator", "action": "주제·키워드 기획(제목 후보와 글 구성)"},
    "concept_confirmed": {
        "role": "Director", "action": "기획 승인(주제·키워드·구성 확인)",
        "gate": {"type": "concept_approval", "approver": _OWNER},
    },
    "editing": {
        "role": "Creator", "action": "블로그 초안 작성",
        "capability": {"kind": "draft_site_post"},
    },
    "verification": {"role": "Creator", "action": "콘텐츠 규칙 검수 후 초안 제출"},
    "pending_approval": {
        "role": "Director", "action": "최종 발행 승인(외부 발행 직전)",
        "gate": {"type": "external_publish", "approver": _OWNER},
    },
    "published": {
        "role": "Publisher", "action": "승인된 블로그에 게시",
        "capability": {"kind": "publish_site_post"},
    },
    "publish_checked": {"role": "Publisher", "action": "공개 주소로 게시 결과 확인"},
}

_ROLE_ACTOR_KINDS = {"Creator": "agent", "Director": "human", "Publisher": "agent"}

_NAME = "블로그 글"
_DESCRIPTION = (
    "주제 기획부터 게시 확인까지 7단계예요. 기획과 최종 발행 두 곳만 사람이 승인하고, 나머지는 에이전트가 진행해요."
)


def upgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "INSERT INTO event_definitions "
            "(id, key, org_id, name, description, payload_schema, routing, block_template, "
            " stage_metadata, role_actor_kinds, enabled, version) "
            "VALUES (:id, :key, NULL, :name, :description, CAST(:payload_schema AS jsonb), "
            " CAST(:routing AS jsonb), CAST(:block_template AS jsonb), CAST(:stage_metadata AS jsonb), "
            " CAST(:role_actor_kinds AS jsonb), true, 1) "
            "ON CONFLICT DO NOTHING"
        ),
        {
            "id": str(uuid.uuid4()),
            "key": _KEY,
            "name": _NAME,
            "description": _DESCRIPTION,
            "payload_schema": json.dumps(_PAYLOAD_SCHEMA),
            "routing": json.dumps(_ROUTING),
            "block_template": json.dumps(_BLOCK_TEMPLATE, ensure_ascii=False),
            "stage_metadata": json.dumps(_STAGE_METADATA, ensure_ascii=False),
            "role_actor_kinds": json.dumps(_ROLE_ACTOR_KINDS),
        },
    )


def downgrade() -> None:
    op.get_bind().execute(
        sa.text("DELETE FROM event_definitions WHERE org_id IS NULL AND key = :key"), {"key": _KEY},
    )
