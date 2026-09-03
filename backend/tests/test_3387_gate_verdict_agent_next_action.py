"""story #3387(결함·오도 문구, PO 2026-09-03 13:33Z 스코프 확定) — 담롱 온찬 실사례 5건
(2026-09-03) 전부 `_render_gate_verdict_message`(agent-only MCP 표면)의 옛 문구와 문자
그대로 일치했다: verdict만 보고 gate_type을 안 봐 approved에 제품에 없는 «발행 도구»를
권했고(사례 1~4), «폐기 대상» rejected에 재상신을 권해 결정과 정반대 행동을 시켰다(사례 5).

여기서는 `_render_gate_verdict_message`를 mock db(실 Postgres 없이)로 직접 호출해 새
gate_type=external_publish 분기만 좁게 잰다 — 실전 통합 경로(발행→work item assignee
도달)는 test_3330_gate_verdict_notification.py가 이미 realdb로 덮는다.

AC5 — 뮤테이션: has_discontinue_signal 호출을 지우면 "사례 5" 테스트가 RED로 바뀐다."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock

import pytest

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _FakeGateRow:
    def __init__(self, neutral_facts: dict | None):
        self.neutral_facts = neutral_facts


class _FakeResult:
    def __init__(self, row):
        self._row = row

    def scalar_one_or_none(self):
        return self._row


def _fake_db(gate_row=None):
    db = AsyncMock()
    db.execute = AsyncMock(return_value=_FakeResult(gate_row))
    return db


def _payload(*, gate_type: str, verdict: str, resolution_note: str | None = None) -> dict:
    return {
        "work_item_type": "story",
        "work_item_id": str(uuid.uuid4()),
        "gate_type": gate_type,
        "verdict": verdict,
        "resolution_note": resolution_note,
    }


@pytest.fixture(autouse=True)
def _stub_work_item_ref(monkeypatch):
    from app.routers import events as events_module

    async def _fake_ref(*_args, **_kwargs):
        return "[제목](entity:story:11111111-1111-1111-1111-111111111111)"

    monkeypatch.setattr(events_module, "_render_event_notification_work_item_ref", _fake_ref)


async def _render(payload: dict, gate_row=None) -> str:
    from app.routers.events import _render_gate_verdict_message

    return await _render_gate_verdict_message(_fake_db(gate_row), org_id=uuid.uuid4(), payload=payload)


class TestExternalPublishAgentNextAction:
    async def test_approved_gives_no_task_text_not_publish_tool(self):
        # 사례 1~4 — 승인 카드가 제품에 없는 «발행 도구»를 더 이상 권하지 않는다.
        text = await _render(_payload(gate_type="external_publish", verdict="approved"))
        assert "발행 도구" not in text
        assert "- 다음 행동: 할 일 없음 — 발행은 휴먼이 화면에서 합니다." in text

    async def test_rejected_with_discontinue_signal_has_no_next_action_line_at_all(self):
        # 사례 5 — 「발행 금지·폐기 대상」으로 반려했는데 재상신을 권하던 모순을 없앤다.
        # 침묵도 문구다: "다음 행동" 줄 자체가 없어야 한다(빈 값이 아니라 렌더 자체 없음).
        text = await _render(_payload(
            gate_type="external_publish", verdict="rejected", resolution_note="발행 금지·폐기 대상",
        ))
        assert "다음 행동" not in text
        assert "자동 재오픈" not in text
        assert "다시 발행하세요" not in text

    async def test_rejected_without_signal_gives_no_task_text_not_a_directive(self):
        text = await _render(_payload(
            gate_type="external_publish", verdict="rejected", resolution_note="제목 오타 수정 필요",
        ))
        assert "- 다음 행동: 할 일 없음 — 다시 올릴지는 작성자가 정합니다." in text

    async def test_rejected_signal_is_keyword_based_not_a_blanket_reason_suppression(self):
        # "제목 오타 수정 필요"는 신호가 없어 문구가 뜬다(위 테스트) — "중단"이 들어간
        # 사유만 신호로 잡혀야 한다(과탐 방지, gate_reason_signal.py 자체 규율).
        text = await _render(_payload(
            gate_type="external_publish", verdict="rejected", resolution_note="당분간 중단합니다",
        ))
        assert "다음 행동" not in text

    async def test_execution_verbs_are_absent_from_both_agent_branches(self):
        approved_text = await _render(_payload(gate_type="external_publish", verdict="approved"))
        rejected_text = await _render(_payload(
            gate_type="external_publish", verdict="rejected", resolution_note="사유 없이 반려",
        ))
        for verb in ("누르세요", "쓰세요", "발행하세요", "재상신하세요"):
            assert verb not in approved_text
            assert verb not in rejected_text

    async def test_draft_id_surfaces_as_plain_reference_not_a_link(self):
        draft_id = str(uuid.uuid4())
        gate_row = _FakeGateRow({"draft_id": draft_id})
        text = await _render(
            _payload(gate_type="external_publish", verdict="approved"), gate_row=gate_row,
        )
        assert f"- draft_id: {draft_id}" in text
        assert "http" not in text  # 참조이지 링크가 아니다.

    async def test_no_neutral_facts_omits_draft_id_line_without_erroring(self):
        text = await _render(_payload(gate_type="external_publish", verdict="approved"), gate_row=None)
        assert "draft_id" not in text


class TestOtherGateTypesUnchanged:
    """story #3387 회귀 0 — external_publish 이외 gate_type(예: qa/deploy/merge/pr_review·
    레시피 파이프라인)은 옛 문구를 그대로 유지한다."""

    async def test_non_external_publish_approved_keeps_old_publish_tool_text(self):
        text = await _render(_payload(gate_type="qa", verdict="approved"))
        assert "발행 도구" in text
        assert "할 일 없음" not in text

    async def test_non_external_publish_rejected_keeps_old_resubmit_text(self):
        text = await _render(_payload(gate_type="qa", verdict="rejected", resolution_note="폐기 대상"))
        assert "다시 발행하세요" in text
        assert "자동 재오픈됩니다" in text
