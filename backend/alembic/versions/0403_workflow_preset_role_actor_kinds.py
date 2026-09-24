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

D3(PO 결정 ①): loop_agency `brief_doc_approval`(action «브리프 문서를 쓰고 문서 결재를 받는다»)은 게이트 선언이 없어 적용 창이
담당을 요구했다. 승인은 결재함의 **문서 결재**에서 일어나므로 4174 후속의 승인 자리 선언과 같은 모양으로
`approval: {"surface": "doc_approval"}`를 싣는다(닫힌 어휘에 `doc_approval` 추가 · 레시피 게이트 이중 선언은 쓰지 않음). 그 한
경로만 `jsonb_set`으로 바꾼다(0400 `action_i18n` 등 나머지 그대로).

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


APPROVALS: dict[tuple[str, str], str] = {
    ("preset.workflow.loop_agency", "brief_doc_approval"): "doc_approval",
}


def upgrade() -> None:
    bind = op.get_bind()
    for (key, stage), surface in APPROVALS.items():
        bind.execute(
            sa.text(
                "UPDATE event_definitions "
                "SET stage_metadata = jsonb_set(stage_metadata, CAST(:path AS text[]), CAST(:approval AS jsonb), true), "
                "    version = version + 1 "
                "WHERE org_id IS NULL AND key = :key AND stage_metadata ? :stage AND NOT (stage_metadata->:stage ? 'gate')"
            ),
            {"path": "{%s,approval}" % stage, "approval": json.dumps({"surface": surface}), "key": key, "stage": stage},
        )
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
    for (key, stage), surface in APPROVALS.items():
        bind.execute(
            sa.text(
                "UPDATE event_definitions SET stage_metadata = stage_metadata #- CAST(:path AS text[]), version = version - 1 "
                "WHERE org_id IS NULL AND key = :key AND stage_metadata->:stage->'approval'->>'surface' = :surface"
            ),
            {"path": "{%s,approval}" % stage, "key": key, "stage": stage, "surface": surface},
        )
    for key, kinds in ROLE_ACTOR_KINDS.items():
        bind.execute(
            sa.text(
                "UPDATE event_definitions SET role_actor_kinds = NULL, version = version - 1 "
                "WHERE org_id IS NULL AND key = :key AND role_actor_kinds = CAST(:kinds AS jsonb)"
            ),
            {"kinds": json.dumps(kinds), "key": key},
        )
