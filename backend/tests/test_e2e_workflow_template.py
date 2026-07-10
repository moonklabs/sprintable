"""E2E scenario tests for WorkflowTemplate apply pipeline (S5-4)."""
import uuid
from collections import namedtuple
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.routers.workflow_templates import ApplyTemplateRequest, apply_template

AgentRow = namedtuple("AgentRow", ["id", "name", "role"])


def _make_template(slug: str, chain_length: int, step_refs: list[str], rule_count: int) -> MagicMock:
    tmpl = MagicMock()
    tmpl.slug = slug
    tmpl.name = slug.replace("-", " ").title()
    tmpl.description = f"{slug} template"
    tmpl.chain_length = chain_length
    tmpl.steps = [{"pattern": "assign", "role_ref": ref, "default_label": ref} for ref in step_refs]
    tmpl.rules_template = [
        {
            "role_ref": step_refs[i % len(step_refs)],
            "name": f"rule {i + 1}",
            "priority": (i + 1) * 10,
            "match_type": "event",
            "conditions": {},
            "action": {"auto_reply_mode": "process_and_report", "side_effects": []},
        }
        for i in range(rule_count)
    ]
    tmpl.presets = {}
    return tmpl


def _make_agents(*roles: str) -> tuple[list[uuid.UUID], MagicMock]:
    ids = [uuid.uuid4() for _ in roles]
    result = MagicMock()
    result.all.return_value = [AgentRow(id=ids[i], name=f"Agent{i+1}", role=roles[i]) for i in range(len(roles))]
    return ids, result


def _db_with_execute(execute_results: list) -> AsyncMock:
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=execute_results)
    db.add = MagicMock()
    db.flush = AsyncMock()
    return db


# ── E2E: three-step 적용 ─────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_e2e_template_apply_three_step():
    """three-step(po-dev-qa) 템플릿 적용 → 규칙 4개 생성 확인."""
    tmpl = _make_template("three-step", 3, ["step_1", "step_2", "step_3"], 4)
    agent_ids, agent_result = _make_agents("developer", "product-owner", "qa")

    db = _db_with_execute([agent_result])

    body = ApplyTemplateRequest(
        project_id=uuid.uuid4(),
        role_mapping={f"step_{i+1}": str(agent_ids[i]) for i in range(3)},
    )

    with patch("app.routers.workflow_templates.WorkflowTemplateRepository") as MockRepo, \
         patch("app.services.project_auth.has_project_access", new=AsyncMock(return_value=True)):
        instance = AsyncMock()
        instance.get_by_slug = AsyncMock(return_value=tmpl)
        MockRepo.return_value = instance
        auth = MagicMock()
        auth.user_id = str(uuid.uuid4())
        result = await apply_template(slug="three-step", body=body, db=db, auth=auth, org_id=uuid.uuid4())

    assert result.ok is True
    assert result.rules_created == 4
    assert db.add.call_count == 4


# ── E2E: solo 적용 ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_e2e_template_apply_solo():
    """solo 템플릿 적용 → 규칙 1개 생성 확인."""
    tmpl = _make_template("solo", 1, ["step_1"], 1)
    agent_ids, agent_result = _make_agents("developer")

    db = _db_with_execute([agent_result])

    body = ApplyTemplateRequest(
        project_id=uuid.uuid4(),
        role_mapping={"step_1": str(agent_ids[0])},
    )

    with patch("app.routers.workflow_templates.WorkflowTemplateRepository") as MockRepo, \
         patch("app.services.project_auth.has_project_access", new=AsyncMock(return_value=True)):
        instance = AsyncMock()
        instance.get_by_slug = AsyncMock(return_value=tmpl)
        MockRepo.return_value = instance
        auth = MagicMock()
        auth.user_id = str(uuid.uuid4())
        result = await apply_template(slug="solo", body=body, db=db, auth=auth, org_id=uuid.uuid4())

    assert result.ok is True
    assert result.rules_created == 1
    assert result.rules_deleted == 0


# ── E2E: overwrite 시나리오 ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_e2e_template_overwrite():
    """적용 후 다른 템플릿 overwrite → 기존 삭제 + 신규 생성."""
    tmpl = _make_template("two-step", 2, ["step_1", "step_2"], 2)
    agent_ids, agent_result = _make_agents("developer", "product-owner")

    existing_id = uuid.uuid4()
    m_existing = MagicMock()
    m_existing.all.return_value = [(existing_id,)]
    m_update = MagicMock()

    db = _db_with_execute([agent_result, m_existing, m_update])

    body = ApplyTemplateRequest(
        project_id=uuid.uuid4(),
        role_mapping={"step_1": str(agent_ids[0]), "step_2": str(agent_ids[1])},
        overwrite_existing=True,
    )

    with patch("app.routers.workflow_templates.WorkflowTemplateRepository") as MockRepo, \
         patch("app.services.project_auth.has_project_access", new=AsyncMock(return_value=True)):
        instance = AsyncMock()
        instance.get_by_slug = AsyncMock(return_value=tmpl)
        MockRepo.return_value = instance
        auth = MagicMock()
        auth.user_id = str(uuid.uuid4())
        result = await apply_template(slug="two-step", body=body, db=db, auth=auth, org_id=uuid.uuid4())

    assert result.ok is True
    assert result.rules_created == 2
    assert result.rules_deleted == 1


# ── E2E: 목록 + 단건 조회 ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_e2e_list_and_get_template():
    """목록 조회 4건 + 단건 조회 fields 확인."""
    from app.routers.workflow_templates import list_templates, get_template

    slugs = ["solo", "two-step", "three-step", "kanban"]
    mock_templates = [_make_template(s, i, ["step_1"], 1) for i, s in enumerate(slugs)]
    for t in mock_templates:
        t.is_system = True
        t.is_enabled = True

    db = AsyncMock()

    with patch("app.routers.workflow_templates.WorkflowTemplateRepository") as MockRepo:
        instance = AsyncMock()
        instance.list = AsyncMock(return_value=mock_templates)
        instance.get_by_slug = AsyncMock(return_value=mock_templates[2])
        MockRepo.return_value = instance

        tmpl_list = await list_templates(db=db, _auth=MagicMock())
        assert len(tmpl_list) == 4
        assert {t.slug for t in tmpl_list} == set(slugs)

        detail = await get_template(slug="three-step", db=db, _auth=MagicMock())
        assert detail.slug == "three-step"
        assert "step_1" in [s["role_ref"] for s in detail.steps]
        assert len(detail.rules_template) == 1
