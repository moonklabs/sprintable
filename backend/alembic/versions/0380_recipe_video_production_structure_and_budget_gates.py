"""story #4044(E-RECIPE-1 ①, 페드루 PO 킥오프 2026-09-18 06:14Z) — 레시피 1호(«영상 제작»,
0379_preset_marketing_video_production_recipe.py)에 ⓑ구조·ⓒ실탄 게이트를 얹는다. 0379가
명시적으로 비워 둔 두 자리(ⓐ컨셉·ⓓ발행만 실존 gate_type 재사용, ⓑⓒ는 gate_type 미확定이라
미선언)를 이 카드가 채운다 — "①과 정합"(카드 §AC3).

유나 엔진 실측(이 카드 착수 시점) — gate_type 실존은 `concept_approval`(#3561)·
`external_publish`(#3291) 둘뿐. ⓑ`structure_approval`·ⓒ`generation_budget`은 이 마이그가
처음 쓰는 새 gate_type 문자열이다.

[[no-pr-for-data]] — 단, 이 UPDATE가 바꾸는 0379 행은 **아직 어느 develop에도 착지하지
않은 시드**(story #4039, PR #4419 in-review·페드루 PO가 배치 게이트로 보류 중)라 실
소비자가 없다. "이미 배포된 프리셋을 바꾸는" 부류의 위험(0330/0301 선례가 이 마커를 붙인
이유)이 이번엔 성립하지 않는다 — 그래도 마커째 남겨 리뷰어가 그 판단을 다시 확인할 수
있게 한다.

## 게이트 위치 — 유나 디자인 핸드셰이크(2026-09-18 06:32Z, doc 19caa3f7 §1-3 정본 대조) 그대로
페드루 PO가 앞서 「doc 9단계대로 시드하면 굳히고, 갈리면 라벨만 교체」로 確定한 채널이라,
0379 최초 초안이 잡았던 자리(ⓑ→`structure_passed`·ⓒ→`live_generation`)를 유나 확定안대로
한 stage씩 앞으로 옮긴다:
  - ⓑ`structure_approval` → **`animatic`** stage(③). "무과금 애니매틱을 막 만든 그 자리가
    구조 판정을 요청하는 자리" — ⓐ가 `concept_confirmed` 자신을 게이트하는 것과 달리, ⓑ는
    "이미 만든 결과물을 판정받는" 성격이라 그 결과물이 나온 stage 자신에 건다.
  - ⓒ`generation_budget` → **`structure_passed`** stage(④). "구조 판정을 이미 통과한 뒤,
    다음 유료 생성으로 넘어가기 직전에 예산을 승인" — doc §3 ⓒ 원문("애니매틱 통과 후 실탄
    진입 직전")과 정확히 일치.
  - `live_generation`(⑤)은 이제 게이트가 없다 — role도 Director가 아니라 **Compute**(0379
    쪽에서 이미 정정, 이 파일은 stage_metadata를 그대로 이어받는다)로, 승인이 끝난 뒤 실제
    모델 호출만 하는 stage.

## ⓑ 구조(애니매틱) 게이트 — 근본 선택: **신규 gate_type**(`structure_approval`), literal
`concept_approval` 재사용 아님
concept_approval 패턴(스키마 shape·검증 흐름)은 그대로 베끼지만 gate_type 문자열은
공유하지 않는다. 이유 — `Gate`의 멱등 키는 `(org_id, work_item_id, work_item_type,
gate_type[, pr_number, repo_full_name])`(0271/0272/0328)이다. 레시피 1호는 **같은
Story**가 `concept_confirmed`(ⓐ)와 `animatic`(ⓑ) 두 stage를 순서대로 지난다 — 둘 다
gate_type="concept_approval"이면 ⓐ가 approved로 봉인된 뒤 ⓑ가 그 "이미 승인된" 같은
슬롯을 재조회해(create_gate의 멱등 조회, gate.py 문서: "approved|rejected → 이 축에서는
불변") **ⓑ의 사람 판정 자체가 실행되지 않는다**(승인 없이 조용히 통과). 이건 발명이
아니라 기존 계약(멱등 키 unique index)이 이미 강제하는 사실을 따른 것 — "신규 gate_type"
쪽이 유일하게 안전한 선택.

## ⓒ 실탄(예산) 게이트 — 재사용 대상은 **메커니즘**(check_generation_budget_or_raise +
gate.sealed_estimated_cost_minor), gate_type 문자열은 신규
카드 제목의 "budget_gate 재사용"을 문자 그대로 읽으면 광고 `_ADS_BOOST_GATE_TYPE="ads_boost"`
(`app/services/ads_boost.py`)를 그대로 쓰라는 뜻처럼 보이지만, 그건 다른 도메인이다 —
`org_cost_summary.py`/`ads_spend_snapshots.py`가 `gate_type=="ads_boost"`인 행을 **광고
지출 집계**의 SSOT로 삼는다. 영상 생성비를 그 타입으로 기록하면 광고비 대시보드에 생성비가
섞여 든다(실측 결함 클래스). 그래서: gate_type은 `generation_budget`(카드 원 AC2 문구 그대로)
신규 문자열, 재사용은 ①`check_generation_budget_or_raise`(app/services/generation_budget.py,
0333 도입) 판정 프리미티브 ②`Gate.sealed_estimated_cost_minor`(0333) 컬럼 — 이 둘은 이미
gate_type을 안 가리는 범용 자리라 신규 배선 0(실 코드 변경은
`app/services/recipe_gate_hooks.py::maybe_create_stage_gate`에 gate_type=="generation_budget"
분기 하나, `app/routers/events.py::publish_registry_event`에 GenerationBudgetExceededError→
422 변환 하나뿐 — 둘 다 channel_posts.py/site_posts.py의 기존 계약 literal 재사용).

payload_schema에 `estimated_cost_minor`(선택, `["integer","null"]`) 신설 — 에이전트가
`structure_passed` stage 이벤트를 발행할 때 이 필드로 예상 비용을 실어야 그 값이 사람 승인
카드에 뜨고 사전 하드체크(잔량 초과 422)가 걸린다. 생략하면 `check_generation_budget_or_
raise`의 기존 규약대로 검사 자체가 스킵(AC2 "미설정이면 통과", 신규 규칙 0).

Revision ID: 0380
Revises: 0379
Create Date: 2026-09-18
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0380"
down_revision = "0379"
branch_labels = None
depends_on = None

_KEY = "preset.marketing.video_production"

_STAGE_SLUGS = [
    "draft", "concept_confirmed", "animatic", "structure_passed", "live_generation",
    "verification", "editing", "pending_approval", "published",
]

_OLD_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": _STAGE_SLUGS},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
    },
}

_NEW_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": _STAGE_SLUGS},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        # story #4044 — ⓒ 실탄 게이트 사전 하드체크·승인카드 표시용 선택 필드.
        "estimated_cost_minor": {"type": ["integer", "null"]},
    },
}

_OLD_STAGE_METADATA = {
    "draft": {
        "role": "Creator", "action": "로그라인·매핑표·컨셉 초안 작성",
    },
    "concept_confirmed": {
        "role": "Director", "action": "우화 비트↔제품 가치 매핑 + 미션 정합 확定 승인",
        "gate": {"type": "concept_approval", "approver": "org_owner"},
    },
    "animatic": {
        "role": "Creator", "action": "무과금 스틸+텍스트+VO 애니매틱 제작 후 구조 판정 요청",
    },
    "structure_passed": {
        "role": "Director", "action": "구조 판정 통과 확인 + 표적·예산 명시해 실탄 발사 승인",
    },
    "live_generation": {
        "role": "Compute", "action": "실탄(유료 생성) 모델(키컷·i2v·음성·립싱크) 호출",
        "capability": {"kind": "generate"},
    },
    "verification": {
        "role": "Creator", "action": "프레임8+받아쓰기 등 눈·귀 검증 시트 작성",
    },
    "editing": {
        "role": "Creator", "action": "편집 통일 패스(그레이드·룸톤·자막 레벨 통일)",
    },
    "pending_approval": {
        "role": "Director", "action": "최종 발행 승인(외부 발행 직전)",
        "gate": {"type": "external_publish", "approver": "org_owner"},
    },
    "published": {
        "role": "Publisher", "action": "승인된 채널에 실 게시",
        "capability": {"kind": "publish"},
    },
}

_NEW_STAGE_METADATA = {
    **_OLD_STAGE_METADATA,
    "animatic": {
        "role": "Creator", "action": "무과금 스틸+텍스트+VO 애니매틱 제작 후 구조 판정 요청",
        "gate": {"type": "structure_approval", "approver": "org_owner"},
    },
    "structure_passed": {
        "role": "Director", "action": "구조 판정 통과 확인 + 표적·예산 명시해 실탄 발사 승인",
        "gate": {"type": "generation_budget", "approver": "org_owner"},
    },
}


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET payload_schema = :payload_schema, stage_metadata = :stage_metadata, "
            " version = version + 1 "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {
            "payload_schema": json.dumps(_NEW_PAYLOAD_SCHEMA),
            "stage_metadata": json.dumps(_NEW_STAGE_METADATA),
            "key": _KEY,
        },
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET payload_schema = :payload_schema, stage_metadata = :stage_metadata, "
            " version = version - 1 "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {
            "payload_schema": json.dumps(_OLD_PAYLOAD_SCHEMA),
            "stage_metadata": json.dumps(_OLD_STAGE_METADATA),
            "key": _KEY,
        },
    )
