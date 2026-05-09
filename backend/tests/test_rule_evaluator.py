"""Tests for rule_evaluator service — Phase 3 AC1~AC6."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.rule_evaluator import EventContext, EvaluationResult, _matches, evaluate

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
AGENT_ID = uuid.uuid4()


def _rule(
    priority: int = 100,
    is_enabled: bool = True,
    trigger_type_slugs: list[str] | None = None,
    memo_type: list[str] | None = None,
) -> MagicMock:
    r = MagicMock()
    r.id = uuid.uuid4()
    r.org_id = ORG_ID
    r.project_id = PROJECT_ID
    r.agent_id = AGENT_ID
    r.priority = priority
    r.is_enabled = is_enabled
    r.deleted_at = None
    conditions: dict = {}
    if trigger_type_slugs is not None:
        conditions["trigger_type_slugs"] = trigger_type_slugs
    if memo_type is not None:
        conditions["memo_type"] = memo_type
    r.conditions = conditions
    r.action = {"auto_reply_mode": "process_and_report", "forward_to_agent_id": None}
    return r


# ── _matches unit tests ───────────────────────────────────────────────────────

def test_matches_trigger_slug_hit():
    rule = _rule(trigger_type_slugs=["kickoff"])
    ctx = EventContext(event_type="memo.received", trigger_type_slug="kickoff")
    assert _matches(rule, ctx) is True


def test_matches_trigger_slug_miss():
    rule = _rule(trigger_type_slugs=["kickoff"])
    ctx = EventContext(event_type="memo.received", trigger_type_slug="qa_request")
    assert _matches(rule, ctx) is False


def test_matches_memo_type_hit():
    rule = _rule(memo_type=["requirement", "user_story"])
    ctx = EventContext(event_type="memo.received", memo_type="requirement")
    assert _matches(rule, ctx) is True


def test_matches_memo_type_miss():
    rule = _rule(memo_type=["requirement"])
    ctx = EventContext(event_type="memo.received", memo_type="review")
    assert _matches(rule, ctx) is False


def test_matches_both_conditions_must_pass():
    rule = _rule(trigger_type_slugs=["kickoff"], memo_type=["requirement"])
    ctx_ok = EventContext(event_type="e", trigger_type_slug="kickoff", memo_type="requirement")
    ctx_bad = EventContext(event_type="e", trigger_type_slug="kickoff", memo_type="review")
    assert _matches(rule, ctx_ok) is True
    assert _matches(rule, ctx_bad) is False


def test_matches_empty_conditions_wildcard():
    rule = _rule()  # no trigger_type_slugs, no memo_type
    ctx = EventContext(event_type="anything", trigger_type_slug="whatever", memo_type="any")
    assert _matches(rule, ctx) is True


def test_matches_empty_list_treated_as_wildcard():
    rule = _rule(trigger_type_slugs=[], memo_type=[])
    ctx = EventContext(event_type="e", trigger_type_slug="kickoff", memo_type="review")
    assert _matches(rule, ctx) is True


# ── evaluate integration tests ────────────────────────────────────────────────

def _mock_session(rules: list) -> AsyncMock:
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = rules
    mock_session.execute.return_value = mock_result
    mock_session.add = MagicMock()
    mock_session.flush = AsyncMock()
    return mock_session


@pytest.mark.asyncio
async def test_evaluate_returns_first_priority_match():
    r1 = _rule(priority=10, trigger_type_slugs=["kickoff"])
    r2 = _rule(priority=20, trigger_type_slugs=["kickoff"])
    session = _mock_session([r1, r2])
    ctx = EventContext(event_type="e", trigger_type_slug="kickoff")
    result = await evaluate(session, ORG_ID, PROJECT_ID, ctx)
    assert result.matched is True
    assert result.rule is r1


@pytest.mark.asyncio
async def test_evaluate_no_match_returns_false():
    r = _rule(trigger_type_slugs=["kickoff"])
    session = _mock_session([r])
    ctx = EventContext(event_type="e", trigger_type_slug="qa_request")
    result = await evaluate(session, ORG_ID, PROJECT_ID, ctx)
    assert result.matched is False
    assert result.rule is None


@pytest.mark.asyncio
async def test_evaluate_logs_execution():
    r = _rule(trigger_type_slugs=["kickoff"])
    session = _mock_session([r])
    ctx = EventContext(event_type="memo.received", trigger_type_slug="kickoff")
    await evaluate(session, ORG_ID, PROJECT_ID, ctx)
    session.add.assert_called_once()
    log_obj = session.add.call_args[0][0]
    assert log_obj.status == "matched"
    assert log_obj.trigger_type_slug == "kickoff"
    assert log_obj.event_type == "memo.received"
    assert log_obj.rule_id == r.id


@pytest.mark.asyncio
async def test_evaluate_no_match_logs_no_match():
    session = _mock_session([])
    ctx = EventContext(event_type="e", trigger_type_slug="kickoff")
    await evaluate(session, ORG_ID, PROJECT_ID, ctx)
    log_obj = session.add.call_args[0][0]
    assert log_obj.status == "no_match"
    assert log_obj.rule_id is None


@pytest.mark.asyncio
async def test_evaluate_memo_type_filter():
    r_po = _rule(priority=10, trigger_type_slugs=["kickoff"], memo_type=["requirement"])
    r_dev = _rule(priority=20, trigger_type_slugs=["kickoff"], memo_type=["task"])
    session = _mock_session([r_po, r_dev])
    ctx = EventContext(event_type="e", trigger_type_slug="kickoff", memo_type="task")
    result = await evaluate(session, ORG_ID, PROJECT_ID, ctx)
    assert result.matched is True
    assert result.rule is r_dev


@pytest.mark.asyncio
async def test_evaluate_returns_target_agent_id():
    r = _rule(trigger_type_slugs=["kickoff"])
    session = _mock_session([r])
    ctx = EventContext(event_type="e", trigger_type_slug="kickoff")
    result = await evaluate(session, ORG_ID, PROJECT_ID, ctx)
    assert result.target_agent_id == AGENT_ID


# ── event_params matching tests (S4-2) ───────────────────────────────────────

def _rule_with_params(event_params: dict, **kwargs) -> MagicMock:
    r = _rule(**kwargs)
    r.conditions["event_params"] = event_params
    return r


def test_event_params_single_key_match():
    rule = _rule_with_params({"reply_author_role": ["agent"]})
    ctx = EventContext(event_type="memo.reply_created", metadata={"reply_author_role": "agent"})
    assert _matches(rule, ctx) is True


def test_event_params_single_key_no_match():
    rule = _rule_with_params({"reply_author_role": ["agent"]})
    ctx = EventContext(event_type="memo.reply_created", metadata={"reply_author_role": "human"})
    assert _matches(rule, ctx) is False


def test_event_params_multi_key_and():
    rule = _rule_with_params({"reply_author_role": ["agent"], "has_pr_link": [True]})
    ctx_ok = EventContext(event_type="e", metadata={"reply_author_role": "agent", "has_pr_link": True})
    ctx_bad = EventContext(event_type="e", metadata={"reply_author_role": "agent", "has_pr_link": False})
    assert _matches(rule, ctx_ok) is True
    assert _matches(rule, ctx_bad) is False


def test_event_params_or_values():
    rule = _rule_with_params({"review_type": ["approve", "request_changes"]})
    ctx_approve = EventContext(event_type="e", metadata={"review_type": "approve"})
    ctx_rc = EventContext(event_type="e", metadata={"review_type": "request_changes"})
    ctx_miss = EventContext(event_type="e", metadata={"review_type": "comment"})
    assert _matches(rule, ctx_approve) is True
    assert _matches(rule, ctx_rc) is True
    assert _matches(rule, ctx_miss) is False


def test_event_params_empty_backward_compat():
    rule = _rule(trigger_type_slugs=["reply"])
    ctx = EventContext(event_type="memo.reply_created", trigger_type_slug="reply", metadata={})
    assert _matches(rule, ctx) is True


def test_event_params_bool_matching():
    rule = _rule_with_params({"has_pr_link": [True]})
    ctx_true = EventContext(event_type="e", metadata={"has_pr_link": True})
    ctx_false = EventContext(event_type="e", metadata={"has_pr_link": False})
    assert _matches(rule, ctx_true) is True
    assert _matches(rule, ctx_false) is False


def test_event_params_missing_key_treated_as_miss():
    rule = _rule_with_params({"reply_author_role": ["agent"]})
    ctx = EventContext(event_type="e", metadata={})
    assert _matches(rule, ctx) is False


# ── _normalize_conditions event_params tests (S4-2) ──────────────────────────

from app.repositories.agent_routing_rule import _normalize_conditions


def test_normalize_conditions_event_params_passthrough():
    result = _normalize_conditions({
        "event_params": {"reply_author_role": ["agent"], "has_pr_link": [True]}
    })
    assert result["event_params"] == {"reply_author_role": ["agent"], "has_pr_link": [True]}


def test_normalize_conditions_event_params_scalar_wrapped():
    result = _normalize_conditions({
        "event_params": {"review_type": "approve"}
    })
    assert result["event_params"] == {"review_type": ["approve"]}


def test_normalize_conditions_no_event_params_unchanged():
    result = _normalize_conditions({"memo_type": ["task"]})
    assert "event_params" not in result
    assert result["memo_type"] == ["task"]
