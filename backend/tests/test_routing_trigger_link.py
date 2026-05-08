"""Tests for agent_routing_rules trigger_type_slugs integration."""
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.repositories.agent_routing_rule import _normalize_conditions, _validate_trigger_slugs

ORG_ID = uuid.uuid4()


def _mock_trigger(slug: str) -> MagicMock:
    t = MagicMock()
    t.slug = slug
    return t


# ── _normalize_conditions ──────────────────────────────────────────────────

def test_normalize_conditions_no_trigger_slugs():
    result = _normalize_conditions({"memo_type": ["kickoff"]})
    assert result == {"memo_type": ["kickoff"]}
    assert "trigger_type_slugs" not in result


def test_normalize_conditions_with_trigger_slugs():
    result = _normalize_conditions({"memo_type": ["kickoff"], "trigger_type_slugs": ["qa_request", "kickoff"]})
    assert result["trigger_type_slugs"] == ["qa_request", "kickoff"]


def test_normalize_conditions_deduplicates_trigger_slugs():
    result = _normalize_conditions({"memo_type": [], "trigger_type_slugs": ["kickoff", "KICKOFF", "kickoff"]})
    assert result["trigger_type_slugs"] == ["kickoff"]


def test_normalize_conditions_strips_and_lowercases_trigger_slugs():
    result = _normalize_conditions({"memo_type": [], "trigger_type_slugs": ["  QA_REQUEST  "]})
    assert result["trigger_type_slugs"] == ["qa_request"]


def test_normalize_conditions_filters_empty_trigger_slugs():
    result = _normalize_conditions({"memo_type": [], "trigger_type_slugs": ["", "   ", "kickoff"]})
    assert result["trigger_type_slugs"] == ["kickoff"]


def test_normalize_conditions_non_list_trigger_slugs_becomes_empty():
    result = _normalize_conditions({"memo_type": [], "trigger_type_slugs": "kickoff"})
    assert result["trigger_type_slugs"] == []


def test_normalize_conditions_none_input():
    result = _normalize_conditions(None)
    assert result == {"memo_type": []}


def test_normalize_conditions_empty_trigger_slugs_key_preserved():
    result = _normalize_conditions({"memo_type": [], "trigger_type_slugs": []})
    assert "trigger_type_slugs" in result
    assert result["trigger_type_slugs"] == []


# ── _validate_trigger_slugs ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_validate_trigger_slugs_passes_for_known_slugs():
    mock_session = AsyncMock()
    with patch("app.repositories.agent_routing_rule.WorkflowTriggerTypeRepository") as MockRepo:
        mock_repo = AsyncMock()
        mock_repo.list.return_value = [_mock_trigger("kickoff"), _mock_trigger("qa_request")]
        MockRepo.return_value = mock_repo
        await _validate_trigger_slugs(mock_session, ORG_ID, ["kickoff", "qa_request"])


@pytest.mark.asyncio
async def test_validate_trigger_slugs_raises_for_unknown_slug():
    mock_session = AsyncMock()
    with patch("app.repositories.agent_routing_rule.WorkflowTriggerTypeRepository") as MockRepo:
        mock_repo = AsyncMock()
        mock_repo.list.return_value = [_mock_trigger("kickoff")]
        MockRepo.return_value = mock_repo
        with pytest.raises(ValueError, match="nonexistent"):
            await _validate_trigger_slugs(mock_session, ORG_ID, ["kickoff", "nonexistent"])


@pytest.mark.asyncio
async def test_validate_trigger_slugs_noop_for_empty_list():
    mock_session = AsyncMock()
    with patch("app.repositories.agent_routing_rule.WorkflowTriggerTypeRepository") as MockRepo:
        mock_repo = AsyncMock()
        MockRepo.return_value = mock_repo
        await _validate_trigger_slugs(mock_session, ORG_ID, [])
        mock_repo.list.assert_not_called()


# ── _build_routing_template trigger_type_slugs ───────────────────────────

def test_build_routing_template_includes_trigger_slugs():
    from app.services.deployment_lifecycle import _build_routing_template

    agents = [
        {"agentId": str(uuid.uuid4()), "agentName": "PO", "role": "product-owner", "personaId": None, "deploymentId": None},
        {"agentId": str(uuid.uuid4()), "agentName": "Dev", "role": "developer", "personaId": None, "deploymentId": None},
    ]
    result = _build_routing_template(agents, 0)
    rules = result["rules"]
    assert len(rules) == 2
    po_rule = next(r for r in rules if "requirement" in r["conditions"]["memo_type"])
    dev_rule = next(r for r in rules if "task" in r["conditions"]["memo_type"])
    assert po_rule["conditions"]["trigger_type_slugs"] == ["kickoff"]
    assert dev_rule["conditions"]["trigger_type_slugs"] == ["kickoff"]


def test_build_routing_template_qa_rule_includes_qa_request_slug():
    from app.services.deployment_lifecycle import _build_routing_template

    agents = [
        {"agentId": str(uuid.uuid4()), "agentName": "PO", "role": "product-owner", "personaId": None, "deploymentId": None},
        {"agentId": str(uuid.uuid4()), "agentName": "Dev", "role": "developer", "personaId": None, "deploymentId": None},
        {"agentId": str(uuid.uuid4()), "agentName": "QA", "role": "qa", "personaId": None, "deploymentId": None},
    ]
    result = _build_routing_template(agents, 0)
    qa_rule = next(r for r in result["rules"] if "review" in r["conditions"]["memo_type"])
    assert qa_rule["conditions"]["trigger_type_slugs"] == ["qa_request"]
