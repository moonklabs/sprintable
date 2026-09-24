"""워크플로우 프리셋 8종에 역할별 사람/에이전트 선언(role_actor_kinds) — 세 번째 값 `either`

Revision ID: 0403
Revises: 0402

story #4243(PO 확정 2026-09-24): 워크플로우 프리셋 8종에 `role_actor_kinds`가 없어, 범용 적용 창이 모든 역할을 에이전트로 묶어야만
적용됐다(loop_agency «Human»까지). PO 결정:
- 어휘에 `either`(사람도 에이전트도 맡는 자리 — 적용 창이 사람 + 에이전트를 함께 보여 줌)를 더한다.
- `human` = 이름부터 사람인 역할만(loop_agency «Human»), `agent` = 이름부터 에이전트인 역할만(agent_solo · loop_agency «Agent»).
- 그 밖의 일반 역할(Worker · Member · Any · Dev · Lead · PO · QA · Maker · Reviewer · Executor · Approver)은 전부 `either` —
  PO·QA가 에이전트인 조직(customer-zero)이 반례라 `human`으로 박지 않는다. «Any»도 선언 없음(폴백 = 에이전트 자리)이 아니라
  `either`로 명시한다.

이미 `role_actor_kinds`가 있는 정의는 건드리지 않는다(`IS NULL`일 때만 — 조직이 손댄 값 보존은 플랫폼 행이라 해당 없지만 재실행
안전). downgrade는 이 목록의 정의만 NULL로 되돌린다.
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0403"
down_revision = "0402"
branch_labels = None
depends_on = None

ROLE_ACTOR_KINDS: dict[str, dict[str, str]] = {
    "preset.workflow.agent_solo": {"Agent": "agent"},
    "preset.workflow.solo": {"Worker": "either"},
    "preset.workflow.kanban": {"Member": "either"},
    "preset.workflow.kanban_simple": {"Any": "either", "Dev": "either", "Lead": "either"},
    "preset.workflow.scrum_3step": {"PO": "either", "Dev": "either", "QA": "either"},
    "preset.workflow.two_step": {"Maker": "either", "Reviewer": "either"},
    "preset.workflow.three_step": {"Executor": "either", "Reviewer": "either", "Approver": "either"},
    "preset.workflow.loop_agency": {"Human": "human", "PO": "either", "Agent": "agent", "Any": "either"},
}


def upgrade() -> None:
    bind = op.get_bind()
    for key, kinds in ROLE_ACTOR_KINDS.items():
        bind.execute(
            sa.text(
                "UPDATE event_definitions SET role_actor_kinds = CAST(:kinds AS jsonb), version = version + 1 "
                "WHERE org_id IS NULL AND key = :key AND role_actor_kinds IS NULL"
            ),
            {"kinds": json.dumps(kinds), "key": key},
        )


def downgrade() -> None:
    bind = op.get_bind()
    for key, kinds in ROLE_ACTOR_KINDS.items():
        bind.execute(
            sa.text(
                "UPDATE event_definitions SET role_actor_kinds = NULL, version = version - 1 "
                "WHERE org_id IS NULL AND key = :key AND role_actor_kinds = CAST(:kinds AS jsonb)"
            ),
            {"kinds": json.dumps(kinds), "key": key},
        )
