"""story #4176(E-RECIPE-2·레시피 4호) — SNS 포스트 프리셋 2종 시드(org_id NULL → 모든 조직 갤러리).

규격: doc «레시피 프리셋 추가 규격 + 발행 표면별 게이트 경로 대조»(story #4172, 7ca3cab5).

- 정의를 둘로 나눈다: stage에 조건부 건너뛰기가 없어(skip 기전 0) 한 정의로 묶으면 텍스트 포스트도
  이미지 생성·예산 승인을 반드시 지나야 한다(PO 승인 2026-09-23).
  - `preset.marketing.social_card_news` — 이미지 포스트(Instagram처럼 이미지 필수 채널).
  - `preset.marketing.social_text_post` — 텍스트 포스트(Threads처럼 텍스트 허용 채널).
- 발행은 channel post 경로: pending_approval의 external_publish ↔ 초안 게이트 양방향 승계(훅A
  `channel_posts.py:1455` · 훅B `gate_service.py:1260`) + published의 `publish→channel_connection`으로
  자동 발행 — 규격 doc 결론상 끊긴 자리 없음.
- 역할 4종·게이트 3종 재사용(코드 0). 새 stage slug `budget_approved`(마케팅 공통 축 — 영상은 예산
  게이트를 structure_passed에 걸었지만 구조 단계가 없는 레시피용) — FE 라벨은 같은 PR에서 등록.
- 멘션 자기설명은 렌더러가 stage_metadata에서 파생(#4076) · generation_budget 게이트면 예시에
  estimated_cost_minor가 자동으로 실린다(#4085 공유 함수) — 그래서 card_news payload_schema는 그 필드를 연다.

Revision ID: 0395
Revises: 0394
Create Date: 2026-09-23
"""
from __future__ import annotations

import json
import uuid

import sqlalchemy as sa
from alembic import op

revision = "0395"
down_revision = "0394"
branch_labels = None
depends_on = None

_ROUTING = {"escalation": {"kind": "server_derived", "target": "none"}, "broadcast": {"kind": "recipe_role_binding"}}
_OWNER = "org_owner"


def _block_template(header: str) -> dict:
    return {
        "blocks": [
            {"type": "header", "text": header},
            {"type": "text", "text": "**{{label.stage}}** 단계로 넘어갔습니다"},
            {"type": "fields", "fields": [{"label": "대상", "value": "{{label.work_item_target}}"}]},
        ],
    }


def _payload_schema(stages: list[str], *, with_cost: bool) -> dict:
    properties: dict = {
        "stage": {"type": "string", "enum": stages},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
    }
    if with_cost:
        properties["estimated_cost_minor"] = {"type": ["integer", "null"]}
    return {
        "type": "object",
        "required": ["stage", "work_item_type", "work_item_id"],
        "properties": properties,
        "additionalProperties": False,
    }


_CARD_NEWS_STAGES = [
    "draft", "concept_confirmed", "budget_approved", "live_generation",
    "verification", "editing", "pending_approval", "published",
]
_CARD_NEWS = {
    "key": "preset.marketing.social_card_news",
    "name": "SNS 이미지 포스트(카드뉴스)",
    "description": (
        "기획부터 발행까지 8단계예요. 컨셉·생성 예산·최종 발행 세 곳만 사람이 승인하고,"
        " 나머지는 에이전트가 진행해요."
    ),
    "payload_schema": _payload_schema(_CARD_NEWS_STAGES, with_cost=True),
    "block_template": _block_template("SNS 이미지 포스트 워크플로우"),
    "stage_metadata": {
        "draft": {"role": "Creator", "action": "기획 초안 작성(주제·메시지·카드 구성)"},
        "concept_confirmed": {
            "role": "Director", "action": "컨셉 승인(메시지와 카드 구성 확인)",
            "gate": {"type": "concept_approval", "approver": _OWNER},
        },
        "budget_approved": {
            "role": "Director", "action": "생성할 이미지와 예산을 정해 유료 생성 승인",
            "gate": {"type": "generation_budget", "approver": _OWNER},
        },
        "live_generation": {
            "role": "Compute", "action": "유료 이미지 생성 실행",
            "capability": {"kind": "generate", "target": "generation_connector"},
        },
        "verification": {"role": "Creator", "action": "검증 시트 작성(이미지 속 글자·브랜드 표기 확인)"},
        "editing": {
            "role": "Creator", "action": "이미지 첨부와 캡션 작성",
            "capability": {"kind": "attach_image"},
        },
        "pending_approval": {
            "role": "Director", "action": "최종 발행 승인(외부 발행 직전)",
            "gate": {"type": "external_publish", "approver": _OWNER},
        },
        "published": {
            "role": "Publisher", "action": "승인된 채널에 게시",
            "capability": {"kind": "publish", "target": "channel_connection"},
        },
    },
    "role_actor_kinds": {"Creator": "agent", "Director": "human", "Compute": "agent", "Publisher": "agent"},
}

_TEXT_POST_STAGES = ["draft", "concept_confirmed", "editing", "pending_approval", "published"]
_TEXT_POST = {
    "key": "preset.marketing.social_text_post",
    "name": "SNS 텍스트 포스트",
    "description": (
        "초안부터 발행까지 5단계예요. 컨셉·최종 발행 두 곳만 사람이 승인하고, 나머지는 에이전트가 진행해요."
    ),
    "payload_schema": _payload_schema(_TEXT_POST_STAGES, with_cost=False),
    "block_template": _block_template("SNS 텍스트 포스트 워크플로우"),
    "stage_metadata": {
        "draft": {"role": "Creator", "action": "글 초안 작성(주제·메시지)"},
        "concept_confirmed": {
            "role": "Director", "action": "컨셉 승인(메시지와 말투 확인)",
            "gate": {"type": "concept_approval", "approver": _OWNER},
        },
        "editing": {"role": "Creator", "action": "글 다듬기(길이·해시태그·링크 정리)"},
        "pending_approval": {
            "role": "Director", "action": "최종 발행 승인(외부 발행 직전)",
            "gate": {"type": "external_publish", "approver": _OWNER},
        },
        "published": {
            "role": "Publisher", "action": "승인된 채널에 게시",
            "capability": {"kind": "publish", "target": "channel_connection"},
        },
    },
    "role_actor_kinds": {"Creator": "agent", "Director": "human", "Publisher": "agent"},
}

_PRESETS = (_CARD_NEWS, _TEXT_POST)


def upgrade() -> None:
    conn = op.get_bind()
    for p in _PRESETS:
        conn.execute(
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
                "key": p["key"],
                "name": p["name"],
                "description": p["description"],
                "payload_schema": json.dumps(p["payload_schema"]),
                "routing": json.dumps(_ROUTING),
                "block_template": json.dumps(p["block_template"]),
                "stage_metadata": json.dumps(p["stage_metadata"]),
                "role_actor_kinds": json.dumps(p["role_actor_kinds"]),
            },
        )


def downgrade() -> None:
    conn = op.get_bind()
    for p in _PRESETS:
        conn.execute(
            sa.text("DELETE FROM event_definitions WHERE org_id IS NULL AND key = :key"),
            {"key": p["key"]},
        )
