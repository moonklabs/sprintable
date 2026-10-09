"""story 4646 AC4 — 등록된 MCP 도구 길로 사진이 나가는지, 그리고 키 scope 판정을 거치는지 고정한다.

단위 시험이 도구 함수를 직접 부르면 wrapper의 출력 스키마(list[TextContent] 고정)를 거치지 않아
PO 실측에서 「result.1 · ImageContent 거부」가 시험을 빠져나갔다. 여기서는 server.mcp.call_tool로
등록 경로를 탄다. 키 scope 조회(/api/v2/mcp/manifest)는 fail-open으로 패치하지 않고 실제 판정
함수(_load_scope_for → is_tool_allowed)를 그대로 거치게 하며, 조회 응답만 흉내 낸다.
mcp 2.0.0(uv.lock 고정 버전)에서 뮤턴트(wrapper가 list[TextContent] 고정)는 RED.
"""
import asyncio
import base64
import uuid
from unittest.mock import AsyncMock, patch

from mcp.types import ImageContent, TextContent

from sprintable_mcp import api_client as api
from sprintable_mcp import server as srv

_TOOL = "sprintable_get_chat_attachment"
_ARGS = {
    "conversation_id": "97ee5509-0000-4000-8000-000000000000",
    "message_id": "22350474-c98f-46d0-9ec4-1aeb28dd606a",
    "index": 0,
}
_IMG = base64.b64encode(b"\xff\xd8\xff\xe0fake-jpeg-bytes").decode()
_PAYLOAD = {
    "kind": "image", "name": "p.jpg", "content_type": "image/jpeg", "size": 9,
    "reason": None, "width": 10, "height": 10, "data_base64": _IMG, "text": None,
}


def _fake_get(scope):
    """manifest 경로는 주어진 scope를, 첨부 경로는 사진 본문을 돌려준다. 그 밖의 경로는 시험이 부르면 안 된다."""
    async def get(path, *args, **kwargs):
        if path.startswith("/api/v2/mcp/manifest"):
            return {"scope": scope}
        if path.endswith("/content"):
            return _PAYLOAD
        raise AssertionError(f"unexpected request in test: {path}")
    return get


async def _call_with_scope(scope):
    # 키마다 scope 캐시가 따로라, 시험끼리 캐시가 새지 않게 키를 매번 새로 만든다.
    key = f"k-4646-{uuid.uuid4().hex}"
    with patch.object(api.client, "get", AsyncMock(side_effect=_fake_get(scope))) as get, \
            patch.object(srv.settings, "agent_api_key", key), \
            patch.object(srv, "_heartbeat_fire_forget", AsyncMock()):
        result = await srv.mcp.call_tool(_TOOL, _ARGS)
        await asyncio.sleep(0)  # heartbeat(패치됨) task가 끝나도록 한 번 양보
        return result, get


def test_granted_scope_returns_one_image_through_the_registered_tool():
    result, _ = asyncio.run(_call_with_scope(["chat"]))
    content = result.content if hasattr(result, "content") else result[0]
    images = [c for c in content if isinstance(c, ImageContent)]
    assert len(images) == 1, content
    assert images[0].data == _IMG and images[0].mime_type == "image/jpeg"


def test_scope_without_the_tool_is_refused_and_no_attachment_is_read():
    result, get = asyncio.run(_call_with_scope(["tasks"]))
    content = result.content if hasattr(result, "content") else result[0]
    assert not any(isinstance(c, ImageContent) for c in content), content
    assert any(isinstance(c, TextContent) and '"code": 403' in c.text for c in content), content
    paths = [c.args[0] for c in get.call_args_list]
    assert not any(p.endswith("/content") for p in paths), paths


def test_output_annotation_follows_image_declaring_tools_only():
    # 사진을 돌려주는 도구는 자기 반환 주석을 따르고, 그 밖의 도구는 종전 list[TextContent]를 그대로 둔다.
    def text_tool() -> list[TextContent]:
        return []

    def image_tool() -> list[TextContent | ImageContent]:
        return []

    assert srv._output_annotation(text_tool) == list[TextContent]
    assert srv._output_annotation(image_tool) == list[TextContent | ImageContent]
