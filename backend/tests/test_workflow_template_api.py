"""Tests for workflow-templates CRUD + apply API (S5-2)."""
import uuid
from collections import namedtuple
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.routers.workflow_templates import ApplyTemplateRequest, ApplyTemplateResponse

AgentRow = namedtuple("AgentRow", ["id", "name", "role"])


# ── helpers ─────────────────────────────────────────────────────────────────

def _make_template(slug: str = "two-step", chain_length: int = 2) -> MagicMock:
    tmpl = MagicMock()
    tmpl.slug = slug
    tmpl.name = "Two-Step Review"
    tmpl.description = "desc"
    tmpl.chain_length = chain_length
    tmpl.steps = [
        {"pattern": "assign", "role_ref": "step_1", "default_label": "Maker"},
        {"pattern": "review", "role_ref": "step_2", "default_label": "Reviewer"},
    ]
    tmpl.presets = {"dev-review": {"step_1": "Developer", "step_2": "Tech Lead"}}
    tmpl.rules_template = [
        {"role_ref": "step_1", "name": "{step_1} kickoff", "priority": 10, "match_type": "event", "conditions": {}, "action": {"auto_reply_mode": "process_and_report", "side_effects": []}},
        {"role_ref": "step_2", "name": "{step_1} submit → {step_2} review", "priority": 20, "match_type": "event", "conditions": {"event_params": {"reply_author_role": ["step_1"]}}, "action": {"auto_reply_mode": "process_and_report", "side_effects": []}},
    ]
    tmpl.is_system = True
    tmpl.is_enabled = True
    return tmpl


def _mock_db() -> AsyncMock:
    db = AsyncMock()
    db.execute = AsyncMock()
    db.add = MagicMock()
    db.flush = AsyncMock()
    return db


# ── list templates ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_list_templates_returns_enabled_only():
    from app.routers.workflow_templates import list_templates

    db = _mock_db()
    tmpl = _make_template()
    with patch("app.routers.workflow_templates.WorkflowTemplateRepository") as MockRepo:
        instance = AsyncMock()
        instance.list = AsyncMock(return_value=[tmpl])
        MockRepo.return_value = instance
        result = await list_templates(db=db, _auth=MagicMock())
    assert len(result) == 1
    assert result[0].slug == "two-step"


# ── get template ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_template_found():
    from app.routers.workflow_templates import get_template

    db = _mock_db()
    tmpl = _make_template()
    with patch("app.routers.workflow_templates.WorkflowTemplateRepository") as MockRepo:
        instance = AsyncMock()
        instance.get_by_slug = AsyncMock(return_value=tmpl)
        MockRepo.return_value = instance
        result = await get_template(slug="two-step", db=db, _auth=MagicMock())
    assert result.slug == "two-step"
    assert len(result.steps) == 2


@pytest.mark.asyncio
async def test_get_template_not_found():
    from fastapi import HTTPException
    from app.routers.workflow_templates import get_template

    db = _mock_db()
    with patch("app.routers.workflow_templates.WorkflowTemplateRepository") as MockRepo:
        instance = AsyncMock()
        instance.get_by_slug = AsyncMock(return_value=None)
        MockRepo.return_value = instance
        with pytest.raises(HTTPException) as exc:
            await get_template(slug="nonexistent", db=db, _auth=MagicMock())
    assert exc.value.status_code == 404


# ── apply template ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_apply_template_creates_rules():
    from app.routers.workflow_templates import apply_template

    db = _mock_db()
    tmpl = _make_template()

    agent1_id = uuid.uuid4()
    agent2_id = uuid.uuid4()

    agents_result = MagicMock()
    agents_result.all.return_value = [
        AgentRow(id=agent1_id, name="Dev", role="developer"),
        AgentRow(id=agent2_id, name="PO", role="product-owner"),
    ]
    db.execute = AsyncMock(return_value=agents_result)

    body = ApplyTemplateRequest(
        project_id=uuid.uuid4(),
        role_mapping={"step_1": str(agent1_id), "step_2": str(agent2_id)},
    )
    org_id = uuid.uuid4()
    auth = MagicMock()
    auth.user_id = str(uuid.uuid4())

    with patch("app.routers.workflow_templates.WorkflowTemplateRepository") as MockRepo:
        instance = AsyncMock()
        instance.get_by_slug = AsyncMock(return_value=tmpl)
        MockRepo.return_value = instance
        result = await apply_template(slug="two-step", body=body, db=db, auth=auth, org_id=org_id)

    assert result.ok is True
    assert result.rules_created == 2
    assert db.add.call_count == 2


@pytest.mark.asyncio
async def test_apply_template_cross_org_agent_422():
    """타 org 멤버 UUID → DB에서 조회 안 됨 → 422."""
    from fastapi import HTTPException
    from app.routers.workflow_templates import apply_template

    db = _mock_db()
    tmpl = _make_template()

    cross_org_id = uuid.uuid4()
    agents_result = MagicMock()
    agents_result.all.return_value = []  # org 조건 필터로 결과 없음
    db.execute = AsyncMock(return_value=agents_result)

    body = ApplyTemplateRequest(
        project_id=uuid.uuid4(),
        role_mapping={"step_1": str(cross_org_id), "step_2": str(uuid.uuid4())},
    )

    with patch("app.routers.workflow_templates.WorkflowTemplateRepository") as MockRepo:
        instance = AsyncMock()
        instance.get_by_slug = AsyncMock(return_value=tmpl)
        MockRepo.return_value = instance
        with pytest.raises(HTTPException) as exc:
            await apply_template(slug="two-step", body=body, db=db, auth=MagicMock(), org_id=uuid.uuid4())

    assert exc.value.status_code == 422


@pytest.mark.asyncio
async def test_apply_template_missing_role_mapping_422():
    from fastapi import HTTPException
    from app.routers.workflow_templates import apply_template

    db = _mock_db()
    tmpl = _make_template()

    body = ApplyTemplateRequest(
        project_id=uuid.uuid4(),
        role_mapping={"step_1": str(uuid.uuid4())},
    )

    with patch("app.routers.workflow_templates.WorkflowTemplateRepository") as MockRepo:
        instance = AsyncMock()
        instance.get_by_slug = AsyncMock(return_value=tmpl)
        MockRepo.return_value = instance
        with pytest.raises(HTTPException) as exc:
            await apply_template(slug="two-step", body=body, db=db, auth=MagicMock(), org_id=uuid.uuid4())

    assert exc.value.status_code == 422


@pytest.mark.asyncio
async def test_apply_template_404():
    from fastapi import HTTPException
    from app.routers.workflow_templates import apply_template

    db = _mock_db()
    body = ApplyTemplateRequest(project_id=uuid.uuid4(), role_mapping={})

    with patch("app.routers.workflow_templates.WorkflowTemplateRepository") as MockRepo:
        instance = AsyncMock()
        instance.get_by_slug = AsyncMock(return_value=None)
        MockRepo.return_value = instance
        with pytest.raises(HTTPException) as exc:
            await apply_template(slug="ghost", body=body, db=db, auth=MagicMock(), org_id=uuid.uuid4())

    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_apply_template_overwrite_deletes_existing():
    from app.routers.workflow_templates import apply_template

    db = _mock_db()
    tmpl = _make_template()

    agent1_id = uuid.uuid4()
    agent2_id = uuid.uuid4()
    existing_rule_id = uuid.uuid4()

    # execute calls: 1=select existing, 2=update, 3=select agents
    m_existing = MagicMock()
    m_existing.all.return_value = [(existing_rule_id,)]

    m_update = MagicMock()

    m_agents = MagicMock()
    m_agents.all.return_value = [
        AgentRow(id=agent1_id, name="Dev", role="developer"),
        AgentRow(id=agent2_id, name="PO", role="product-owner"),
    ]

    # 코드 execute 순서: 1=select agents, 2=select existing_rules, 3=update
    db.execute = AsyncMock(side_effect=[m_agents, m_existing, m_update])

    body = ApplyTemplateRequest(
        project_id=uuid.uuid4(),
        role_mapping={"step_1": str(agent1_id), "step_2": str(agent2_id)},
        overwrite_existing=True,
    )

    with patch("app.routers.workflow_templates.WorkflowTemplateRepository") as MockRepo:
        instance = AsyncMock()
        instance.get_by_slug = AsyncMock(return_value=tmpl)
        MockRepo.return_value = instance
        result = await apply_template(slug="two-step", body=body, db=db, auth=MagicMock(), org_id=uuid.uuid4())

    assert result.ok is True
    assert result.rules_deleted == 1
