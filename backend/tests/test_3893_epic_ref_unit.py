"""story #3893 CHANGES②(PO PR#4298 리뷰 2026-09-15) — `_render_event_notification_
work_item_ref`의 "epic" 갈래(신설) 순수 분기 단위테스트. test_3884_target_ref_and_ui_
copy.py의 story/task/doc/visual_artifact 4종 패턴과 동형 — `Goal`(구 Epic)은
SoftDeleteMixin이 없어(app/models/pm.py 그라운딩) deleted_at 필터가 없는 유일한 분기라
그 차이가 결과 모양에 영향을 주지 않음(찾음/못찾음 두 모양은 다른 4종과 완전 동일 계약)을
확認한다."""
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


async def test_epic_found_returns_found_true_with_reference_token():
    from app.routers.events import _render_event_notification_work_item_ref

    org_id = uuid.uuid4()
    goal_id = uuid.uuid4()
    db = _mock_db("결제 트랙 완주")

    result = await _render_event_notification_work_item_ref(
        db, org_id=org_id, work_item_type="epic", work_item_id=goal_id,
    )
    assert result == {"found": True, "token": f"[결제 트랙 완주](entity:epic:{goal_id})"}


async def test_epic_not_found_returns_found_false_with_type():
    from app.routers.events import _render_event_notification_work_item_ref

    org_id = uuid.uuid4()
    goal_id = uuid.uuid4()
    db = _mock_db(None)

    result = await _render_event_notification_work_item_ref(
        db, org_id=org_id, work_item_type="epic", work_item_id=goal_id,
    )
    assert result == {"found": False, "type": "epic"}
