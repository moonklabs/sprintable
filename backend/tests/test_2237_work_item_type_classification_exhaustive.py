"""#2237(③): PROJECT_SCOPED_WORK_ITEM_TYPES/KNOWN_PROJECT_AGNOSTIC_WORK_ITEM_TYPES 분류가
「전량」을 커버하는지 고정한다.

⚠️이 테스트가 못 잡는 것 한 줄(오르테가 PO 요청, i18n 가드 #2228 선례와 동형): work_item_type은
DB CHECK도 Pydantic 검증기도 없는 varchar(20) 자유값이라(gate_type=GATE_TYPES와 비대칭 — 그 갭은
별도 스토리) 진짜 exhaustive 보장은 이 리포의 모든 create_gate() 호출부를 AST로 스캔해야 한다
(story #1808 PATH_ID axis 스캐너와 동형 무게). 이 테스트는 그 정도가 아니라 — 2026-07-27 기준
create_gate() 실 호출부 6곳을 손으로 읽어 나온 리터럴 목록을 고정한 것이다. 새 create_gate() 호출부가
새 work_item_type으로 생기면 이 테스트는 «못 잡는다»(수동 목록의 한계) — 그건 gate_service.py의
PROJECT_SCOPED_WORK_ITEM_TYPES/KNOWN_PROJECT_AGNOSTIC_WORK_ITEM_TYPES 자체가 손으로 갱신해야 하는
한계이지 이 테스트의 몫이 아니다. 이 테스트가 잡는 것은 「이미 알려진 8+1개 타입 중 하나가 실수로
분류에서 빠지는 것」뿐이다.
"""
from __future__ import annotations

import pytest


# 2026-07-27 기준 create_gate() 실 호출부 6곳에서 나온 work_item_type 리터럴 전량(손으로 읽음):
#   app/services/doc.py                       "doc"              (DOC_GATE_WORK_ITEM_TYPE)
#   app/routers/visual_artifacts.py            "visual_artifact"
#   app/services/merge_verdict_gate.py         "story"
#   app/services/loop.py                       "loop"
#   app/services/workflow_line_config.py       "wf_line_version"  (WORKFLOW_LINE_VERSION_WORK_ITEM_TYPE)
#   app/services/workflow_parallel_approval.py step_run.entity_type — 정의역(app/models/workflow_line.py
#                                               ENTITY_TYPES) = {story, doc, hypothesis, epic, sprint}
#   app/routers/gates.py 제네릭 create_gate_endpoint — task 포함(resolve_work_item_project_id가
#                                               지원하는 타입 중 "task"는 story #1968이 이미 project-
#                                               scoped로 분류해 뒀음. 실 create_gate() 호출부는 없지만
#                                               resolve_work_item_project_id/get_gate_endpoint가
#                                               다뤄야 하므로 이 전량에 포함한다.)
_KNOWN_PROJECT_SCOPED = frozenset(
    {"story", "task", "doc", "visual_artifact", "loop", "hypothesis", "epic", "sprint"}
)
_KNOWN_PROJECT_AGNOSTIC = frozenset({"wf_line_version"})


def test_project_scoped_set_matches_hand_audited_inventory():
    """gate_service.PROJECT_SCOPED_WORK_ITEM_TYPES가 위 손-감사 목록과 정확히 일치하는지 고정.
    누가 이 집합에서 하나를 실수로 빼면(또는 오분류로 KNOWN_PROJECT_AGNOSTIC에 넣으면) 이 테스트가
    즉시 빨개진다 — #2237이 기계적으로 확認한 project_id NOT NULL FK 근거가 조용히 사라지는 것을 막는다."""
    from app.services.gate_service import PROJECT_SCOPED_WORK_ITEM_TYPES
    assert PROJECT_SCOPED_WORK_ITEM_TYPES == _KNOWN_PROJECT_SCOPED


def test_project_agnostic_set_matches_hand_audited_inventory():
    from app.services.gate_service import KNOWN_PROJECT_AGNOSTIC_WORK_ITEM_TYPES
    assert KNOWN_PROJECT_AGNOSTIC_WORK_ITEM_TYPES == _KNOWN_PROJECT_AGNOSTIC


def test_the_two_sets_do_not_overlap():
    """한 타입이 «project를 가진다」와 «project가 없다」로 동시에 분류되면 그 자체가 모순."""
    from app.services.gate_service import (
        KNOWN_PROJECT_AGNOSTIC_WORK_ITEM_TYPES,
        PROJECT_SCOPED_WORK_ITEM_TYPES,
    )
    assert PROJECT_SCOPED_WORK_ITEM_TYPES & KNOWN_PROJECT_AGNOSTIC_WORK_ITEM_TYPES == frozenset()


@pytest.mark.parametrize("work_item_type", sorted(_KNOWN_PROJECT_SCOPED))
def test_resolve_work_item_project_id_has_explicit_branch_for_every_scoped_type(work_item_type):
    """PROJECT_SCOPED_WORK_ITEM_TYPES의 모든 타입은 resolve_work_item_project_id()가 실제 분기를
    가져야 한다 — 분류표엔 있는데 resolver가 여전히 모르면(폴백 None) fail-closed가 «항상 거부」로
    떨어져 그 타입 게이트 생성/조회가 통째로 죽는다(살아있는 기능을 죽이는 회귀 — ③이 이걸 막는다).
    소스를 읽어 `if work_item_type == "<타입>"` 리터럴 분기가 있는지 정적으로 확認한다(신규 쿼리 없음)."""
    import inspect
    from app.services.gate_service import resolve_work_item_project_id
    src = inspect.getsource(resolve_work_item_project_id)
    assert f'work_item_type == "{work_item_type}"' in src, (
        f"resolve_work_item_project_id에 {work_item_type!r} 분기가 없다 — "
        "PROJECT_SCOPED_WORK_ITEM_TYPES엔 있는데 resolver가 모르면 fail-closed가 그 타입을 "
        "항상 거부한다(생성/조회 전부 깨짐)."
    )
