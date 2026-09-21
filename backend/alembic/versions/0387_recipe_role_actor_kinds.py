"""story #4092(E-RECIPE-1 팔로우업, PO 확定 2026-09-21) — 리허설 1호 실측: Director(사람)
역할 stage(concept_confirmed·structure_passed·pending_approval)를 발행할 때마다 MCP
`publish_event` 응답에 «[경고] zero_reach …»가 매번 떴다. 이 stage들은 정의상 사람 역할이라
에이전트 바인딩이 없는 게 정상인데, 판정(`_publish_registry_event_core`)이 escalation·
broadcast count==0만 보고 "이 stage가 애초에 사람 담당이라 바인딩이 없는 게 정상"과 "정의
저자가 바인딩을 깜빡한 진짜 갭"을 구조적으로 구분 못 했다(원인 그라운딩: 디디, 2026-09-21).

## 처방(PO 확定 §b)
`role`은 recipe 저자 자유 문자열(고정 어휘 아님, recipe-role-slots.ts 기존 계약)이라 role
이름 자체로 사람/에이전트를 유도할 수 없다 — 정의가 자기 role 어휘에 맞게 선언하는 옵션
사전 `role_actor_kinds: {role명: "human"|"agent"}`을 새 nullable 컬럼으로 연다(block_template·
action_auth와 같은 형제 nullable 컬럼, story #4092 §b). 선언 없는 정의(레거시 전부)는 "모름"
= 오늘 zero_reach 동작 그대로(개선은 선언한 정의만, 회귀 0).

## 이 마이그가 하는 일
1. `event_definitions.role_actor_kinds`(JSONB, nullable) 컬럼 신설.
2. 레시피 1호(preset.marketing.video_production, org_id IS NULL)에 실제 role 값
   Creator/Compute/Publisher=agent · Director=human 선언, version+1.
   (역할별 유도 — PO 확定: "그 stage의 role(담당)이 사람인가 에이전트인가"이지 stage별
   손 매핑이 아니다. 0381/0382 role 값 4종 전수와 정확히 일치.)

Revision ID: 0387
Revises: 0386
Create Date: 2026-09-21

번호 조율(페드루 PO, 2026-09-21 07:08Z) — 디디군 #4090(1/2)이 0386을 먼저 씀 → 이 카드는
0387로, down_revision=0386. 착지 순서가 어긋나면(#4092가 먼저 착지) 그때 다시 조율.
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0387"
down_revision = "0386"
branch_labels = None
depends_on = None

_KEY = "preset.marketing.video_production"

_ROLE_ACTOR_KINDS = {
    "Creator": "agent",
    "Director": "human",
    "Compute": "agent",
    "Publisher": "agent",
}


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        "ALTER TABLE event_definitions ADD COLUMN role_actor_kinds JSONB"
    ))
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET role_actor_kinds = :role_actor_kinds, version = version + 1 "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {"role_actor_kinds": json.dumps(_ROLE_ACTOR_KINDS), "key": _KEY},
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET role_actor_kinds = NULL, version = version - 1 "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {"key": _KEY},
    )
    bind.execute(sa.text("ALTER TABLE event_definitions DROP COLUMN role_actor_kinds"))
