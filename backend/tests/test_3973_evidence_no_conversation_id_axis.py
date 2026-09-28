"""story #3973(E-UX-OVERHAUL·「대화」 3/N·BE, 맥락 패널 데이터 3) — 착수 前 그라운딩(2026-09-16)
결과 핀 테스트. 카드 원안은 `GET /api/v2/evidence`에 conversation_id/work_item_id 필터를
추가하라고 했는데, 실물 확인 결과:

  ① `Evidence` 모델(app/models/evidence.py)에 conversation_id 컬럼/FK 자체가 없다 —
     그 축은 "없음"이 정답이지 만들 대상이 아니다(카드 원문 "없는 축은 없음 1줄" 조항).
  ② `work_item_id`/`work_item_type` 축은 이미 `GET /api/v2/evidence`의 **필수**
     (Query(...), 기본값 없음) 파라미터로 배선돼 있다 — 무필터 호출 경로 자체가 없어
     추가할 신규 코드가 없다.

페드루 PO가 이 그라운딩(2026-09-16 17:19Z)을 그대로 확認·카드 스코프를 이 사실의 핀
테스트 1건으로 좁혔다(2026-09-17). HTTP·DB 0 — 순수 구조 검사만."""
from __future__ import annotations

import inspect

from app.models.evidence import Evidence
from app.routers.evidence import list_evidence


def test_evidence_model_has_no_conversation_id_column():
    assert not hasattr(Evidence, "conversation_id"), (
        "Evidence에 conversation_id 컬럼이 새로 생겼다 — 이 테스트는 그 축이 "
        "'없음'이라는 그라운딩 결론을 고정한다. 컬럼을 실제로 추가했다면 이 테스트를 "
        "고쳐 필터 배선까지 마저 하라(현재는 의도적으로 미지원)."
    )


def test_list_evidence_work_item_id_and_type_are_required_query_params():
    """work_item_id/work_item_type이 필수(기본값 없음)라 무필터 호출 경로가 구조적으로
    없다는 사실을 고정 — 라우트 시그니처가 이걸 optional로 바꾸면 이 테스트가 먼저
    빨개진다."""
    sig = inspect.signature(list_evidence)
    work_item_id_param = sig.parameters["work_item_id"]
    work_item_type_param = sig.parameters["work_item_type"]
    # Query(...)는 pydantic FieldInfo.is_required()가 True인 필수 파라미터 표식이다.
    assert work_item_id_param.default is not inspect.Parameter.empty
    assert work_item_id_param.default.is_required()
    assert work_item_type_param.default is not inspect.Parameter.empty
    assert work_item_type_param.default.is_required()
