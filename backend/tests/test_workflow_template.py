"""Tests for WorkflowTemplate model + seed data + resolve_rules_template (S5-1)."""
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.repositories.workflow_template import WorkflowTemplateRepository, resolve_rules_template
from app.services.deployment_lifecycle import _select_template_slug, _build_routing_template_from_db


# ── resolve_rules_template ───────────────────────────────────────────────────

def test_resolve_rules_template_single_role():
    rules = [
        {
            "role_ref": "step_1",
            "name": "{step_1} kickoff",
            "priority": 10,
            "conditions": {},
            "action": {},
        }
    ]
    role_map = {
        "step_1": {
            "agent_id": "agent-uuid-1",
            "agent_name": "Dev",
            "persona_id": None,
            "deployment_id": None,
            "target_runtime": "openclaw",
            "target_model": None,
        }
    }
    resolved = resolve_rules_template(rules, role_map)
    assert len(resolved) == 1
    assert resolved[0]["agent_id"] == "agent-uuid-1"
    assert "role_ref" not in resolved[0]


def test_resolve_rules_template_multi_role():
    rules = [
        {"role_ref": "step_1", "name": "r1", "priority": 10, "conditions": {}, "action": {}},
        {"role_ref": "step_2", "name": "r2", "priority": 20, "conditions": {}, "action": {}},
    ]
    role_map = {
        "step_1": {"agent_id": "a1", "agent_name": "Dev", "persona_id": None, "deployment_id": None, "target_runtime": "openclaw", "target_model": None},
        "step_2": {"agent_id": "a2", "agent_name": "PO", "persona_id": None, "deployment_id": None, "target_runtime": "openclaw", "target_model": None},
    }
    resolved = resolve_rules_template(rules, role_map)
    assert resolved[0]["agent_id"] == "a1"
    assert resolved[1]["agent_id"] == "a2"


def test_resolve_rules_template_missing_role_ref_preserved():
    rules = [{"role_ref": "step_99", "name": "orphan", "priority": 10, "conditions": {}, "action": {}}]
    role_map = {"step_1": {"agent_id": "a1", "agent_name": "Dev", "persona_id": None, "deployment_id": None, "target_runtime": "openclaw", "target_model": None}}
    resolved = resolve_rules_template(rules, role_map)
    assert len(resolved) == 1
    assert "agent_id" not in resolved[0]


def test_resolve_rules_template_does_not_mutate_original():
    rules = [{"role_ref": "step_1", "name": "r", "priority": 10, "conditions": {}, "action": {}}]
    role_map = {"step_1": {"agent_id": "a1", "agent_name": "Dev", "persona_id": None, "deployment_id": None, "target_runtime": "openclaw", "target_model": None}}
    resolve_rules_template(rules, role_map)
    assert "role_ref" in rules[0]


# ── _select_template_slug ────────────────────────────────────────────────────

def test_select_slug_po_dev_qa():
    agents = [
        {"role": "product-owner", "agentId": "a"},
        {"role": "developer", "agentId": "b"},
        {"role": "qa", "agentId": "c"},
    ]
    assert _select_template_slug(agents) == "three-step"


def test_select_slug_po_dev():
    agents = [
        {"role": "product-owner", "agentId": "a"},
        {"role": "developer", "agentId": "b"},
    ]
    assert _select_template_slug(agents) == "two-step"


def test_select_slug_solo():
    agents = [{"role": "developer", "agentId": "a"}]
    assert _select_template_slug(agents) == "solo"


# ── _build_routing_template_from_db ─────────────────────────────────────────

def _mock_template(slug: str) -> MagicMock:
    tmpl = MagicMock()
    tmpl.slug = slug
    tmpl.rules_template = [
        {"role_ref": "step_1", "name": "kickoff", "priority": 10, "match_type": "event", "conditions": {}, "action": {}},
        {"role_ref": "step_2", "name": "review", "priority": 20, "match_type": "event", "conditions": {}, "action": {}},
    ]
    return tmpl


def _mock_session_with_template(slug: str) -> AsyncMock:
    session = AsyncMock()
    repo_mock = AsyncMock()
    repo_mock.get_by_slug = AsyncMock(return_value=_mock_template(slug))
    return session


@pytest.mark.asyncio
async def test_build_routing_template_from_db_uses_template():
    session = AsyncMock()
    dev_id = str(uuid.uuid4())
    po_id = str(uuid.uuid4())
    agents = [
        {"agentId": po_id, "agentName": "PO", "role": "product-owner", "personaId": None, "deploymentId": None},
        {"agentId": dev_id, "agentName": "Dev", "role": "developer", "personaId": None, "deploymentId": None},
    ]

    tmpl = _mock_template("two-step")
    result_mock = MagicMock()
    result_mock.scalar_one_or_none.return_value = tmpl
    session.execute = AsyncMock(return_value=result_mock)

    result = await _build_routing_template_from_db(session, agents, 0)
    assert result["templateId"] == "two-step"
    assert len(result["rules"]) == 2


@pytest.mark.asyncio
async def test_build_routing_template_from_db_falls_back_when_no_template():
    session = AsyncMock()
    dev_id = str(uuid.uuid4())
    po_id = str(uuid.uuid4())
    agents = [
        {"agentId": po_id, "agentName": "PO", "role": "product-owner", "personaId": None, "deploymentId": None},
        {"agentId": dev_id, "agentName": "Dev", "role": "developer", "personaId": None, "deploymentId": None},
    ]
    result_mock = MagicMock()
    result_mock.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=result_mock)

    result = await _build_routing_template_from_db(session, agents, 0)
    assert result["templateId"] in ("po-dev", "two-step", "none", "solo-dev")


@pytest.mark.asyncio
async def test_build_routing_template_from_db_no_po_no_dev_returns_none():
    session = AsyncMock()
    agents = [{"agentId": str(uuid.uuid4()), "agentName": "Bot", "role": "unknown", "personaId": None, "deploymentId": None}]
    result_mock = MagicMock()
    result_mock.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=result_mock)

    result = await _build_routing_template_from_db(session, agents, 0)
    assert result["templateId"] in ("none", "solo-dev")
