"""story #4039(E-RECIPE-1 ①, 페드루 PO 킥오프 2026-09-18) — 마케팅 레시피 1호(«영상 제작») 프리셋
시드. 0260(_compile_workflow_recipes_to_cycle_events)이 튼 "레시피=사이클형 EventDefinition"
경로에 신규 key 1건을 추가하는 것뿐 — 새 체계가 아니다(0274/0259 선례와 동형, 발명 대신 기존
재사용).

앵커 — 이 정의가 실제로 신는 기존 메커니즘 3종(전부 이미 구현·검증된 계약, 이 마이그는 seed
데이터만):
  ①`stage_metadata[stage].gate`(event_definition_registry.validate_stage_metadata,
    story #3312) — 사람 승인 게이트. `recipe_gate_hooks.py::maybe_create_stage_gate`가
    stage 이벤트 발행 시 자동으로 pending Gate를 멱등 생성한다.
  ②`routing.broadcast.kind="recipe_role_binding"`(event_routing_resolver.py, story #3288)
    — stage별로 실제 담당 에이전트를 `recipe_role_bindings` 테이블(org/project 스코프)에서
    조회해 통지 대상으로 삼는다. 바인딩 자체는 `POST /events/definitions/{id}/apply`
    (`apply_recipe_role_bindings`, story #3288)가 채운다 — AC1의 "apply 가능"이 바로 이
    엔드포인트, 이 마이그는 그 엔드포인트가 먹을 EventDefinition 행 하나를 놓는 것.
  ③`stage_metadata[stage].capability`(story #3317 PR B) — "연산=모델 임대"·"발행자" 슬롯이
    실제로 쓸 커넥터 종류(kind)를 선언. apply 시점에 org_connector_registry 대조 warnings로
    느슨 검증(막지 않음, PO 확定).

게이트 4종 중 지금 실제로 seed에 박는 건 **2종뿐**(페드루 PO 후속 킥오프 #4044,
2026-09-18 06:16Z) — 유나군 엔진 실측: `gate_type` 실존은 `concept_approval`(#3561)·
`external_publish`(#3291) 둘뿐이고, ⓑ구조·ⓒ실탄은 gate_type 자체가 미존재라 #4044가 별도로
"구축"(신규 gate_type 확定+generation_budget.py/0333_gate_sealed_estimated_cost_minor.py
재사용 여부 판정)한다 — 이 카드가 지어내면 #4044의 근본 결정과 충돌·재작업이 난다. 그래서:
  ⓐ`concept_confirmed` stage만 `gate={"type":"concept_approval","approver":"org_owner"}`
    (story #3561 gate_type 그대로 재사용 — Gate.gate_type은 자유 String(50)이라 새 배선 없이
    재사용 가능, gate_service.create_gate()가 gate_type을 안 가리는 공용 chokepoint).
  ⓓ`pending_approval` stage만 `gate={"type":"external_publish","approver":"org_owner"}`
    (기존 channel_posts.py/site_posts.py가 이미 쓰는 전역 gate_type 재사용).
  ⓑ`structure_passed`·ⓒ`live_generation` 두 stage는 role/action/capability는 그대로 두되
    **`gate` 키를 아직 안 싣는다** — #4044가 gate_type을 確定하는 대로 그 카드의 자체
    마이그(§AC3 "①과 정합")가 이 두 stage_metadata에 `gate`를 얹는 후속 UPDATE를 낸다.

역할 슬롯 4종(카드 §AC2) — 디렉터(사람, 4게이트 전부의 approver="org_owner")·크리에이터
(에이전트, stage_metadata.role 표시+recipe_role_bindings로 stage→agent 바인딩)·연산(모델
임대, stage_metadata.capability로만 선언 — org member가 아니라 커넥터/모델이라
recipe_role_bindings 대상이 아님)·발행자(에이전트, 크리에이터와 동형으로 바인딩+capability
둘 다).

상태 9(카드 §AC2, 도크 19caa3f7 §1 그대로 슬러그화) — draft(초안)→concept_confirmed(컨셉確定,
ⓐ)→animatic(애니매틱)→structure_passed(구조통과, ⓑ)→live_generation(실탄생성, ⓒ)→
verification(검증)→editing(편집)→pending_approval(승인대기, ⓓ)→published(발행). "+분석"은
도크에서도 9개 밖 보너스 상태라 이번 시드엔 안 넣는다(비고 그대로 후속).

«마케팅» 분류(AC3) — 신규 컬럼을 추가하지 않고 기존 `key` 네임스페이스 축(`preset.{domain}.
{slug}`, 0245/0260/0274 선례 — 둘째 세그먼트가 도메인)을 그대로 재사용한다: 기존 개발
워크플로 프리셋은 전부 `preset.workflow.*`, 이 정의는 `preset.marketing.video_production`
— 세그먼트 자체가 "태그/kind 필드" 역할(FE 갈러리 필터는 `key.split(".")[1]`로 구분 가능,
CHECK 제약(`ck_event_definitions_key_namespace`)이 이미 이 축을 강제해 누구도 이 세그먼트를
비울 수 없다). 새 컬럼(신규 migration+백필)보다 기존 축 재사용이 이 코드베이스 관례(«정의=
데이터», 발명 금지)와 더 정합 — 유나군 FE가 실제로 다른 필드를 원하면 후속 카드에서 조정.

Revision ID: 0379
Revises: 0378
Create Date: 2026-09-18

⚠️번호 충돌 가능성(0274 선례와 동형 상황) — 이 워크트리 작성 시점에 origin/develop head는
0378이라 0379로 잡았으나, 같은 시각 열린 PR #4363(0379_organizations_external_publish_
pause.py)·#4364(0379_agent_run_cancel_protocol.py)도 같은 번호를 예약해 있었다(gh pr list
실측, 2026-09-18). 머지 순서에 따라 이 마이그가 rebase 대상이 될 수 있음 — sibling-PR 넘버링
가드가 잡으면 그때 재넘버링(0274 처방 그대로).
"""
from __future__ import annotations

import json
import uuid

import sqlalchemy as sa
from alembic import op

revision = "0379"
down_revision = "0378"
branch_labels = None
depends_on = None

_KEY = "preset.marketing.video_production"

_STAGE_SLUGS = [
    "draft",
    "concept_confirmed",
    "animatic",
    "structure_passed",
    "live_generation",
    "verification",
    "editing",
    "pending_approval",
    "published",
]

_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": _STAGE_SLUGS},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
    },
}

# story #3288 — recipe_role_bindings(stage→agent) 조회로 통지 대상을 푼다. escalation은
# 없음(게이트 승인 요청은 recipe_gate_hooks.py가 이 routing과 무관하게 별도 카드로 직접
# 보낸다 — dispatch_approval_request_cards, gate.approver 경로).
_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "recipe_role_binding"},
}

_STAGE_METADATA = {
    "draft": {
        "role": "크리에이터", "action": "로그라인·매핑표·컨셉 초안 작성",
    },
    "concept_confirmed": {
        "role": "디렉터", "action": "우화 비트↔제품 가치 매핑 + 미션 정합 확定 승인",
        "gate": {"type": "concept_approval", "approver": "org_owner"},
    },
    "animatic": {
        "role": "크리에이터", "action": "무과금 스틸+텍스트+VO 애니매틱 제작",
    },
    "structure_passed": {
        # ⚠️gate 미선언(#4044가 gate_type 確定 후 후속 UPDATE로 얹는다 — 마이그 docstring 참조).
        "role": "디렉터", "action": "무과금 애니매틱으로 구조 판정 승인",
    },
    "live_generation": {
        # ⚠️gate 미선언(#4044가 gate_type 確定 후 후속 UPDATE로 얹는다 — 마이그 docstring 참조).
        "role": "디렉터", "action": "표적·예산을 명시해 실탄(유료 생성) 발사 승인",
        "capability": {"kind": "generate"},
    },
    "verification": {
        "role": "크리에이터", "action": "프레임8+받아쓰기 등 눈·귀 검증 시트 작성",
    },
    "editing": {
        "role": "크리에이터", "action": "편집 통일 패스(그레이드·룸톤·자막 레벨 통일)",
    },
    "pending_approval": {
        "role": "발행자", "action": "최종 발행 승인 대기(외부 발행 직전)",
        "gate": {"type": "external_publish", "approver": "org_owner"},
    },
    "published": {
        "role": "발행자", "action": "승인된 채널에 실 게시",
        "capability": {"kind": "publish"},
    },
}

# 0260._block_template과 동형(header+text+fields 3블록, payload 3필드 그대로 치환).
_BLOCK_TEMPLATE = {
    "blocks": [
        {"type": "header", "text": "영상 제작 레시피"},
        {"type": "text", "text": "**{{payload.stage}}** 로 넘어갔습니다"},
        {"type": "fields", "fields": [
            {"label": "대상", "value": "{{payload.work_item_type}} {{payload.work_item_id}}"},
        ]},
    ],
}

_NAME = "영상 제작(릴스·쇼츠)"
_DESCRIPTION = (
    "BYOA 영상 제작 레시피 1호 — 소재 수집부터 발행까지 9단계, 사람 게이트 4곳"
    "(컨셉·구조·실탄예산·최종발행)만 사람이 딸깍하고 나머지 전이는 에이전트가 진행."
)


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            "INSERT INTO event_definitions "
            "(id, key, org_id, name, description, payload_schema, routing, block_template, "
            " stage_metadata, enabled, version) "
            "VALUES (:id, :key, NULL, :name, :description, CAST(:payload_schema AS jsonb), "
            " CAST(:routing AS jsonb), CAST(:block_template AS jsonb), CAST(:stage_metadata AS jsonb), "
            " true, 1) "
            "ON CONFLICT DO NOTHING"
        ),
        {
            "id": str(uuid.uuid4()),
            "key": _KEY,
            "name": _NAME,
            "description": _DESCRIPTION,
            "payload_schema": json.dumps(_PAYLOAD_SCHEMA),
            "routing": json.dumps(_ROUTING),
            "block_template": json.dumps(_BLOCK_TEMPLATE),
            "stage_metadata": json.dumps(_STAGE_METADATA),
        },
    )


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text("DELETE FROM event_definitions WHERE org_id IS NULL AND key = :key"),
        {"key": _KEY},
    )
