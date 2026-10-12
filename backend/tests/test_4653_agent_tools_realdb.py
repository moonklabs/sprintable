"""story 4653 (PO 14015 · 17027 · 17028): the tool names an agent of a setup carries — real HTTP · migrated PG, the move flow the
existing tests use (4576). AC: another organization's setup is not touched; a confirmation records each agent's own tools on
its member; the exchange hands each agent its own tools, the runtime left out.
"""
from __future__ import annotations

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures used by name
    ORG,
    ORG2,
    OUTSIDER,
    OWNER,
    PROJ,
    _client,
    _confirm,
    _dispose_global_engine_after_test,
    _exchange,
    _quiet_stream_side_effects,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4576_move_setup_realdb import EXISTING_B, _move_code, movable  # noqa: F401 — fixtures used by name
from tests.test_4565_attach_existing_agent_realdb import attachable  # noqa: F401 — fixtures used by name
from tests.test_4424_desktop_setup_realdb import EXISTING  # noqa: E402


def _move_with_tools(first: list[str], second: list[str]) -> dict:
    return {"project_id": str(PROJ), "roles": [
        {"role": "Agent", "agent_id": str(EXISTING), "tools": first},
        {"role": "Agent", "agent_id": str(EXISTING_B), "tools": second},
    ]}


async def _member_tools(setup_id: str) -> dict[str, list[str]]:
    rows = (await _sql(fetch=f"SELECT members FROM desktop_setups WHERE id='{setup_id}'"))[0][0]
    return {m["member_id"]: m.get("tools") for m in rows}


@pytest.mark.anyio
async def test_another_organizations_setup_is_not_touched(movable):
    """A setup confirmed by one organization is refused to another: its members and their tools stay as they were."""
    async with _client() as c:
        code, _verifier, setup_id = await _move_code(c, "d4653 org isolation")
        r = await _confirm(c, code, body=_move_with_tools(["gcloud"], ["aws"]))
        assert r.status_code == 200, r.text
        before = await _member_tools(setup_id)
        r2 = await _confirm(c, code, who=OUTSIDER, org=ORG2, body=_move_with_tools(["gh"], ["gh"]))
        assert r2.status_code >= 400, r2.text
    assert await _member_tools(setup_id) == before


@pytest.mark.anyio
async def test_a_confirmation_records_each_agents_own_tools_on_its_member(movable):
    async with _client() as c:
        code, _verifier, setup_id = await _move_code(c, "d4653 members record")
        # the runtime is left out of what is stored: the claude agent's own name is not among its tools
        r = await _confirm(c, code, body=_move_with_tools(["claude", "gcloud"], ["aws"]))
        assert r.status_code == 200, r.text
    assert await _member_tools(setup_id) == {str(EXISTING): ["gcloud"], str(EXISTING_B): ["aws"]}


@pytest.mark.anyio
async def test_the_exchange_hands_each_agent_its_own_tools(movable):
    async with _client() as c:
        code, verifier, _setup_id = await _move_code(c, "d4653 exchange")
        r = await _confirm(c, code, body=_move_with_tools(["gcloud"], ["aws"]))
        assert r.status_code == 200, r.text
        ex = await _exchange(c, code, verifier)
        assert ex.status_code == 200, ex.text
        by_id = {a["member_id"]: a["tools"] for a in ex.json()["agents"]}
    assert by_id == {str(EXISTING): ["gcloud"], str(EXISTING_B): ["aws"]}
