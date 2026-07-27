"""story #2010: sprintable_transition_goal MCP 도구 테스트.

목표 lifecycle 전이 전용 도구 — POST /api/v2/goals/{id}/transition 의 얇은 래퍼.
핵심 AC(가장 중요): line overlay 게이트가 개입해 백엔드가 200을 반환하면서도 실제로는
status를 바꾸지 않는(결재 대기) 케이스를 도구가 감지해 겉보기 성공과 명확히 구분해야 한다
(backend/app/services/goal.py:74-76 — enforcing 라인 → status 유지 채 200 반환).
"""
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sprintable_mcp.api_client import SprintableApiError
from sprintable_mcp.tools import goals as g


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _client(**methods):
    c = MagicMock()
    c.project_id = "proj-1"
    c.require_project_id = MagicMock(return_value="proj-1")
    for name, ret in methods.items():
        setattr(c, name, AsyncMock(return_value=ret))
    return c


def _error_client(exc: Exception):
    c = MagicMock()
    c.project_id = "proj-1"
    c.require_project_id = MagicMock(return_value="proj-1")
    c.post = AsyncMock(side_effect=exc)
    return c


# ── 1. active→done 정상 전이 ─────────────────────────────────────────────────

async def test_active_to_done_success_no_pending_note():
    client = _client(post={"id": "g1", "status": "done", "title": "T"})
    args = g.TransitionGoalInput(goal_id="g1", status=g.GoalStatus.done)
    with patch.object(g, "client", client):
        out = await g.transition_goal(args)
    assert client.post.call_args.args[0] == "/api/v2/goals/g1/transition"
    assert client.post.call_args.kwargs["json"] == {"status": "done"}
    data = json.loads(out[0].text)
    assert data["status"] == "done"
    assert data["transitioned"] is True
    assert "note" not in data


# ── 2. draft→active(에이전트 호출) — HUMAN_CONFIRM_REQUIRED 가독 노출 ─────────────

async def test_draft_to_active_human_confirm_required_readable():
    client = _error_client(
        SprintableApiError(403, "HUMAN_CONFIRM_REQUIRED: active(activation) 전이는 휴먼만 가능합니다.")
    )
    args = g.TransitionGoalInput(goal_id="g1", status=g.GoalStatus.active)
    with patch.object(g, "client", client):
        out = await g.transition_goal(args)
    text = out[0].text
    assert text.startswith("Error:")
    assert "HUMAN_CONFIRM_REQUIRED" in text
    assert "휴먼" in text


# ── 3. 불법 전이 — INVALID_EPIC_TRANSITION 가독 노출 ─────────────────────────────

async def test_invalid_transition_readable():
    client = _error_client(
        SprintableApiError(422, "INVALID_EPIC_TRANSITION: 불법 전이: done → draft")
    )
    args = g.TransitionGoalInput(goal_id="g1", status=g.GoalStatus.draft)
    with patch.object(g, "client", client):
        out = await g.transition_goal(args)
    text = out[0].text
    assert text.startswith("Error:")
    assert "INVALID_EPIC_TRANSITION" in text


# ── 4. 존재하지 않는 goal — EPIC_NOT_FOUND 가독 노출 ─────────────────────────────

async def test_nonexistent_goal_readable():
    client = _error_client(SprintableApiError(404, "EPIC_NOT_FOUND: 목표를 찾을 수 없습니다."))
    args = g.TransitionGoalInput(goal_id="does-not-exist", status=g.GoalStatus.done)
    with patch.object(g, "client", client):
        out = await g.transition_goal(args)
    text = out[0].text
    assert text.startswith("Error:")
    assert "EPIC_NOT_FOUND" in text


# ── 5. ⭐핵심 AC: overlay 게이트 silent-no-op 감지 ────────────────────────────────

async def test_overlay_gate_silent_no_op_flagged_as_pending():
    """enforcing 라인이 active→done 전이를 가로채면 백엔드는 200 + status='active'(미변경)를
    반환한다(goal.py transition_goal: gate 생성 + goal 그대로 반환, 예외 없음). 도구는 요청한
    status(done)와 응답 status(active)가 다름을 감지해 transitioned=False + 명확한 안내를 붙여야
    한다 — 절대 평범한 성공처럼 보이면 안 된다."""
    client = _client(post={"id": "g1", "status": "active", "title": "T"})  # 요청은 done, 응답은 active(미변경)
    args = g.TransitionGoalInput(goal_id="g1", status=g.GoalStatus.done)
    with patch.object(g, "client", client):
        out = await g.transition_goal(args)
    data = json.loads(out[0].text)
    assert data["status"] == "active"  # 실제로는 안 바뀜
    assert data["transitioned"] is False  # 평범한 성공이 아님을 명시
    assert data["requested_status"] == "done"
    assert "note" in data and data["note"]  # 사람이 읽을 안내 문구 존재
    # 응답이 결재 대기 상태임을 텍스트로 확인할 수 있어야 한다.
    assert "결재" in data["note"] or "대기" in data["note"]


# ── 6. 회귀: update_goal의 status 필드는 여전히 그대로 patch body에 실린다(변경 안 함) ──

async def test_update_goal_status_field_untouched_regression():
    """update_goal 자체는 이 story의 스코프가 아니다 — status 필드가 여전히 patch body에
    포함되는 기존 동작(백엔드가 422로 거부하는 것은 백엔드 책임)을 건드리지 않았음을 확인."""
    client = _client(patch={"id": "g1"})
    args = g.UpdateGoalInput(goal_id="g1", status=g.GoalStatus.done)
    with patch.object(g, "client", client):
        await g.update_goal(args)
    assert client.patch.call_args.args[0] == "/api/v2/goals/g1"
    assert client.patch.call_args.kwargs["json"] == {"status": "done"}
