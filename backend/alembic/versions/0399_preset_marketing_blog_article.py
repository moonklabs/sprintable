"""story #4174(E-RECIPE-2·레시피 2호) — «블로그 글» 프리셋 시드(org_id NULL → 모든 조직 갤러리).

규격: doc «레시피 프리셋 추가 규격 + 발행 표면별 게이트 경로 대조»(story #4172, 7ca3cab5) §4.

흐름(7단계 — 설명 문구 «7단계»와 테스트로 대조):
  planning(Creator) 주제·키워드 기획
  → concept_confirmed(Director, gate=concept_approval) 기획 승인 — 미승인이면 블로그 초안 제출이 막힌다
    (site_posts 제출의 concept_approval 검사, doc §2)
  → writing(Creator, capability=draft_site_post) 블로그 초안 작성
  → verification(Creator, capability=submit_site_post) 콘텐츠 규칙 검수 후 초안 제출(제출이 규칙 검사를 다시 돈다)
  → pending_approval(Director, 게이트 없음) 발행 승인 대기 — 발행 승인은 내용이 봉인된 **초안 게이트** 하나다
    (PO 판정 2026-09-23 08:49Z (a): 레시피 게이트는 블로그 내용을 못 보여 줘 승인이 아니다 — story #4190 봉인 원칙)
  → published(Publisher, capability=site_post_auto_publish) 서버가 실제 발행 뒤 이 단계 이벤트를 낸다(에이전트 할 일
    없음 — 블로그 발행은 사람 전용 권한이라 에이전트는 발행하지 않는다. 이벤트 발행은 story #4192)
  → publish_checked(Publisher) 공개 주소로 발행 결과 확인

capability kind 셋은 모두 에이전트 자기 도구/서버 몫이라(events._AGENT_TOOL_CAPABILITY_KINDS) 적용 화면 준비 경고의
org 커넥터 검사 대상이 아니다. site_post_auto_publish는 «다음 단계를 에이전트가 발행하지 않는다»는 표지이기도 하다 —
멘션 렌더러가 그 앞 단계에서 발행 예시 대신 대기 안내를 싣는다.

역할 3종·게이트 1종 재사용(코드 0). 새 stage slug `publish_checked`는 같은 PR에서 FE 라벨 등록. 이름·설명은
유나 문안(ko = 시드 원문, story #4202 짝 가드).

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
    "planning", "concept_confirmed", "writing", "verification", "pending_approval", "published", "publish_checked",
]

_PAYLOAD_SCHEMA = {
    "type": "object",
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": _STAGES},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        # 발행 승인 대기 단계가 이 회차의 블로그 초안을 명시적으로 연결하는 자리(events.RECIPE_SITE_DRAFT_LINK_FIELD —
        # 레시피 문맥 판별은 이 id와 승인된 초안이 같을 때만). 다른 단계에선 없어도 된다.
        "site_post_draft_id": {"type": "string", "format": "uuid"},
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
    "planning": {"role": "Creator", "action": "주제·키워드 기획(제목 후보와 글 구성)"},
    "concept_confirmed": {
        "role": "Director", "action": "컨셉 승인(주제·키워드·구성 확인)",
        "gate": {"type": "concept_approval", "approver": _OWNER},
    },
    "writing": {
        "role": "Creator", "action": "블로그 초안 작성",
        "capability": {"kind": "draft_site_post"},
    },
    "verification": {
        "role": "Creator", "action": "콘텐츠 규칙 검수 후 초안 제출",
        "capability": {"kind": "submit_site_post"},
    },
    "pending_approval": {
        "role": "Director", "action": "제출한 초안이 발행 승인을 받을 때까지 기다리기(승인은 결재함의 초안에서)",
    },
    "published": {
        "role": "Publisher", "action": "승인된 초안을 블로그에 자동 발행(에이전트 할 일 없음)",
        "capability": {"kind": "site_post_auto_publish"},
    },
    "publish_checked": {"role": "Publisher", "action": "공개 주소로 발행 결과 확인"},
}

_ROLE_ACTOR_KINDS = {"Creator": "agent", "Director": "human", "Publisher": "agent"}

_NAME = "블로그 글"
_DESCRIPTION = "기획부터 발행 확인까지 7단계예요. 기획과 발행 두 곳만 사람이 승인하고, 나머지는 에이전트가 진행해요."


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
