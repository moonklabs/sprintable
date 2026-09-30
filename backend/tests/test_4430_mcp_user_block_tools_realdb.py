"""story #4430 — an agent sees and lifts its own blocks through MCP.

The two tools wrap the existing block API as it is. These tests run the real MCP client (sprintable_mcp.api_client) over
httpx into the in-process app (real PG): real status codes (DELETE answers 204 with no body), real path handling, real
auth. The first version faked the client's get/delete instead — the fake returned None for the 204, the real client raised
on it, and the tool reported «error» for a removal that had happened (Qadir 4853 ①).
"""
from __future__ import annotations

import json
import os
import uuid

import httpx
import pytest

from tests.test_1994_backlink_api_realdb import (
    _make_agent_member,
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


def _wire_client_to_app(monkeypatch, app, *, api_key: str) -> list[httpx.Request]:
    """The real MCP client, its HTTP answered by the in-process app. Returns the list of requests that reached the app."""
    import sprintable_mcp.api_client as api

    seen: list[httpx.Request] = []
    asgi = httpx.ASGITransport(app=app)

    class _Recording(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return await asgi.handle_async_request(request)

    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(api.httpx, "AsyncClient", lambda **kw: real_async_client(transport=_Recording(), **kw))
    monkeypatch.setattr(api.client, "_base_url", "http://test")
    monkeypatch.setattr(api.client, "_api_key", api_key)
    return seen


def _text(result) -> str:
    return result[0].text


async def test_a_person_lists_a_block_and_lifts_it_through_the_real_client(monkeypatch):
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
            seen = _wire_client_to_app(monkeypatch, app, api_key="not-used-auth-is-overridden")
            import sprintable_mcp.api_client as api

            await api.client.post("/api/v2/user-blocks", json={"blocked_member_id": str(other_id)})

            listed = json.loads(_text(await ub.list_user_blocks(ub.ListUserBlocksInput())))
            assert [b["blocked_member_id"] for b in listed] == [str(other_id)], listed

            removed = await ub.remove_user_block(ub.RemoveUserBlockInput(member_id=other_id))
            assert not _text(removed).startswith("Error"), _text(removed)  # the real 204 is a success
            assert json.loads(_text(removed)) == {"member_id": str(other_id), "blocked": False}
            assert any(r.method == "DELETE" for r in seen)

            assert json.loads(_text(await ub.list_user_blocks(ub.ListUserBlocksInput()))) == []
            again = await ub.remove_user_block(ub.RemoveUserBlockInput(member_id=other_id))
            assert not _text(again).startswith("Error"), _text(again)  # nothing to lift is no change
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_an_agent_with_its_api_key_lists_and_lifts_its_own_block(monkeypatch):
    """The caller these tools are for: an agent authenticating with its own API key (no auth override)."""
    import sprintable_mcp.tools.user_blocks as ub
    from app.models.api_key import ApiKey
    from app.repositories.api_key import _generate_key

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            agent_id = await _make_agent_member(session, org.id, project.id)
            teammate_id = await _make_agent_member(session, org.id, project.id)
            raw_key, prefix, key_hash = _generate_key()
            session.add(ApiKey(id=uuid.uuid4(), team_member_id=agent_id, member_id=agent_id, key_prefix=prefix, key_hash=key_hash))
            await session.commit()

        from app.main import app

        app.dependency_overrides.clear()
        _wire_client_to_app(monkeypatch, app, api_key=raw_key)
        import sprintable_mcp.api_client as api

        await api.client.post("/api/v2/user-blocks", json={"blocked_member_id": str(teammate_id)})
        listed = json.loads(_text(await ub.list_user_blocks(ub.ListUserBlocksInput())))
        assert [b["blocked_member_id"] for b in listed] == [str(teammate_id)], listed
        assert [b["blocker_member_id"] for b in listed] == [str(agent_id)], listed

        removed = await ub.remove_user_block(ub.RemoveUserBlockInput(member_id=teammate_id))
        assert not _text(removed).startswith("Error"), _text(removed)
        assert json.loads(_text(await ub.list_user_blocks(ub.ListUserBlocksInput()))) == []
    finally:
        await engine.dispose()


async def test_a_path_that_would_normalize_elsewhere_never_leaves_the_client(monkeypatch):
    """Qadir 4853 ② — `../visual-artifacts/<id>` in a path would be normalized into another endpoint and called with the
    agent's key. The tool takes a UUID, and the shared client refuses the whole class before any request."""
    import pydantic

    import sprintable_mcp.api_client as api
    import sprintable_mcp.tools.user_blocks as ub
    from app.main import app

    seen = _wire_client_to_app(monkeypatch, app, api_key="k")

    with pytest.raises(pydantic.ValidationError):
        ub.RemoveUserBlockInput(member_id="../visual-artifacts/00000000-0000-0000-0000-000000000000")

    for path in (
        "/api/v2/user-blocks/../visual-artifacts/x", "/api/v2/user-blocks/%2e%2e/visual-artifacts/x",
        "/api/v2/user-blocks/./x", "/api/v2//user-blocks", "/api/v2/user-blocks/a%2Fb", "/api/v2/user-blocks/x/",
    ):
        with pytest.raises(api.UnsafeRequestPath):
            await api.client.delete(path)
    assert seen == []  # not one request left the client


async def test_a_success_with_no_body_is_none_not_an_error():
    """The shared client: 204 and an empty 200 are None (every tool calling such a route shared the hole)."""
    import sprintable_mcp.api_client as api

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/gone"):
            return httpx.Response(204)
        if request.url.path.endswith("/empty"):
            return httpx.Response(200, content=b"")
        return httpx.Response(200, json={"data": {"ok": True}})

    real_async_client = httpx.AsyncClient
    mp = pytest.MonkeyPatch()
    try:
        mp.setattr(api.httpx, "AsyncClient", lambda **kw: real_async_client(transport=httpx.MockTransport(handler), **kw))
        mp.setattr(api.client, "_base_url", "http://test")
        assert await api.client.delete("/api/v2/thing/gone") is None
        assert await api.client.get("/api/v2/thing/empty") is None
        assert await api.client.get("/api/v2/thing/full") == {"ok": True}
    finally:
        mp.undo()


def test_the_block_tools_and_their_route_sit_with_chat_and_are_not_destructive():
    """Blocks only act on messages: the tools and the REST path are in the chat group; lifting a block restores delivery
    and destroys nothing, so it must not need a destructive grant (a `delete_` name would have required one)."""
    from app.services.mcp_toolset import ALL_TOOL_NAMES, is_destructive, path_to_tool_group, tool_group

    for name in ("sprintable_list_user_blocks", "sprintable_remove_user_block"):
        assert name in ALL_TOOL_NAMES
        assert tool_group(name) == "chat"
        assert not is_destructive(name)
    assert path_to_tool_group("/api/v2/user-blocks") == "chat"
    assert path_to_tool_group(f"/api/v2/user-blocks/{uuid.uuid4()}") == "chat"
