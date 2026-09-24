"""워크플로우 프리셋 8종에 역할별 사람/에이전트 선언(role_actor_kinds) · loop_agency 브리프 승인 자리(doc_approval)

Revision ID: 0403
Revises: 0402

story #4243(PO 확정 2026-09-24): 워크플로우 프리셋 8종에 `role_actor_kinds`가 없었다. 어휘에 `either`(사람도 에이전트도)를
더했지만, **사람이 그 stage를 끝낼 화면 경로**가 있어야만 사람 선언이 참이다(까디르 QA P1 · PO 판단 «반쪽 금지»):
- 규칙: human/either로 선언한 역할은 그 역할의 **모든 stage**에 사람 완료 경로(레시피 `gate` 승인 · 서버가 완료를 잇는 승인 자리
  `approval.surface = draft_gate`)가 있어야 한다. 클래스 가드 `test_4243_platform_role_actor_kinds_seed_realdb`가 강제한다.
- 워크플로우 8종의 stage에는 게이트가 없고, loop_agency 브리프의 `doc_approval`은 표시용 선언이라(레시피 stage를 잇는 훅 없음)
  **모든 역할에 사람 완료 경로가 없다** → 지금은 전부 `agent`로 선언한다(선언 없음과 적용 창 동작은 같고, 역할 kind가 명시된다).
- `either` 축소는 사람 완료 경로가 생길 때까지의 지름길이다 — story 4249(사람이 워크플로 stage를 끝낼 행동)가 착지하면 either로
  되돌리는 마이그레이션과 가드 확장이 따라온다.

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
    "preset.workflow.solo": {"Worker": "agent"},
    "preset.workflow.kanban": {"Member": "agent"},
    "preset.workflow.kanban_simple": {"Any": "agent", "Dev": "agent", "Lead": "agent"},
    "preset.workflow.scrum_3step": {"PO": "agent", "Dev": "agent", "QA": "agent"},
    "preset.workflow.two_step": {"Maker": "agent", "Reviewer": "agent"},
    "preset.workflow.three_step": {"Executor": "agent", "Reviewer": "agent", "Approver": "agent"},
    "preset.workflow.loop_agency": {"Human": "agent", "PO": "agent", "Agent": "agent", "Any": "agent"},
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
                "WHERE org_id IS NULL AND key = :key AND stage_metadata ? :stage AND NOT (stage_metadata->:stage ? 'gate') "
                # 멱등(까디르 QA P2) — 이미 같은 선언이면 version을 올리지 않는다.
                "  AND (stage_metadata->:stage->'approval') IS DISTINCT FROM CAST(:approval AS jsonb)"
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
