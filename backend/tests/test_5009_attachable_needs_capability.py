"""story 5009 (A2 · AC5) — the list of agents a setup page may offer says which word an app must have said to drive each one (`needs_capability`), so a page opened by an app from
before the runtime can show «update the app» — not «no such agent» (the confirmation's agent_not_found is the safety net) and not «not on this computer».

Red when: the field stops coming for a runtime that needs a word, comes for claude · codex (which every app drives), or an app from before is allowed to attach such an agent.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.routers.desktop_setup import AttachableAgent
from app.services import agent_runtime as ar
from app.services import desktop_setup as ds


def test_the_response_model_carries_the_field_and_an_older_reader_may_omit_it():
    a = AttachableAgent(id=uuid.uuid4(), name="x", runtime="opencode", live_keys=0, in_project=True, needs_capability="rt-opencode")
    assert a.needs_capability == "rt-opencode"
    assert AttachableAgent(id=uuid.uuid4(), name="x", runtime="claude", live_keys=0, in_project=True).needs_capability is None


@pytest.mark.anyio
async def test_the_list_says_which_word_each_runtime_needs():
    org, proj = uuid.uuid4(), uuid.uuid4()
    rows = [
        SimpleNamespace(id=uuid.UUID(int=1), name="c", runtime_type="claude-code"),
        SimpleNamespace(id=uuid.UUID(int=2), name="x", runtime_type="codex"),
        SimpleNamespace(id=uuid.UUID(int=3), name="o", runtime_type="opencode"),
    ]
    db = MagicMock()
    res_agents, res_keys = MagicMock(), MagicMock()
    res_agents.all.return_value = rows
    res_keys.all.return_value = []
    db.execute = AsyncMock(side_effect=[res_agents, res_keys])
    from unittest.mock import patch

    with patch("app.services.project_auth.is_org_owner_or_admin", AsyncMock(return_value=True)), \
         patch("app.services.project_auth.require_project_access", AsyncMock(return_value=None)), \
         patch("app.services.project_auth.project_accessible_member_ids", AsyncMock(return_value={r.id for r in rows})):
        out = await ds.list_attachable_agents(db, user_id=uuid.uuid4(), org_id=org, project_id=proj)
    assert {a["runtime"]: a["needs_capability"] for a in out} == {"claude": None, "codex": None, "opencode": "rt-opencode"}


@pytest.mark.anyio
async def test_an_app_from_before_cannot_attach_an_opencode_agent_but_one_that_said_the_word_can(monkeypatch):
    import app.services.project_auth as pa

    kw = dict(org_id=uuid.UUID(int=9), project_id=uuid.UUID(int=8), agent_id=uuid.UUID(int=1))
    monkeypatch.setattr(pa, "project_accessible_member_ids", AsyncMock(return_value={uuid.UUID(int=1)}))

    async def attach(caps):
        db = MagicMock()
        result = MagicMock()
        result.first.return_value = SimpleNamespace(type="agent", is_active=True, runtime_type="opencode")
        db.execute = AsyncMock(return_value=result)
        return await ds._attachable_runtime(db, capabilities=caps, **kw)

    for caps in (None, ["move", "solo"]):
        with pytest.raises(ds.DesktopSetupError) as e:
            await attach(caps)
        assert e.value.code == "agent_not_found"  # the safety net; the page never offers the row (its «update the app» line)
    assert await attach(["move", "solo", "rt-opencode"]) == "opencode"
