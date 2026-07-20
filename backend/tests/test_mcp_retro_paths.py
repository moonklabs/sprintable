"""fca4723d(C1) MCP 파라미터 동형 확인 중 발견: retro MCP 도구가 존재하지 않는
`/api/v2/retro-sessions` 경로를 호출하던 버그(실 라우터 prefix는 `/api/v2/retros` —
app/routers/retros.py:38) 회귀 방지. 기존에 이 모듈을 커버하는 테스트가 전무했음.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sprintable_mcp.tools import retro as r


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _client(**methods):
    c = MagicMock()
    c.project_id = "proj-1"
    c.org_id = "org-1"
    c.member_id = "member-1"
    c.require_project_id = MagicMock(return_value="proj-1")
    for name, ret in methods.items():
        setattr(c, name, AsyncMock(return_value=ret))
    return c


async def test_list_retro_sessions_calls_real_path():
    client = _client(get=[])
    with patch.object(r, "client", client):
        await r.list_retro_sessions(r.ListRetroSessionsInput())
    assert client.get.call_args.args[0] == "/api/v2/retros"


async def test_create_retro_session_calls_real_path():
    client = _client(post={"id": "s1"})
    with patch.object(r, "client", client):
        await r.create_retro_session(r.CreateRetroSessionInput(title="t"))
    assert client.post.call_args.args[0] == "/api/v2/retros"


async def test_vote_retro_item_calls_real_path():
    client = _client(request={"id": "v1"})
    with patch.object(r, "client", client):
        await r.vote_retro_item(r.VoteRetroItemInput(session_id="s1", item_id="i1", voter_id="u1"))
    assert client.request.call_args.args[1] == "/api/v2/retros/s1/items/i1/vote"


async def test_add_retro_action_calls_real_path():
    client = _client(request={"id": "a1"})
    with patch.object(r, "client", client):
        await r.add_retro_action(r.AddRetroActionInput(session_id="s1", title="t"))
    assert client.request.call_args.args[1] == "/api/v2/retros/s1/actions"


async def test_change_retro_phase_calls_real_path_with_phase_suffix():
    client = _client(request={"id": "s1"})
    with patch.object(r, "client", client):
        await r.change_retro_phase(r.ChangeRetroPhaseInput(session_id="s1", phase="vote"))
    assert client.request.call_args.args[1] == "/api/v2/retros/s1/phase"


async def test_add_retro_item_calls_real_path():
    client = _client(request={"id": "i1"})
    with patch.object(r, "client", client):
        await r.add_retro_item(r.AddRetroItemInput(session_id="s1", category="good", text="t", author_id="u1"))
    assert client.request.call_args.args[1] == "/api/v2/retros/s1/items"


async def test_export_retro_calls_real_path():
    client = _client(get={"markdown": ""})
    with patch.object(r, "client", client):
        await r.export_retro(r.ExportRetroInput(session_id="s1"))
    assert client.get.call_args.args[0] == "/api/v2/retros/s1/export"
