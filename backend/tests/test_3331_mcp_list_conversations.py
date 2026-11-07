"""story #3331(74be44d1) — MCP `sprintable_list_conversations` 신설. 에이전트가 «자기
conversation 목록»을 조회할 수단이 없어(id를 이미 알아야 읽히는 send/list_chat_messages/
get_chat_message뿐) 채널로 밀려오지 않은 방의 존재 자체를 몰랐던 결함(실사고: 담롱↔선생님
DM 896235be에 담롱 앞 결재 카드 2장이 있었는데도 세션 내내 발견 못 함) 처방.

신규 REST 없음 — 기존 `GET /api/v2/conversations`(conversations.py::list_conversations)를
그대로 노출한다. 지어내지 않음 축: 이 REST가 실제로 받는 파라미터(project_id·
include_agent_conversations·limit·offset)만 노출하고 since/참여자 필터는 API 자체에 없어
추가하지 않았다(별도 API 확장 스토리)."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


_LIST_RESP = {
    "data": [
        {
            "id": "896235be-0000-0000-0000-000000000001", "type": "dm", "title": None,
            "status": "open", "participants": [{"id": "p1", "name": "담롱"}, {"id": "p2", "name": "선생님"}],
            "muted": False, "last_read_at": None, "unread_count": 2,
            "latest_message": {"content": "결재 요청", "created_at": "2026-09-02T07:06:21.065Z"},
            "updated_at": "2026-09-02T07:06:21.065Z",
        },
    ],
    "total": 1, "limit": 30, "offset": 0,
}


@pytest.mark.anyio
async def test_list_conversations_calls_existing_rest_endpoint_with_resolved_project_id():
    """⭐AC1/AC4 핵심 — 신규 REST 0, 기존 GET /api/v2/conversations를 그대로 호출한다.
    project_id는 client.require_project_id()로 해소(create_conversation과 동형 관례)."""
    from sprintable_mcp.tools.chat import ListConversationsInput, list_conversations

    calls: list[tuple[str, dict | None]] = []

    async def fake_get_full(path, params=None):
        calls.append((path, params))
        return _LIST_RESP

    with patch("sprintable_mcp.tools.chat.client") as mock_client:
        mock_client.require_project_id.return_value = "proj-1"
        mock_client.get_full = AsyncMock(side_effect=fake_get_full)
        out = await list_conversations(ListConversationsInput())

    # story #4846: no project argument = every room I am in (the organization's list), not «the default project's»; no «ambiguous» error either
    assert calls == [("/api/v2/conversations", {})]
    mock_client.require_project_id.assert_not_called()
    parsed = json.loads(out[0].text)
    # AC1 — 목록 항목이 id·제목·참여자·마지막 메시지 시각·미읽음 수를 담고 있다(REST가 이미
    # 주는 값을 그대로 통과·지어내지 않음).
    assert parsed["data"][0]["id"] == "896235be-0000-0000-0000-000000000001"
    assert parsed["data"][0]["unread_count"] == 2
    assert parsed["data"][0]["latest_message"]["content"] == "결재 요청"
    # ⭐total/limit/offset sibling이 살아있어야 한다(get_full — unwrap=False 확認, data만
    # 남기고 페이지네이션 메타를 버리면 안 됨).
    assert parsed["total"] == 1
    assert parsed["limit"] == 30


@pytest.mark.anyio
async def test_list_conversations_include_agent_conversations_flag_passed_as_string_true():
    """include_agent_conversations=True면 쿼리 파라미터로 실려 간다(owner/admin 전용은 서버가
    403으로 강제 — 도구 쪽에서 role을 미리 판단하지 않는다, 지어내지 않음)."""
    from sprintable_mcp.tools.chat import ListConversationsInput, list_conversations

    calls: list[tuple[str, dict | None]] = []

    async def fake_get_full(path, params=None):
        calls.append((path, params))
        return _LIST_RESP

    with patch("sprintable_mcp.tools.chat.client") as mock_client:
        mock_client.require_project_id.return_value = "proj-1"
        mock_client.get_full = AsyncMock(side_effect=fake_get_full)
        await list_conversations(ListConversationsInput(include_agent_conversations=True))

    # the admin's view of the agents' rooms is of ONE project: the key's project (there is no project argument here)
    assert calls[0][1] == {"project_id": "proj-1", "include_agent_conversations": "true"}


@pytest.mark.anyio
async def test_list_conversations_omits_absent_optional_params():
    """limit/offset 미지정이면 쿼리에 안 실린다(REST 자체 기본값에 위임 — 지어낸 기본값을
    도구가 강제하지 않음)."""
    from sprintable_mcp.tools.chat import ListConversationsInput, list_conversations

    calls: list[tuple[str, dict | None]] = []

    async def fake_get_full(path, params=None):
        calls.append((path, params))
        return _LIST_RESP

    with patch("sprintable_mcp.tools.chat.client") as mock_client:
        mock_client.require_project_id.return_value = "proj-1"
        mock_client.get_full = AsyncMock(side_effect=fake_get_full)
        await list_conversations(ListConversationsInput())

    assert "limit" not in calls[0][1]
    assert "offset" not in calls[0][1]
    assert "include_agent_conversations" not in calls[0][1]


@pytest.mark.anyio
async def test_list_conversations_limit_offset_stringified_and_passed():
    from sprintable_mcp.tools.chat import ListConversationsInput, list_conversations

    calls: list[tuple[str, dict | None]] = []

    async def fake_get_full(path, params=None):
        calls.append((path, params))
        return _LIST_RESP

    with patch("sprintable_mcp.tools.chat.client") as mock_client:
        mock_client.require_project_id.return_value = "proj-1"
        mock_client.get_full = AsyncMock(side_effect=fake_get_full)
        await list_conversations(ListConversationsInput(limit=10, offset=20))

    assert calls[0][1] == {"limit": "10", "offset": "20"}


@pytest.mark.anyio
async def test_list_conversations_project_id_argument_filters_and_only_without_project_asks_for_none():
    """story #4846 (AC5): `project_id` (the base-class field) is now a FILTER — given, the query carries it; `only_without_project` asks for the rooms
    that have no project (`none`); the two together are refused."""
    from sprintable_mcp.tools.chat import ListConversationsInput, list_conversations

    calls: list[tuple[str, dict | None]] = []

    async def fake_get_full(path, params=None):
        calls.append((path, params))
        return _LIST_RESP

    with patch("sprintable_mcp.tools.chat.client") as mock_client:
        mock_client.get_full = AsyncMock(side_effect=fake_get_full)
        await list_conversations(ListConversationsInput(project_id="proj-9"))
        await list_conversations(ListConversationsInput(only_without_project=True))
        both = await list_conversations(ListConversationsInput(project_id="proj-9", only_without_project=True))

    assert calls[0][1] == {"project_id": "proj-9"}
    assert calls[1][1] == {"project_id": "none"}
    assert len(calls) == 2 and "error" in both[0].text.lower()


@pytest.mark.anyio
async def test_the_admins_agent_view_keeps_the_none_filter_and_the_explicit_project():
    """the admin's view of the agents' rooms: `only_without_project` asks for the ones without a project (`none` is not replaced by the key's default);
    an explicit project is kept; with neither, the key's default project."""
    from sprintable_mcp.tools.chat import ListConversationsInput, list_conversations

    calls: list[dict | None] = []

    async def fake_get_full(path, params=None):
        calls.append(params)
        return _LIST_RESP

    with patch("sprintable_mcp.tools.chat.client") as mock_client:
        mock_client.require_project_id.return_value = "default-proj"
        mock_client.get_full = AsyncMock(side_effect=fake_get_full)
        await list_conversations(ListConversationsInput(include_agent_conversations=True, only_without_project=True))
        await list_conversations(ListConversationsInput(include_agent_conversations=True, project_id="proj-9"))
        await list_conversations(ListConversationsInput(include_agent_conversations=True))

    assert calls == [
        {"project_id": "none", "include_agent_conversations": "true"},
        {"project_id": "proj-9", "include_agent_conversations": "true"},
        {"project_id": "default-proj", "include_agent_conversations": "true"},
    ]


@pytest.mark.anyio
async def test_list_conversations_with_several_projects_is_not_an_error():
    """AC5: a key that reaches several projects (no default) lists the organization's rooms — `require_project_id` is never asked."""
    from sprintable_mcp.api_client import SprintableApiError
    from sprintable_mcp.tools.chat import ListConversationsInput, list_conversations

    async def fake_get_full(path, params=None):
        return _LIST_RESP

    with patch("sprintable_mcp.tools.chat.client") as mock_client:
        mock_client.require_project_id.side_effect = SprintableApiError(400, "여러 프로젝트에 접근 가능한 키입니다.")
        mock_client.get_full = AsyncMock(side_effect=fake_get_full)
        out = await list_conversations(ListConversationsInput())

    assert "error" not in out[0].text.lower()


@pytest.mark.anyio
async def test_list_conversations_error_surfaces():
    """project_id ambiguous 등 client.require_project_id()가 던지는 SprintableApiError도
    다른 도구와 동형으로 err()에 담겨 나간다(create_conversation과 동일 관례)."""
    from sprintable_mcp.tools.chat import ListConversationsInput, list_conversations

    with patch("sprintable_mcp.tools.chat.client") as mock_client:
        mock_client.require_project_id.side_effect = Exception("여러 프로젝트에 접근 가능한 키입니다.")
        out = await list_conversations(ListConversationsInput(include_agent_conversations=True))

    assert "error" in out[0].text.lower()


@pytest.mark.anyio
async def test_create_conversation_unaffected_still_posts_new_room_every_call():
    """회귀 0 — create_conversation은 여전히 «만드는» 도구다(dedup 없음)."""
    from sprintable_mcp.tools.chat import CreateConversationInput, create_conversation

    calls: list[tuple[str, dict]] = []

    async def fake_post(path, json=None):
        calls.append((path, json))
        return {"id": "new-conv", "type": "group", "title": None, "existing": False}

    with patch("sprintable_mcp.tools.chat.client") as mock_client:
        mock_client.project_id = "proj-1"
        mock_client.post = AsyncMock(side_effect=fake_post)
        out = await create_conversation(CreateConversationInput(participant_ids=["p1", "p2"]))

    assert [c[0] for c in calls] == ["/api/v2/conversations"]
    assert calls[0][1]["project_id"] == "proj-1"          # the key's default project, as before, when it has one
    parsed = json.loads(out[0].text)
    assert parsed["conversation_id"] == "new-conv"


@pytest.mark.anyio
async def test_create_conversation_project_is_optional_and_never_an_ambiguity_error():
    """story #4846 (AC5): the project given → that one; none given and the key has no single default → the room has NO project (no «여러 프로젝트» error)."""
    from sprintable_mcp.tools.chat import CreateConversationInput, create_conversation

    bodies: list[dict] = []

    async def fake_post(path, json=None):
        bodies.append(json)
        return {"id": "new-conv"}

    with patch("sprintable_mcp.tools.chat.client") as mock_client:
        mock_client.project_id = None
        mock_client.post = AsyncMock(side_effect=fake_post)
        await create_conversation(CreateConversationInput(participant_ids=["p1"], project_id="proj-7"))
        out = await create_conversation(CreateConversationInput(participant_ids=["p1"]))

    assert bodies[0]["project_id"] == "proj-7"
    assert "project_id" not in bodies[1] and "error" not in out[0].text.lower()
    mock_client.require_project_id.assert_not_called()


def test_list_conversations_registered_in_tool_registry():
    """⭐AC — server.py TOOLS에 등재돼 있고, 설명 첫 문장이 PO가 지시한 백스톱 문구를 담는다."""
    from sprintable_mcp.server import _TOOL_DEFS as TOOLS

    matches = [t for t in TOOLS if t[0] == "sprintable_list_conversations"]
    assert len(matches) == 1, "sprintable_list_conversations가 TOOLS에 정확히 1건 등재돼야 함"
    _name, description, input_model, fn = matches[0]
    assert "내가 참여한 방 목록" in description
    assert "프로젝트 없는 방" in description and "only_without_project" in description
    assert "백스톱" in description
    from sprintable_mcp.tools.chat import ListConversationsInput, list_conversations
    assert input_model is ListConversationsInput
    assert fn is list_conversations


def test_create_conversation_description_warns_against_lookup_misuse():
    """⭐AC5 회귀 — create_conversation 도구 설명이 "조회 아님·list_conversations를 쓸 것"을
    명시(처방4 우려의 문서측 처방 — 백엔드 dedup 동작 자체는 EF-S2 기존 설계라 무변경)."""
    from sprintable_mcp.server import _TOOL_DEFS as TOOLS

    matches = [t for t in TOOLS if t[0] == "sprintable_create_conversation"]
    assert len(matches) == 1
    _name, description, _input_model, _fn = matches[0]
    assert "list_conversations" in description
    assert "조회" in description
