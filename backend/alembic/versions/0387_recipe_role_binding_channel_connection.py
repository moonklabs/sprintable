"""story #4090([E-RECIPE-1] Publisher 슬롯) — `recipe_role_bindings`가 지금은
`agent_member_id NOT NULL` 하나뿐이라 "이 stage는 어느 팀원인가"만 표현한다. Publisher
stage(레시피 1호 `published`)는 알릴 사람이 아니라 **발행할 채널**을 가리켜야 해서
표현할 자리가 없었다(적용 다이얼로그 발행자 슬롯 선택지 0의 스키마 원인, 리허설 1호 ⑤
관찰). 페드루 PO 確定(2026-09-21) — 최소 확장: `channel_connection_id` NULL 컬럼
신설 + `agent_member_id`를 NULL 허용으로 전환하되, **"정확히 하나만 NOT NULL"은
DB CHECK로 박는다**(마이그=정본·모델=미러 관례 — 애플리케이션 강제만으로는 sealed_*
클래스처럼 샌다는 게 이 리포의 반복 학습).

`channel_connections.id`로의 FK는 의도적으로 안 건다 — `agent_member_id`도 FK가 없는
이 테이블 기존 관례(team_members는 VIEW라 FK 자체가 불가능한 선례, agent_member_id
컬럼 주석 없음 확認) 그대로 유지.

⛔ 판별축 정정(페드루 PO 2차 確定, 착수 中 발견) — 처음엔 `stage_metadata[stage].
capability.kind == 'publish'`로 채널-대상 여부를 가르려 했으나, 기존 회귀 테스트 7건
(test_3317b_recipe_capability_apply_check.py·test_3359_recipe_apply_resolver_realdb.py)
이 "kind='publish' + agent 바인딩 공존"(#3317 PR B, 에이전트가 그 커넥터를 쓸 준비가
됐는지 경고만 체크)을 이미 pin하고 있어 충돌했다. kind는 **열린 값**(조직이 뜻을 정하는
커넥터 종류)이라 target을 거기서 유도하면 그 기존 계약을 조용히 깬다. 처방 — capability
에 **닫힌 어휘** 서브필드 `target`(event_definition_registry.py::_CAPABILITY_TARGETS
= {"agent"(기본, 생략 시)|"channel_connection"}) 신설, `apply_recipe_role_bindings`는
이 필드만 본다(kind와 완전 독립). 이 마이그가 레시피 1호 `published` stage에만
`target: "channel_connection"`을 얹는다 — 그 외 정의는 무변(기본값이 오늘 계약 그대로).

Revision ID: 0387
Revises: 0386
Create Date: 2026-09-21
"""
from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "0387"
down_revision = "0386"
branch_labels = None
depends_on = None

_CHECK_NAME = "ck_recipe_role_bindings_exactly_one_target"
_CHECK_SQL = (
    "(agent_member_id IS NOT NULL AND channel_connection_id IS NULL) "
    "OR (agent_member_id IS NULL AND channel_connection_id IS NOT NULL)"
)

# 0382_recipe_video_production_structure_and_budget_gates.py의 _NEW_STAGE_METADATA를
# baseline으로 그대로 옮긴 것(develop HEAD 기준 현재 실 seed 값) — published 하나만
# capability.target을 얹는다.
_KEY = "preset.marketing.video_production"

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
        "gate": {"type": "structure_approval", "approver": "org_owner"},
    },
    "structure_passed": {
        "role": "Director", "action": "구조 판정 통과 확인 + 표적·예산 명시해 실탄 발사 승인",
        "gate": {"type": "generation_budget", "approver": "org_owner"},
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
    "published": {
        "role": "Publisher", "action": "승인된 채널에 실 게시",
        "capability": {"kind": "publish", "target": "channel_connection"},
    },
}


def upgrade() -> None:
    op.add_column(
        "recipe_role_bindings", sa.Column("channel_connection_id", UUID(as_uuid=True), nullable=True),
    )
    op.alter_column("recipe_role_bindings", "agent_member_id", nullable=True)
    op.create_check_constraint(_CHECK_NAME, "recipe_role_bindings", _CHECK_SQL)

    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions SET stage_metadata = :stage_metadata, version = version + 1 "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {"stage_metadata": json.dumps(_NEW_STAGE_METADATA), "key": _KEY},
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions SET stage_metadata = :stage_metadata, version = version - 1 "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {"stage_metadata": json.dumps(_OLD_STAGE_METADATA), "key": _KEY},
    )

    op.drop_constraint(_CHECK_NAME, "recipe_role_bindings", type_="check")
    op.execute("DELETE FROM recipe_role_bindings WHERE agent_member_id IS NULL")
    op.alter_column("recipe_role_bindings", "agent_member_id", nullable=False)
    op.drop_column("recipe_role_bindings", "channel_connection_id")
