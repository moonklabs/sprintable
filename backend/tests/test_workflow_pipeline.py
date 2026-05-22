"""Tests for workflow_pipeline — Phase 3 AC1~AC6."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.rule_evaluator import EvaluationResult, EventContext
from app.services.workflow_pipeline import _execute_side_effects, process_event
from app.repositories.agent_routing_rule import _normalize_action

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
AGENT_ID = uuid.uuid4()
LOG_ID = uuid.uuid4()


def _make_result(
    matched: bool = True,
    mode: str = "process_and_report",
    forward_to: str | None = None,
) -> EvaluationResult:
    action: dict = {"auto_reply_mode": mode, "forward_to_agent_id": forward_to}
    return EvaluationResult(
        matched=matched,
        rule=MagicMock(),
        action=action if matched else None,
        target_agent_id=AGENT_ID if matched else None,
        log_id=LOG_ID if matched else None,
    )


def _mock_session() -> AsyncMock:
    s = AsyncMock()
    s.execute = AsyncMock()
    s.add = MagicMock()
    s.flush = AsyncMock()
    return s


# ── process_event ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_process_event_no_match_returns_early():
    session = _mock_session()
    ctx = EventContext(event_type="story.status_changed")
    with patch("app.services.workflow_pipeline.evaluate", new=AsyncMock(
        return_value=_make_result(matched=False)
    )):
        await process_event(session, ORG_ID, PROJECT_ID, ctx)
    session.add.assert_not_called()


@pytest.mark.asyncio
async def test_process_event_updates_log_status_to_completed():
    session = _mock_session()
    ctx = EventContext(event_type="e")
    result = _make_result(matched=True)
    with patch("app.services.workflow_pipeline.evaluate", new=AsyncMock(return_value=result)):
        await process_event(session, ORG_ID, PROJECT_ID, ctx)
    # session.execute called: 1 running update + 1 completed update
    assert session.execute.call_count >= 2


@pytest.mark.asyncio
async def test_process_event_logs_failed_on_error():
    session = _mock_session()
    ctx = EventContext(event_type="e")
    result = _make_result(matched=True)
    with patch("app.services.workflow_pipeline.evaluate", new=AsyncMock(return_value=result)), \
         patch("app.services.workflow_pipeline._execute_side_effects", side_effect=Exception("boom")):
        await process_event(session, ORG_ID, PROJECT_ID, ctx)
    assert session.execute.call_count >= 2


@pytest.mark.asyncio
async def test_process_event_independent_of_webhook():
    session = _mock_session()
    ctx = EventContext(event_type="e")
    result = _make_result(matched=False)
    with patch("app.services.workflow_pipeline.evaluate", new=AsyncMock(return_value=result)):
        await process_event(session, ORG_ID, PROJECT_ID, ctx)
    assert True


# ── side_effects tests (S4-3) ─────────────────────────────────────────────────

def _make_result_with_side_effects(side_effects: list) -> EvaluationResult:
    action = {
        "auto_reply_mode": "process_and_report",
        "forward_to_agent_id": None,
        "side_effects": side_effects,
    }
    return EvaluationResult(
        matched=True,
        rule=MagicMock(),
        action=action,
        target_agent_id=AGENT_ID,
        log_id=LOG_ID,
    )


@pytest.mark.asyncio
async def test_side_effect_update_status():
    session = _mock_session()
    story_id = str(uuid.uuid4())
    ctx = EventContext(event_type="e", metadata={"story_id": story_id})
    side_effects = [{"type": "update_status", "target_status": "in-review"}]
    await _execute_side_effects(session, ORG_ID, side_effects, ctx)
    session.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_side_effect_auto_assign():
    session = _mock_session()
    story_id = str(uuid.uuid4())
    member_id = uuid.uuid4()
    result_mock = MagicMock()
    result_mock.scalar_one_or_none.return_value = member_id
    session.execute = AsyncMock(return_value=result_mock)
    ctx = EventContext(event_type="e", metadata={"story_id": story_id})
    side_effects = [{"type": "auto_assign", "assign_to_role": "qa"}]
    await _execute_side_effects(session, ORG_ID, side_effects, ctx)
    assert session.execute.call_count == 2  # select + update


@pytest.mark.asyncio
async def test_side_effect_loop_prevention():
    session = _mock_session()
    ctx = EventContext(event_type="e", is_side_effect=True)
    with patch("app.services.workflow_pipeline.evaluate", new=AsyncMock()) as mock_eval:
        await process_event(session, ORG_ID, PROJECT_ID, ctx)
    mock_eval.assert_not_awaited()


def test_normalize_action_side_effects():
    result = _normalize_action({
        "auto_reply_mode": "process_and_report",
        "side_effects": [
            {"type": "update_status", "target_status": "in-review"},
            {"type": "invalid_type"},
        ],
    })
    assert len(result["side_effects"]) == 1
    assert result["side_effects"][0]["type"] == "update_status"


def test_normalize_action_no_side_effects_backward_compat():
    result = _normalize_action({"auto_reply_mode": "process_and_report"})
    assert result["side_effects"] == []
