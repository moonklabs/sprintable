"""story #183fe7a5(지원v1·후속) — gate_service.py::transition_gate()가 support_escalation
게이트를 approve/reject할 때마다 escalation_resolution_delivery를 실제로 부르는지(배선
자체)를 겨냥한다. AsyncMock 세션 패턴은 tests/test_e_cage_referee_p3_gate_object.py의
test_transition_valid_pending_to_approved와 동형(session 전체를 AsyncMock으로 흉내 —
transition_gate 내부 다른 부작용 호출들은 이미 그 파일에서 이 패턴으로 검증돼 안전이
확인됨, 배달 함수만 monkeypatch로 관측)."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
GATE_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_session_for_gate(gate):
    session = AsyncMock()
    gate_r = MagicMock()
    gate_r.scalar_one_or_none.return_value = gate
    session.execute = AsyncMock(return_value=gate_r)
    session.flush = AsyncMock()
    session.refresh = AsyncMock()
    return session


def _support_escalation_gate(*, escalation_id: uuid.UUID) -> MagicMock:
    gate = MagicMock()
    gate.id = GATE_ID
    gate.org_id = ORG_ID
    gate.status = "pending"
    gate.work_item_type = "support_escalation"
    gate.neutral_facts = {"support_escalation_id": str(escalation_id)}
    return gate


@pytest.mark.anyio
async def test_approve_triggers_escalation_resolution_delivery():
    from app.services.gate_service import transition_gate

    escalation_id = uuid.uuid4()
    gate = _support_escalation_gate(escalation_id=escalation_id)
    session = _mock_session_for_gate(gate)

    with patch(
        "app.services.escalation_resolution_delivery.deliver_escalation_resolution_for_gate",
        new_callable=AsyncMock,
    ) as delegate:
        await transition_gate(session, ORG_ID, GATE_ID, "approved", MEMBER_ID)

    delegate.assert_awaited_once()
    _, kwargs = delegate.call_args
    assert kwargs["gate"] is gate
    assert kwargs["new_status"] == "approved"


@pytest.mark.anyio
async def test_reject_also_triggers_escalation_resolution_delivery():
    """⭐AC2 pin — reject도 approve와 동일하게 동기화 훅이 발화한다(위젯 배너 영구 고정
    버그가 reject 경로에서 재발하지 않게)."""
    from app.services.gate_service import transition_gate

    escalation_id = uuid.uuid4()
    gate = _support_escalation_gate(escalation_id=escalation_id)
    session = _mock_session_for_gate(gate)

    with patch(
        "app.services.escalation_resolution_delivery.deliver_escalation_resolution_for_gate",
        new_callable=AsyncMock,
    ) as delegate:
        # story #3334 — transition_gate("rejected")가 이제 사유 필수(서비스층 강제). 이
        # 테스트의 관심사(escalation 동기화 훅 발화)와 무관하므로 명시로 실어 대상 밖임을 밝힌다.
        await transition_gate(session, ORG_ID, GATE_ID, "rejected", MEMBER_ID, "에스컬레이션 재현 사유")

    delegate.assert_awaited_once()
    _, kwargs = delegate.call_args
    assert kwargs["new_status"] == "rejected"


@pytest.mark.anyio
async def test_non_support_escalation_gate_does_not_trigger_delivery():
    """오배선 방지 pin — 다른 gate_type(예: story merge 게이트) approve는 이 새 훅을 절대
    안 태운다(work_item_type 분기가 정확히 지켜지는지)."""
    from app.services.gate_service import transition_gate

    gate = MagicMock()
    gate.id = GATE_ID
    gate.org_id = ORG_ID
    gate.status = "pending"
    gate.work_item_type = "story"
    session = _mock_session_for_gate(gate)

    with patch(
        "app.services.escalation_resolution_delivery.deliver_escalation_resolution_for_gate",
        new_callable=AsyncMock,
    ) as delegate:
        await transition_gate(session, ORG_ID, GATE_ID, "approved", MEMBER_ID)

    delegate.assert_not_awaited()


@pytest.mark.anyio
async def test_delivery_failure_does_not_break_the_transition():
    """AC3 pin — 동기화 배달이 예외를 던져도 게이트 전이(approve) 자체는 성공한다
    (gate_service.py의 기존 try/except 관례, notify_gate_card_recipients_resolved와 동형)."""
    from app.services.gate_service import transition_gate

    escalation_id = uuid.uuid4()
    gate = _support_escalation_gate(escalation_id=escalation_id)
    session = _mock_session_for_gate(gate)

    with patch(
        "app.services.escalation_resolution_delivery.deliver_escalation_resolution_for_gate",
        new_callable=AsyncMock,
        side_effect=RuntimeError("gateway unreachable"),
    ):
        result = await transition_gate(session, ORG_ID, GATE_ID, "approved", MEMBER_ID)

    assert result.status == "approved"  # 전이 자체는 정상 완료 — 배달 실패가 안 깨뜨림.
