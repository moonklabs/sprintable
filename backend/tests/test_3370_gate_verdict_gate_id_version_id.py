"""story #3370 AC2(유나 실측 2026-09-10 13:23Z, 페드루 전달) — 에이전트 수신 채널
(`_render_gate_verdict_message`)이 게이트를 **종류로만**(`- 게이트: {type} → {verdict}`)
표기하고 있었고, "version" 자리엔 실제로 `draft_id`(초안 자체 식별자)가 찍히고 있었다 —
AC2가 요구하는 「gate ID·version ID·판정 상태」 중 gate ID는 사람이 읽는 줄로 한 번도
안 나갔고, version ID는 draft_id로 오독될 자리에 있었다.

헬퍼는 test_3387_gate_verdict_agent_next_action.py 것을 그대로 재사용한다(재발명 금지) —
이 파일의 관심사는 그 헬퍼로 만든 렌더 결과에 `gate_id`/`version_id` 줄이 정확히 서고,
`draft_id`와 값이 다른(같은 게이트 안에서도 서로 다른 축이라는) 것을 잡는 것뿐이다."""
from __future__ import annotations

import uuid

import pytest

from tests.test_3387_gate_verdict_agent_next_action import (
    _FakeGateRow,
    _payload,
    _render,
)

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _stub_work_item_ref(monkeypatch):
    """pytest autouse fixture는 정의된 모듈에서만 자동 적용된다 — test_3387의 것을
    import만 해선 안 걸려서(TypeError: 확인됨) 여기서도 등록한다. 로직은 그 파일의
    사본 그대로(재발명 아님, fixture 배선의 필연적 반복)."""
    from app.routers import events as events_module

    async def _fake_ref(*_args, **_kwargs):
        return "[제목](entity:story:11111111-1111-1111-1111-111111111111)"

    monkeypatch.setattr(events_module, "_render_event_notification_work_item_ref", _fake_ref)


async def test_gate_id_line_is_the_actual_gate_id_from_payload():
    """AC2 — 「게이트: {type} → {verdict}」만으론 어느 게이트인지 알 수 없었다(종류만
    표기). payload.gate_id(story #3487, 유일한 발행부가 항상 채움) 그대로 줄로 찍힌다."""
    gate_id = str(uuid.uuid4())
    text = await _render(
        _payload(gate_type="external_publish", verdict="approved", gate_id=gate_id),
        gate_row=_FakeGateRow({}, id_=uuid.UUID(gate_id)),
    )
    assert f"- gate_id: {gate_id}" in text


async def test_version_id_line_distinct_from_draft_id_not_conflated():
    """핵심 회귀 — version_id와 draft_id는 다른 축(초안 자체 vs 그 초안의 특정 승인된
    버전)이다. 고치기 전엔 version 자리가 아예 없어 draft_id가 그 역할을 대신하는
    것처럼 읽혔다 — 이제 둘 다, 서로 다른 값으로 나란히 선다."""
    draft_id = str(uuid.uuid4())
    version_id = str(uuid.uuid4())
    assert draft_id != version_id  # 표본 전제 — 실제로 다른 UUID임을 못박는다.
    gate_row = _FakeGateRow({"draft_id": draft_id, "version_id": version_id})
    text = await _render(
        _payload(gate_type="external_publish", verdict="approved"), gate_row=gate_row,
    )
    assert f"- draft_id: {draft_id}" in text
    assert f"- version_id: {version_id}" in text
    # 뮤테이션 킬 포인트 — draft_id 값이 version_id 줄로 새 나가면(과거 오독 재발) 잡는다.
    assert f"- version_id: {draft_id}" not in text


async def test_version_id_absent_when_neutral_facts_missing_it_no_error():
    """구버전 게이트(이 스토리 착지 前 생성돼 neutral_facts에 version_id가 없는 행)는
    그 줄만 조용히 생략한다(지어내지 않는다) — draft_id처럼 값 없으면 줄 자체가 없다."""
    gate_row = _FakeGateRow({"draft_id": str(uuid.uuid4())})
    text = await _render(
        _payload(gate_type="external_publish", verdict="approved"), gate_row=gate_row,
    )
    assert "version_id" not in text


async def test_no_gate_row_omits_both_gate_id_and_version_id_lines_gracefully():
    """gate_row 재조회 자체가 실패(옛 payload·레거시 큐 재생 등)해도 gate_id 줄은
    payload에서, version_id 줄은 gate_row 없이는 안 뜨는 것으로 각자 정직하게 갈린다."""
    gate_id = str(uuid.uuid4())
    text = await _render(
        _payload(gate_type="external_publish", verdict="approved", gate_id=gate_id),
        gate_row=None,
    )
    assert f"- gate_id: {gate_id}" in text  # payload 값이라 gate_row 무관하게 선다.
    assert "version_id" not in text
