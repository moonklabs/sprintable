"""story #3884(E-UX-OVERHAUL·§⑤·Chat·customer-zero) — 대화 이벤트 카드 「대상」 원시 UUID →
제목 참조 토큰(클릭 이동) + preset 고정 문구(헤더·필드 라벨·접속어) ko/en 한 벌.

AC1(d) 판별 규칙(PO 확定 2026-09-14 15:52Z) — `_render_event_notification_work_item_ref`가
「리졸버는 있는데 못 찾음(삭제·조직 밖)」과 「리졸버 자체가 없음(참조할 엔티티 개념이 구조적
으로 없음)」을 **다른 모양**으로 반환해야 한다: 전자는 `{"found": False, "type": ...}`
(FE가 렌더 시점에 `targetMissing` 문구를 짓는다 — 텍스트를 여기서 굽지 않는다), 후자는
`None`(호출부가 refs 키 자체를 안 심는다). 실사용 work_item_type 5종(story·task·doc·
visual_artifact·agent_decision·support_escalation, gate_service.py 리터럴 grep 실측)을
각각 found/not-found(리졸버 있는 4종만)·리졸버 없음(2종) 두 축으로 전수 검증한다.

`db`는 실제 Postgres 대신 `AsyncMock`으로 단일 쿼리 결과(scalar_one_or_none)를 고정한다 —
이 함수는 타입별로 정확히 한 번의 SELECT만 실행하므로(story/task/doc/visual_artifact 각
분기), 실DB 세팅 없이도 분기 로직 자체를 정확히 격리 검증할 수 있다(다른 세션의 실DB
비용 대비 이 함수의 관심사 — "어느 테이블을 보는가·soft-delete를 거르는가·entity_type
매핑이 맞는가" — 는 mock으로 충분히 가름된다)."""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_db(scalar_result):
    session = AsyncMock()
    session.execute = AsyncMock(return_value=SimpleNamespace(scalar_one_or_none=lambda: scalar_result))
    return session


# ============================================================================
# AC1(d) 5종 표 — 리졸버 있는 4종(found/not-found 둘 다) + 리졸버 없는 2종(None 고정).
# ============================================================================

@pytest.mark.parametrize(
    "work_item_type,title",
    [
        ("story", "결제 트랙 마이그레이션"),
        ("task", "결제 API 배선"),
        ("doc", "결제 트랙 설계서"),
        ("visual_artifact", "결제 흐름 목업"),
    ],
)
async def test_found_returns_found_true_with_reference_token(work_item_type, title):
    from app.routers.events import _render_event_notification_work_item_ref

    org_id = uuid.uuid4()
    work_item_id = uuid.uuid4()
    db = _mock_db(title)

    result = await _render_event_notification_work_item_ref(
        db, org_id=org_id, work_item_type=work_item_type, work_item_id=work_item_id,
    )

    assert result == {
        "found": True,
        "token": f"[{title}](entity:{'artifact' if work_item_type == 'visual_artifact' else work_item_type}:{work_item_id})",
    }


@pytest.mark.parametrize("work_item_type", ["story", "task", "doc", "visual_artifact"])
async def test_resolver_exists_but_row_not_found_returns_found_false_with_type(work_item_type):
    """삭제(soft-delete)·조직 밖 등 — title 쿼리가 빈 손으로 돌아온다(스칼라 None).
    텍스트를 여기서 굽지 않는다 — {"found": False, "type": ...} 구조만 낸다(AC1(d))."""
    from app.routers.events import _render_event_notification_work_item_ref

    org_id = uuid.uuid4()
    work_item_id = uuid.uuid4()
    db = _mock_db(None)

    result = await _render_event_notification_work_item_ref(
        db, org_id=org_id, work_item_type=work_item_type, work_item_id=work_item_id,
    )

    assert result == {"found": False, "type": work_item_type}


@pytest.mark.parametrize("work_item_type", ["agent_decision", "support_escalation"])
async def test_no_resolver_type_returns_none_without_querying_db(work_item_type):
    """참조할 «엔티티» 개념이 구조적으로 없는 타입 — DB에 쿼리 자체를 안 낸다(호출 0회
    확認, "찾아봤는데 없다"와 다른 판정임을 실측으로 고정)."""
    from app.routers.events import _render_event_notification_work_item_ref

    org_id = uuid.uuid4()
    work_item_id = uuid.uuid4()
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=AssertionError("리졸버 없는 타입은 쿼리를 내면 안 된다"))

    result = await _render_event_notification_work_item_ref(
        db, org_id=org_id, work_item_type=work_item_type, work_item_id=work_item_id,
    )

    assert result is None
    db.execute.assert_not_called()


async def test_found_false_and_none_are_distinguishable_shapes():
    """AC1(d) 핵심 — "구조적 부재"와 "실패"가 같은 모양으로 나오면 FAIL. 리졸버 있는데
    못 찾음(dict)과 리졸버 자체가 없음(None)을 같은 값으로 오인하면 이 assert가 깨진다
    (뮤테이션 셀프체크 대상 — found:False를 None으로 뭉개면 여기서 바로 RED)."""
    from app.routers.events import _render_event_notification_work_item_ref

    org_id = uuid.uuid4()
    work_item_id = uuid.uuid4()

    not_found = await _render_event_notification_work_item_ref(
        _mock_db(None), org_id=org_id, work_item_type="story", work_item_id=work_item_id,
    )
    no_resolver = await _render_event_notification_work_item_ref(
        AsyncMock(), org_id=org_id, work_item_type="agent_decision", work_item_id=work_item_id,
    )

    assert not_found is not None
    assert no_resolver is None
    assert not_found != no_resolver


# ============================================================================
# 평문 알림 줄(구계통) 어댑터 — _work_item_ref_token이 dict를 순 문자열로 얇게 벗겨낸다.
# ============================================================================

async def test_work_item_ref_token_extracts_token_when_found():
    from app.routers.events import _work_item_ref_token

    db = _mock_db("결제 트랙 마이그레이션")
    org_id, work_item_id = uuid.uuid4(), uuid.uuid4()

    token = await _work_item_ref_token(db, org_id=org_id, work_item_type="story", work_item_id=work_item_id)

    assert token == f"[결제 트랙 마이그레이션](entity:story:{work_item_id})"


async def test_work_item_ref_token_falls_back_to_none_when_not_found():
    """리졸버는 있는데 못 찾음(삭제 등) — 평문 알림 줄은 두 모양(found:False/None)을
    구분할 표면이 없으므로(AC1(d) 원칙, 구계통 어댑터의 존재 이유) 동일하게 None 합류."""
    from app.routers.events import _work_item_ref_token

    token = await _work_item_ref_token(
        _mock_db(None), org_id=uuid.uuid4(), work_item_type="story", work_item_id=uuid.uuid4(),
    )
    assert token is None


async def test_work_item_ref_token_falls_back_to_none_when_no_resolver():
    from app.routers.events import _work_item_ref_token

    token = await _work_item_ref_token(
        AsyncMock(), org_id=uuid.uuid4(), work_item_type="agent_decision", work_item_id=uuid.uuid4(),
    )
    assert token is None
