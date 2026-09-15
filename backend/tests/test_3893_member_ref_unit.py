"""story #3893(E-UX-OVERHAUL·§⑤·Chat, PO 確定 2026-09-14) — `_render_event_notification_
member_ref` 순수 분기 단위테스트. `_render_event_notification_work_item_ref`의 mock
단위테스트(test_3884_target_ref_and_ui_copy.py)와 동형 패턴 — 실제 DB 대신
`resolve_member_display_name`(기존 SSOT, member_resolver.py)을 patch해 이 함수 자신의
두 갈래(찾음/못 찾음)만 격리 검증한다. member는 work_item과 달리 "리졸버 자체가 없는
타입" 갈래가 없다(항상 단일 리졸버) — 그래서 이 테스트는 2모양만 다룬다."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def test_found_returns_found_true_with_name():
    from app.routers.events import _render_event_notification_member_ref

    org_id = uuid.uuid4()
    member_id = uuid.uuid4()
    with patch(
        "app.services.member_resolver.resolve_member_display_name",
        new=AsyncMock(return_value="미르코"),
    ):
        result = await _render_event_notification_member_ref(
            AsyncMock(), org_id=org_id, member_id=member_id,
        )
    assert result == {"found": True, "name": "미르코"}


@pytest.mark.parametrize("resolved_name", [None, ""])
async def test_not_found_returns_found_false_without_inventing_name(resolved_name):
    """resolve_member_display_name이 None/빈 문자열(지어내지 않는다 원칙, member_resolver.py
    §714 docstring)을 돌려주면 raw id를 새지 않고 found:False로 떨어진다."""
    from app.routers.events import _render_event_notification_member_ref

    org_id = uuid.uuid4()
    member_id = uuid.uuid4()
    with patch(
        "app.services.member_resolver.resolve_member_display_name",
        new=AsyncMock(return_value=resolved_name),
    ):
        result = await _render_event_notification_member_ref(
            AsyncMock(), org_id=org_id, member_id=member_id,
        )
    assert result == {"found": False}


async def test_found_and_not_found_are_distinguishable_shapes():
    """work_item ref와 동일 계약 검증 — "찾음"과 "못 찾음"이 절대 같은 모양으로 안 뭉개진다
    (구조적 부재 vs 실패를 다른 모양으로 반환해야 한다는 #3884 원칙의 member 버전)."""
    from app.routers.events import _render_event_notification_member_ref

    org_id = uuid.uuid4()
    member_id = uuid.uuid4()
    with patch(
        "app.services.member_resolver.resolve_member_display_name",
        new=AsyncMock(return_value="디디"),
    ):
        found = await _render_event_notification_member_ref(AsyncMock(), org_id=org_id, member_id=member_id)
    with patch(
        "app.services.member_resolver.resolve_member_display_name",
        new=AsyncMock(return_value=None),
    ):
        not_found = await _render_event_notification_member_ref(AsyncMock(), org_id=org_id, member_id=member_id)
    assert found != not_found
    assert "name" in found and "name" not in not_found
