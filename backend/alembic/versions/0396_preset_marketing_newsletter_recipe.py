"""story #4175(E-RECIPE-2) — 마케팅 워크플로우 «뉴스레터» 프리셋 시드.

0381(영상 제작)과 같은 경로 — 사이클형 EventDefinition 한 행(org_id NULL, 모든 조직 갤러리에 노출)을
놓는 데이터 마이그레이션뿐이다. 규격은 story #4172 doc(7ca3cab5) §4를 그대로 따른다.

흐름(6단계)과 기대는 메커니즘 — 전부 이미 있는 계약이다:
  collect(Creator) 소재 수집
  → draft(Creator) 초안
  → review(Director, gate=external_publish) 사람이 내용을 검수·승인
  → campaign_created(Publisher, capability publish → channel_connection) 승인된 초안으로 Stibee 캠페인 생성
    (슬러그를 영상의 `published`와 따로 둔다 — 라벨이 «발행»으로 풀려 발송 승인 앞에서 «이미 나갔다»로 읽혔다,
    유나 design. 자동 발행은 슬러그가 아니라 다음 단계의 capability.target을 본다)
    (Stibee는 channel post 채널 — 레시피 external_publish 승인과 초안 게이트가 서로 승계되고, 다음
    stage가 channel_connection이면 자동 발행된다. doc §2 «channel post» 행)
  → send_requested(Publisher, gate=newsletter_send) 발송 요청 — 수신 대상·예약 시각을 봉인하고 사람이
    한 번 승인한다(story #4191: 레시피 발송 단계가 요청을 만들고 승인은 사람만. 봉인 필드
    publication_id·segment_name·scheduled_at는 recipe_gate_hooks._GATE_TYPE_SEALED_FIELDS가 강제)
  → send_checked(Publisher) 발송 결과 확인. 발송 완료가 이 단계로 자동으로 이어지지는 않는다(발송
    실행은 activity log만 남긴다 — story #4192 P4 부류, PR #4550 본문).

payload_schema는 additionalProperties=false라 발송 단계의 봉인 필드 3개를 선택 속성으로 연다(필수 여부는
스키마가 아니라 봉인 필드 검사가 발송 단계에서만 가른다 — 다른 단계 이벤트엔 없어도 된다).

역할은 기존 어휘 재사용(Creator·Director·Publisher — FE stage-role 표에 이미 있음). 새 stage slug 5개
(collect·review·campaign_created·send_requested·send_checked)는 같은 PR에서 FE recipe-stage-label 표·messages ko/en에 등재
(doc §4.7 필수, tests/test_4188_platform_preset_user_copy_guard_realdb.py가 강제).

Revision ID: 0396
Revises: 0395
Create Date: 2026-09-23
"""
from __future__ import annotations

import json
import uuid

import sqlalchemy as sa
from alembic import op

revision = "0396"
down_revision = "0395"
branch_labels = None
depends_on = None

_KEY = "preset.marketing.newsletter"

_STAGE_SLUGS = ["collect", "draft", "review", "campaign_created", "send_requested", "send_checked"]

_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": _STAGE_SLUGS},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        # story #4191 — send_requested 단계의 newsletter_send 게이트 봉인 필드.
        "publication_id": {"type": "string"},
        "segment_name": {"type": "string"},
        "scheduled_at": {"type": "string"},
    },
}

_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "recipe_role_binding"},
}

_STAGE_METADATA = {
    "collect": {"role": "Creator", "action": "뉴스레터에 담을 소재 모으기"},
    "draft": {"role": "Creator", "action": "뉴스레터 초안 작성"},
    "review": {
        "role": "Director", "action": "내용 검수 후 캠페인 만들기 승인",
        "gate": {"type": "external_publish", "approver": "org_owner"},
    },
    "campaign_created": {
        "role": "Publisher", "action": "승인된 초안으로 Stibee 캠페인 만들기",
        "capability": {"kind": "publish", "target": "channel_connection"},
    },
    "send_requested": {
        "role": "Publisher", "action": "받는 사람과 보낼 시각을 정해 발송 승인 요청",
        "gate": {"type": "newsletter_send", "approver": "org_owner"},
    },
    "send_checked": {"role": "Publisher", "action": "발송 결과 확인"},
}

_ROLE_ACTOR_KINDS = {"Creator": "agent", "Director": "human", "Publisher": "agent"}

# 0385·0395 문구 규칙 그대로(머리말 «워크플로우», {{label.*}}는 FE가 해소).
_BLOCK_TEMPLATE = {
    "blocks": [
        {"type": "header", "text": "뉴스레터 워크플로우"},
        {"type": "text", "text": "**{{label.stage}}** 단계로 넘어갔습니다"},
        {"type": "fields", "fields": [
            {"label": "대상", "value": "{{label.work_item_target}}"},
        ]},
    ],
}

_NAME = "뉴스레터"
_DESCRIPTION = (
    "소재 수집부터 발송 결과 확인까지 6단계예요. 내용 검수와 발송 두 곳만 사람이 승인하고, "
    "나머지는 에이전트가 진행해요."
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
        sa.text("DELETE FROM event_definitions WHERE key = :key AND org_id IS NULL"), {"key": _KEY},
    )
