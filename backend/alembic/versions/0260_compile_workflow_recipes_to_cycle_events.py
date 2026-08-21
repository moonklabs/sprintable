"""story #2792(2790 P1) — builtin 4종 + DB workflow_templates 4행을 사이클형 event_definitions
로 컴파일("워크플로우 엔티티를 이벤트층으로 흡수", 카드 §2 판정). 발명이 아니라 **기존 실물의
승격**(PO 확定 2026-08-19) — `workflow_recipes.py::_BUILTIN_RECIPES`(builtin)와
`workflow_templates`(DB, 0016 시드)의 steps를 그대로 stage enum + stage_metadata로 옮긴다.

⚠️실측 발견(이 마이그 작성 중) — 카드 §1이 "DB 템플릿 3행"이라 적었으나 **실제로는 4행**
(solo·two-step·three-step·kanban, 0016 확認)이고, 그중 **DB "solo"가 builtin "solo"를
슬러그 충돌로 그림자 처리**한다(`workflow_recipes.py::list_recipes()`가 db_slugs에 없는
builtin만 추가 — "solo"는 DB에 있어 builtin 쪽이 영원히 안 나온다). 지금까지 아무도 builtin
"solo"(Agent 1인 파이프라인)를 recipes 목록에서 본 적이 없다는 뜻 — recipes[0] 임의성보다
한 겹 더 깊은 은폐. 컴파일은 8건 전부(그림자 포함) 승격하되 키 충돌을 피하려 builtin 쪽을
`agent_solo`로 개명한다(DB 쪽은 원 슬러그 `solo` 유지 — 지금까지 실제로 도달 가능했던 쪽).

DB steps는 `pattern`(assign/submit/review)만 있고 자유서술 action이 없다(카드 §1 결함ⓑ와
동일 원인) — **발명 대신 기존 pattern을 최소 사전으로 옮긴다**(assign→담당자 배정 등,
아래 `_PATTERN_ACTION`). builtin steps는 이미 자유서술 action이 있어 그대로 옮긴다.

stage slug는 DB의 경우 pattern이 같은 recipe 안에서 중복될 수 있어(three-step의 review가
step_2/step_3 둘 다) `{pattern}_{role_ref}`로 유일화, builtin은 이미 고유한 `pattern`을
그대로 slug로 쓴다.

routing/block_template은 기존 `preset.work.status_changed`(0245/0249)와 동형 패턴 재사용
(새 어휘 발명 안 함) — work_item_stakeholders 방송, header+text+fields 3블록.

이번 커밋 범위: 컴파일+정본화까지. `workflow_recipes.py` 라우터·`workflow_templates`/
`_BUILTIN_RECIPES` 원본은 그대로 둔다(FE `loop-create-dialog.tsx` 등 3곳이 아직 소비 —
미르코군 FE 전환 확認 후 별도 커밋에서 은퇴, doc workflow-recipes-fe-consumption-map-2792
§3 순서 그대로).

Revision ID: 0260
Revises: 0259
Create Date: 2026-08-19
"""
from __future__ import annotations

import json
import uuid

import sqlalchemy as sa
from alembic import op

revision = "0260"
down_revision = "0259"
branch_labels = None
depends_on = None

_PATTERN_ACTION: dict[str, str] = {
    "assign": "담당자 배정",
    "submit": "제출",
    "review": "검토",
}

# builtin 4종 — workflow_recipes.py::_BUILTIN_RECIPES 그대로 옮김(순서·내용 동일, "solo"만
# 슬러그 충돌 회피로 agent_solo 개명).
_BUILTIN_RECIPES = [
    {
        "slug": "scrum_3step",
        "name": "3단계 스크럼",
        "description": "기획 → 개발 → QA 3단계 워크플로우. 소규모~중규모 스프린트에 적합.",
        "steps": [
            {"stage": "kickoff", "role": "PO", "action": "기능 명세 및 AC 작성"},
            {"stage": "implementation", "role": "Dev", "action": "코드 작성 및 PR 제출"},
            {"stage": "qa_review", "role": "QA", "action": "AC 체크리스트 검증 후 APPROVE/REJECT"},
        ],
    },
    {
        "slug": "kanban_simple",
        "name": "칸반 심플",
        "description": "할 일 → 진행 중 → 완료 단순 흐름. 지속적 딜리버리 환경에 적합.",
        "steps": [
            {"stage": "task_created", "role": "Any", "action": "백로그에서 작업 선택 및 claim"},
            {"stage": "in_progress", "role": "Dev", "action": "작업 수행 및 진행 상황 업데이트"},
            {"stage": "done_check", "role": "Lead", "action": "완료 기준 충족 여부 확인"},
        ],
    },
    {
        "slug": "agent_solo",
        "name": "솔로 에이전트",
        "description": "단일 에이전트가 전 단계를 처리. 간단한 자동화 태스크에 적합.",
        "steps": [
            {"stage": "received", "role": "Agent", "action": "이벤트 수신 후 컨텍스트 파악"},
            {"stage": "execute", "role": "Agent", "action": "태스크 수행 및 결과 생성"},
            {"stage": "report", "role": "Agent", "action": "결과 요약 후 채팅/메모로 보고"},
        ],
    },
    {
        "slug": "loop_agency",
        "name": "루프 에이전시",
        "description": "목표·가설 설정 → 브리프 → 실행안 생성 → 인간 선택 → 실행 → 성과 학습까지 "
                        "이어지는 복리 조직기억 워크플로우. 반복되는 실험(카피·캠페인 variant 등)에 적합.",
        "steps": [
            {"stage": "goal_hypothesis", "role": "Human", "action": "loop의 목표(goal)와 성과 가설(hypothesis)·측정 지표(metric)를 정의"},
            {"stage": "brief_doc_approval", "role": "PO", "action": "실행 계획을 브리프 문서로 작성하고 doc_approval 게이트를 통과"},
            {"stage": "generate_variants", "role": "Agent", "action": "brief를 바탕으로 복수의 실행안(variant)을 생성해 loop_artifacts로 등록"},
            {"stage": "loop_decision", "role": "Human", "action": "실행안 중 하나를 선택(choose)하고 이유를 기록·나머지는 반려(reject) 이유를 기록"},
            {"stage": "execute", "role": "Any", "action": "선택된 실행안을 외부(캠페인 발행·배포 등)에서 실행"},
            {"stage": "track_and_learn", "role": "Any", "action": "성과(GA4 등)를 측정해 outcome_snapshot으로 귀속하고, 다음 loop의 Context Pack에 이 loop의 선택·이유·성과가 학습 근거로 반영되게 한다"},
        ],
    },
]

# DB workflow_templates 4행(0016) — steps는 role_ref/default_label/pattern만, action 없음
# (_PATTERN_ACTION으로 최소 파생). slug는 f"{pattern}_{role_ref}"로 유일화.
_DB_RECIPES = [
    {
        "slug": "solo",
        "name": "Solo",
        "description": "1인 작업자. 할당 → 완료.",
        "steps": [{"pattern": "assign", "role_ref": "step_1", "default_label": "Worker"}],
    },
    {
        "slug": "two_step",
        "name": "Two-Step Review",
        "description": "제출 → 검토. 코드 리뷰, 디자인 검토, 원고 편집, 승인 등.",
        "steps": [
            {"pattern": "assign", "role_ref": "step_1", "default_label": "Maker"},
            {"pattern": "submit", "role_ref": "step_1", "default_label": "Maker"},
            {"pattern": "review", "role_ref": "step_2", "default_label": "Reviewer"},
        ],
    },
    {
        "slug": "three_step",
        "name": "Three-Step Pipeline",
        "description": "제출 → 1차 검토 → 2차 검토. PO-Dev-QA, 작성-편집-발행 등.",
        "steps": [
            {"pattern": "assign", "role_ref": "step_1", "default_label": "Executor"},
            {"pattern": "submit", "role_ref": "step_1", "default_label": "Executor"},
            {"pattern": "review", "role_ref": "step_2", "default_label": "Reviewer"},
            {"pattern": "review", "role_ref": "step_3", "default_label": "Approver"},
        ],
    },
    {
        "slug": "kanban",
        "name": "Kanban Flow",
        "description": "상태 전이 기반 알림. 역할 구분 없이 상태 변경 시 팀 알림.",
        "steps": [{"pattern": "assign", "role_ref": "step_1", "default_label": "Member"}],
    },
]


def _block_template(name: str) -> dict:
    return {
        "blocks": [
            {"type": "header", "text": name},
            {"type": "text", "text": "**{{payload.stage}}** 로 넘어갔습니다"},
            {"type": "fields", "fields": [
                {"label": "대상", "value": "{{payload.work_item_type}} {{payload.work_item_id}}"},
            ]},
        ],
    }


def _payload_schema(stage_slugs: list[str]) -> dict:
    # ⛔실버그(카디르군 QA, 2026-08-19) — work_item_type이 properties에만 있고 required엔
    # 없어, 기존 preset 2종(work.status_changed/assigned)과 비대칭이었다. routing.broadcast
    # 가 server_derived/work_item_stakeholders(type+id 짝으로 해석)인데 type이 optional이면
    # "stage+work_item_id만 있는" 스키마상 유효한 payload로 발행이 가능해져, 해석기가
    # type을 못 받아 zero-reach로 새는 경로가 구조적으로 열려 있었다 — required에 추가.
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["stage", "work_item_type", "work_item_id"],
        "properties": {
            "stage": {"type": "string", "enum": stage_slugs},
            "work_item_type": {"type": "string"},
            "work_item_id": {"type": "string", "format": "uuid"},
        },
    }


_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {
        "kind": "server_derived", "target": "work_item_stakeholders",
        "inherit_conversation_scope": True,
    },
}


def _rows():
    for r in _BUILTIN_RECIPES:
        stage_slugs = [s["stage"] for s in r["steps"]]
        stage_metadata = {s["stage"]: {"role": s["role"], "action": s["action"]} for s in r["steps"]}
        yield r["slug"], r["name"], r["description"], stage_slugs, stage_metadata
    for r in _DB_RECIPES:
        stage_slugs: list[str] = []
        stage_metadata: dict[str, dict] = {}
        for s in r["steps"]:
            slug = f"{s['pattern']}_{s['role_ref']}"
            if slug not in stage_metadata:  # 같은 pattern+role_ref 중복(assign+submit 동일 role) — 1건만.
                stage_slugs.append(slug)
                stage_metadata[slug] = {
                    "role": s["default_label"],
                    "action": _PATTERN_ACTION.get(s["pattern"], s["pattern"]),
                }
        yield r["slug"], r["name"], r["description"], stage_slugs, stage_metadata


def upgrade() -> None:
    conn = op.get_bind()
    for slug, name, description, stage_slugs, stage_metadata in _rows():
        key = f"preset.workflow.{slug}"
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
                "key": key,
                "name": name,
                "description": description,
                "payload_schema": json.dumps(_payload_schema(stage_slugs)),
                "routing": json.dumps(_ROUTING),
                "block_template": json.dumps(_block_template(name)),
                "stage_metadata": json.dumps(stage_metadata),
            },
        )


def downgrade() -> None:
    conn = op.get_bind()
    for slug, _name, _description, _stage_slugs, _stage_metadata in _rows():
        conn.execute(
            sa.text("DELETE FROM event_definitions WHERE org_id IS NULL AND key = :key"),
            {"key": f"preset.workflow.{slug}"},
        )
