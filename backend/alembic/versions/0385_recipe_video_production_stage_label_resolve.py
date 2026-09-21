"""story #4086(E-RECIPE-1, 유나 design 실측 2026-09-21) — 레시피 1호("영상 제작") 단계
알림 block_template이 raw stage enum·raw work_item 참조를 그대로 노출하던 결함 처방.

## 실측(리허설 1호 실화면)
- 레시피 대화의 단계 알림 카드가 «**draft** 로 넘어갔습니다»(raw stage slug, 영어 내부
  키)·«대상: story {uuid}»(raw work_item_type+uuid)를 그대로 보여줬다 — customer-zero가
  레시피를 켠 뒤 처음 보는 자리에서 내부어 0 캐논 정면 위반.

## 원인
`{{payload.stage}}`·`{{payload.work_item_type}} {{payload.work_item_id}}`를 그대로
렌더 — 0375/0376 preset이 이미 쓰는 `{{label.*}}` 해소 토큰(발행 시점에 고정된 원시
값을 렌더 시점 라벨로 해석, story #3881/#3884)을 이 정의만 안 썼다.

## 처방(신규 로직 0, 기존 해소 메커니즘 재사용만)
- `{{label.stage}}` — FE `event-block-card.tsx`가 `labels['stage']`를 새로 계산(이
  커밋과 짝인 FE 커밋)해 `recipe-stage-label.ts`(story #4049/#4082, 9 stage 전부
  등재된 그 SSOT 그대로, 두 번째 사전 발명 0)로 해소한다.
- `{{label.work_item_target}}` — `labels['work_item_target']`은 **이미 모든 이벤트에
  공통으로 계산되고 있었다**(story #3884, `refs.work_item` 기반 — preset 전용이
  아니라 `_publish_registry_event_core`의 단일 파이프를 타는 모든 발행이 다 받는다).
  이 정의도 그 파이프를 그대로 타므로 템플릿 텍스트만 그 토큰으로 바꾸면 FE 변경
  없이 바로 해소된다(실측: event-block-card.tsx의 기존 work_item_target 계산 블록에
  preset 조건문이 없음).

## AC3 — 이미 적용된 프로젝트 영향 0(구조적 근거)
이 마이그는 `event_definitions.block_template`(순수 렌더 템플릿)과 `version`만
UPDATE한다. `RecipeRoleBinding`(event_definition_key+stage로 조인)·`start-candidates`
(payload_schema.stage.enum + stage_metadata만 읽음, get_recipe_start_candidates/
_find_existing_stage_publish 둘 다 block_template 컬럼을 참조하지 않음, grep 확認)
전부 이 컬럼과 무관 — 데이터 마이그 0·바인딩·진행 상태 전후 동일이 스키마 구조상
보장된다(realdb round-trip 테스트가 그대로 pin).

Revision ID: 0385
Revises: 0384
Create Date: 2026-09-21
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0385"
down_revision = "0384"
branch_labels = None
depends_on = None

_KEY = "preset.marketing.video_production"

_OLD_BLOCK_TEMPLATE = {
    "blocks": [
        {"type": "header", "text": "영상 제작 레시피"},
        {"type": "text", "text": "**{{payload.stage}}** 로 넘어갔습니다"},
        {"type": "fields", "fields": [
            {"label": "대상", "value": "{{payload.work_item_type}} {{payload.work_item_id}}"},
        ]},
    ],
}

_NEW_BLOCK_TEMPLATE = {
    "blocks": [
        {"type": "header", "text": "영상 제작 레시피"},
        {"type": "text", "text": "**{{label.stage}}** 로 넘어갔습니다"},
        {"type": "fields", "fields": [
            {"label": "대상", "value": "{{label.work_item_target}}"},
        ]},
    ],
}


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET block_template = :block_template, version = version + 1 "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {"block_template": json.dumps(_NEW_BLOCK_TEMPLATE), "key": _KEY},
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET block_template = :block_template, version = version - 1 "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {"block_template": json.dumps(_OLD_BLOCK_TEMPLATE), "key": _KEY},
    )
