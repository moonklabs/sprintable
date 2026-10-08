"""story 4615 — an agent reads a story by its id through MCP (`sprintable_get_story`).

A desktop hand-over of a story carries `source="story:<id>"`, the title and only the start of the description (the server cuts the
description at 200 and never sends the acceptance criteria; the daemon cuts again at 300). Before this tool the only way back was
searching by title. These run the real MCP client (sprintable_mcp.api_client) over httpx into the in-process app (real PG), as an
agent with its own API key (the caller this is for) — the real response shape, the real scope check, the real 404:

  01 · the whole story: the description past the hand-over's cut · the acceptance criteria · status · assignee
  02 · another org's story id → 404, and nothing of that story in the answer
  03 · an id that does not exist → 404
  04 · the id is a UUID: a free string (a path that would normalize elsewhere) is refused before any request leaves the client
"""
from __future__ import annotations

import json
import os
import uuid

import httpx
import pytest

from tests.test_1994_backlink_api_realdb import _make_agent_member, _make_org, _make_project, _session_factory

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
    """The real MCP client, its HTTP answered by the in-process app (as test_4430). Returns the requests that reached the app."""
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


async def _agent_with_key(session, org_id, project_id) -> tuple[uuid.UUID, str]:
    from app.models.api_key import ApiKey
    from app.repositories.api_key import _generate_key

    agent_id = await _make_agent_member(session, org_id, project_id)
    raw_key, prefix, key_hash = _generate_key()
    session.add(ApiKey(id=uuid.uuid4(), team_member_id=agent_id, member_id=agent_id, key_prefix=prefix, key_hash=key_hash))
    await session.commit()
    return agent_id, raw_key


async def _story(session, org_id, project_id, *, title, description=None, acceptance_criteria=None, assignee_id=None):
    from app.models.pm import Story

    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status="in-progress",
        description=description, acceptance_criteria=acceptance_criteria, assignee_id=assignee_id,
    )
    session.add(story)
    await session.commit()
    return story.id


# a description whose second half is past the 200 the hand-over carries
_DESCRIPTION = "앞부분 " * 70 + "— 이 줄은 건넴에 실리지 않는 뒷부분: 원장 파일 경로는 minh/4615.md."
_AC = "AC1 get_story가 설명 · AC · 상태 · 담당을 한 번에.\nAC2 다른 조직 id는 404."


async def test_01_the_whole_story_by_its_id(monkeypatch):
    import sprintable_mcp.tools.stories as st

    assert len(_DESCRIPTION) > 300 and _DESCRIPTION.index("뒷부분") > 200
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            agent_id, raw_key = await _agent_with_key(session, org.id, project.id)
            story_id = await _story(session, org.id, project.id, title="4615 by id", description=_DESCRIPTION,
                                    acceptance_criteria=_AC, assignee_id=agent_id)

        from app.main import app

        app.dependency_overrides.clear()
        seen = _wire_client_to_app(monkeypatch, app, api_key=raw_key)

        # as an MCP call gives it: the id as a string (JSON)
        out = await st.get_story(st.GetStoryInput(story_id=str(story_id)))
        text = out[0].text
        assert not text.startswith("Error"), text
        body = json.loads(text)
        assert body["id"] == str(story_id)
        assert body["description"] == _DESCRIPTION  # the part after the hand-over's cut is here
        assert body["acceptance_criteria"] == _AC
        assert body["status"] == "in-progress"
        assert body["assignee_id"] == str(agent_id)
        assert "epic_id" in body
        assert [(r.method, r.url.path) for r in seen] == [("GET", f"/api/v2/stories/{story_id}")]
    finally:
        await engine.dispose()


async def test_02_another_orgs_story_is_404_and_nothing_of_it_comes_back(monkeypatch):
    import sprintable_mcp.tools.stories as st

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            _agent_id, raw_key = await _agent_with_key(session, org.id, project.id)
            other_org = await _make_org(session, name="Other")
            other_project = await _make_project(session, other_org.id)
            secret_title = f"other-org-secret-{uuid.uuid4().hex[:8]}"
            foreign_id = await _story(session, other_org.id, other_project.id, title=secret_title, description="never shown")

        from app.main import app

        app.dependency_overrides.clear()
        _wire_client_to_app(monkeypatch, app, api_key=raw_key)

        text = (await st.get_story(st.GetStoryInput(story_id=str(foreign_id))))[0].text
        assert text.startswith("Error"), text
        assert "NOT_FOUND" in text or "404" in text, text
        assert secret_title not in text and "never shown" not in text
    finally:
        await engine.dispose()


async def test_03_an_id_that_does_not_exist_is_404(monkeypatch):
    import sprintable_mcp.tools.stories as st

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            _agent_id, raw_key = await _agent_with_key(session, org.id, project.id)

        from app.main import app

        app.dependency_overrides.clear()
        _wire_client_to_app(monkeypatch, app, api_key=raw_key)

        text = (await st.get_story(st.GetStoryInput(story_id=str(uuid.uuid4()))))[0].text
        assert text.startswith("Error") and ("NOT_FOUND" in text or "404" in text), text
    finally:
        await engine.dispose()


async def test_04_the_id_is_a_uuid_never_a_free_string_in_the_path(monkeypatch):
    import pydantic

    import sprintable_mcp.tools.stories as st
    from app.main import app

    seen = _wire_client_to_app(monkeypatch, app, api_key="k")
    for bad in ("../tasks/00000000-0000-0000-0000-000000000000", "backlog", "", "story:" + str(uuid.uuid4())):
        with pytest.raises(pydantic.ValidationError):
            st.GetStoryInput(story_id=bad)
    assert seen == []
