"""워크플로우 프리셋 역할 선언을 PO 확정표(either · loop_agency Human = human)로 되돌린다 — 사람 완료 경로가 생겨서

Revision ID: 0407
Revises: 0406

story #4249(PO 확정 2026-09-24): 0403(story 4243)은 «사람이 그 stage를 끝낼 화면 경로가 없다»(까디르 QA P1)는 이유로 워크플로우
8종의 역할을 전부 `agent`로 줄였다 — «either 축소 = 지름길 · 4249에서 복원». 4249가 그 경로를 만들었다:
- 스토리 레시피 구역의 «이 단계 완료»(complete) · 게이트 승인 뒤 «다음 단계 시작»(start) — `POST /definitions/{id}/complete-stage`.
- 규칙은 `recipe_stage_completion.human_completion_path` 한 곳(클래스 가드 `test_4243_platform_role_actor_kinds_seed_realdb`가 같은
  함수를 읽는다).

그래서 4243 첫 판의 PO 표(commit 659287e20 · 0403 원안) 그대로 되돌린다. 에이전트 전용 역할(agent_solo의 Agent · loop_agency의
Agent)은 agent 그대로, loop_agency의 Human은 human.

0403 값 그대로인 행만 바꾼다(조직이 손대지 못하는 플랫폼 행이지만 재실행 · 다른 마이그레이션이 먼저 바꾼 경우 보존).
downgrade는 0403 값으로 되돌린다.

번호는 착지 순(PO 09:33Z 재배치): 4621 = 0405 · 4260(PR 4622) = 0406이 이 앞이라 down_revision은 0406이다(sibling 가드 회피 · PO 10:25Z). 그 둘이 들어가기 전까지 fresh DB에선 부모가 없어 RED인 것은 예상된 상태다 —
순서가 바뀌면 rebase 때 다시 옮긴다.
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0407"
down_revision = "0406"
branch_labels = None
depends_on = None

# 0403이 실은 값(줄인 값) — 이 값 그대로인 행만 되돌린다.
NARROWED: dict[str, dict[str, str]] = {
    "preset.workflow.agent_solo": {"Agent": "agent"},
    "preset.workflow.solo": {"Worker": "agent"},
    "preset.workflow.kanban": {"Member": "agent"},
    "preset.workflow.kanban_simple": {"Any": "agent", "Dev": "agent", "Lead": "agent"},
    "preset.workflow.scrum_3step": {"PO": "agent", "Dev": "agent", "QA": "agent"},
    "preset.workflow.two_step": {"Maker": "agent", "Reviewer": "agent"},
    "preset.workflow.three_step": {"Executor": "agent", "Reviewer": "agent", "Approver": "agent"},
    "preset.workflow.loop_agency": {"Human": "agent", "PO": "agent", "Agent": "agent", "Any": "agent"},
}

# PO 확정표(4243 첫 판 · commit 659287e20).
RESTORED: dict[str, dict[str, str]] = {
    "preset.workflow.agent_solo": {"Agent": "agent"},
    "preset.workflow.solo": {"Worker": "either"},
    "preset.workflow.kanban": {"Member": "either"},
    "preset.workflow.kanban_simple": {"Any": "either", "Dev": "either", "Lead": "either"},
    "preset.workflow.scrum_3step": {"PO": "either", "Dev": "either", "QA": "either"},
    "preset.workflow.two_step": {"Maker": "either", "Reviewer": "either"},
    "preset.workflow.three_step": {"Executor": "either", "Reviewer": "either", "Approver": "either"},
    "preset.workflow.loop_agency": {"Human": "human", "PO": "either", "Agent": "agent", "Any": "either"},
}


def _swap(source: dict[str, dict[str, str]], target: dict[str, dict[str, str]]) -> None:
    bind = op.get_bind()
    for key, kinds in target.items():
        if source[key] == kinds:
            continue
        bind.execute(
            sa.text(
                "UPDATE event_definitions SET role_actor_kinds = CAST(:kinds AS jsonb), version = version + 1 "
                "WHERE org_id IS NULL AND key = :key AND role_actor_kinds = CAST(:expected AS jsonb)"
            ),
            {"kinds": json.dumps(kinds), "expected": json.dumps(source[key]), "key": key},
        )


def upgrade() -> None:
    _swap(NARROWED, RESTORED)


def downgrade() -> None:
    _swap(RESTORED, NARROWED)
