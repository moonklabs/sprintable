"""story #4430 — an agent sees and lifts its own blocks through MCP.

The two tools wrap the existing block API as it is. These tests run the tools against the real routes (real PG): the MCP
client's HTTP calls are handed to the in-process app, so a wrong path or method fails here, not only in production.
"""
from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, patch

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


def _forward_to(http):
    """The MCP client's get/delete, answered by the in-process app (status errors raise, like the real client)."""

    async def get(path, *, params=None):
        r = await http.get(path, params=params)
        r.raise_for_status()
        return r.json()

    async def delete(path, *, params=None):
        r = await http.delete(path, params=params)
        r.raise_for_status()
        return None

    return get, delete


async def test_an_agent_lists_its_block_and_lifts_it_through_the_tools():
    import sprintable_mcp.tools.user_blocks as ub

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            _me_id, me_user = await _make_human_member(session, org.id, project.id)
            other_id, _ = await _make_human_member(session, org.id, project.id)

        from app.main import app

        await _setup_app_human(app, Session, me_user, org.id)
        try:
            async with _client_for(app) as http:
                assert (await http.post("/api/v2/user-blocks", json={"blocked_member_id": str(other_id)})).status_code == 201
                get, delete = _forward_to(http)
                with patch.object(ub.client, "get", new=AsyncMock(side_effect=get)), \
                        patch.object(ub.client, "delete", new=AsyncMock(side_effect=delete)):
                    listed = json.loads((await ub.list_user_blocks(ub.ListUserBlocksInput()))[0].text)
                    assert [b["blocked_member_id"] for b in listed] == [str(other_id)], listed

                    removed = json.loads((await ub.remove_user_block(ub.RemoveUserBlockInput(member_id=str(other_id))))[0].text)
                    assert removed == {"member_id": str(other_id), "blocked": False}

                    after = json.loads((await ub.list_user_blocks(ub.ListUserBlocksInput()))[0].text)
                    assert after == [], after
                    # lifting one that is no longer there is fine (no change)
                    again = await ub.remove_user_block(ub.RemoveUserBlockInput(member_id=str(other_id)))
                    assert not again[0].text.startswith("Error"), again[0].text
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


def test_the_block_tools_sit_with_chat_and_are_not_destructive():
    """Blocks only act on messages, so the tools belong to the chat group; lifting a block restores delivery and destroys
    nothing, so it must not need a destructive grant (a `delete_` name would have required one)."""
    from app.services.mcp_toolset import ALL_TOOL_NAMES, is_destructive, tool_group

    for name in ("sprintable_list_user_blocks", "sprintable_remove_user_block"):
        assert name in ALL_TOOL_NAMES
        assert tool_group(name) == "chat"
        assert not is_destructive(name)
