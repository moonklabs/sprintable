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

    assert calls == [("/api/v2/conversations", {"project_id": "proj-1"})]
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

    assert calls[0][1] == {"project_id": "proj-1", "limit": "10", "offset": "20"}


@pytest.mark.anyio
async def test_list_conversations_project_id_override_reaches_query_string():
    """⭐PO 변경요청①(2026-09-02, PR#3712 리뷰) — API가 project_id 필수(422·PO 실측)라 이
    도구는 «내가 참여한 방 전부»가 아니라 «기본 프로젝트 안의 내 방»이다(다중 프로젝트
    org에선 조용히 좁아짐). per-call project_id override(SprintableInput 상속 필드,
    E-MCP-OPT ff6cb90d 관례 — server.py wrapper가 kwargs["project_id"]를 contextvar로
    태운다)가 실제로 쿼리스트링에 반영되는지 실증. client를 통째로 mock하면 진짜
    require_project_id()의 override-우선 로직을 타지 않으므로, 여기선 get_full만 patch하고
    나머지는 실 client 싱글턴을 그대로 쓴다."""
    from sprintable_mcp.api_client import reset_project_override, set_project_override
    from sprintable_mcp.tools import chat as chat_mod

    calls: list[tuple[str, dict | None]] = []

    async def fake_get_full(path, params=None):
        calls.append((path, params))
        return _LIST_RESP

    original_project_id = chat_mod.client._project_id
    chat_mod.client._project_id = "default-project"
    tok = set_project_override("override-project")
    try:
        with patch.object(chat_mod.client, "get_full", new=AsyncMock(side_effect=fake_get_full)):
            await chat_mod.list_conversations(chat_mod.ListConversationsInput())
    finally:
        reset_project_override(tok)
        chat_mod.client._project_id = original_project_id

    assert calls[0][1]["project_id"] == "override-project"


@pytest.mark.anyio
async def test_list_conversations_error_surfaces():
    """project_id ambiguous 등 client.require_project_id()가 던지는 SprintableApiError도
    다른 도구와 동형으로 err()에 담겨 나간다(create_conversation과 동일 관례)."""
    from sprintable_mcp.tools.chat import ListConversationsInput, list_conversations

    with patch("sprintable_mcp.tools.chat.client") as mock_client:
        mock_client.require_project_id.side_effect = Exception("여러 프로젝트에 접근 가능한 키입니다.")
        out = await list_conversations(ListConversationsInput())

    assert "error" in out[0].text.lower()


@pytest.mark.anyio
async def test_create_conversation_unaffected_still_posts_new_room_every_call():
    """회귀 0 — create_conversation은 여전히 «만드는» 도구다(dedup 없음, 문서 문구만 갱신했지
    동작은 무변경). 이 PR이 create_conversation의 실제 생성 동작을 바꾸지 않았음을 고정."""
    from sprintable_mcp.tools.chat import CreateConversationInput, create_conversation

    calls: list[str] = []

    async def fake_post(path, json=None):
        calls.append(path)
        return {"id": "new-conv", "type": "group", "title": None, "existing": False}

    with patch("sprintable_mcp.tools.chat.client") as mock_client:
        mock_client.require_project_id.return_value = "proj-1"
        mock_client.post = AsyncMock(side_effect=fake_post)
        out = await create_conversation(CreateConversationInput(participant_ids=["p1", "p2"]))

    assert calls == ["/api/v2/conversations"]
    parsed = json.loads(out[0].text)
    assert parsed["conversation_id"] == "new-conv"


def test_list_conversations_registered_in_tool_registry():
    """⭐AC — server.py TOOLS에 등재돼 있고, 설명 첫 문장이 PO가 지시한 백스톱 문구를 담는다."""
    from sprintable_mcp.server import _TOOL_DEFS as TOOLS

    matches = [t for t in TOOLS if t[0] == "sprintable_list_conversations"]
    assert len(matches) == 1, "sprintable_list_conversations가 TOOLS에 정확히 1건 등재돼야 함"
    _name, description, input_model, fn = matches[0]
    assert "내가 참여한 방 목록" in description
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
