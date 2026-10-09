"""story 4646 AC4 — 등록된 MCP 도구 길로 사진 응답이 나가는지 고정한다.

단위 시험이 도구 함수를 직접 부르면 wrapper의 출력 스키마(list[TextContent] 고정)를 거치지 않아
PO 실측에서 「result.1 · ImageContent 거부」가 시험을 빠져나갔다. 여기서는 server.mcp.call_tool로
등록 경로를 탄다. mcp 2.0.0(uv.lock 고정)에서 뮤턴트(wrapper가 list[TextContent]로 고정)는 RED.
"""
import asyncio
import base64
from unittest.mock import AsyncMock, patch

from mcp.types import ImageContent

from sprintable_mcp import server as srv

_TOOL = "sprintable_get_chat_attachment"
_IMG = base64.b64encode(b"\xff\xd8\xff\xe0fake-jpeg-bytes").decode()
_PAYLOAD = {
    "kind": "image", "name": "p.jpg", "content_type": "image/jpeg", "size": 9,
    "reason": None, "width": 10, "height": 10, "data_base64": _IMG, "text": None,
}


async def _call_through_registered_tool():
    # 진짜 네트워크를 막는다: 키 scope 조회(/api/v2/mcp/manifest)는 fail-open 값으로, wrapper가 띄우는 heartbeat는 패치로.
    # heartbeat task는 호출 뒤 끝나도록 한 번 양보한다.
    with patch("sprintable_mcp.tools.chat_attachment.client") as client, \
            patch.object(srv, "_load_scope_for", AsyncMock(return_value=srv._SCOPE_FAILOPEN)), \
            patch.object(srv, "_heartbeat_fire_forget", AsyncMock()):
        client.get = AsyncMock(return_value=_PAYLOAD)
        result = await srv.mcp.call_tool(_TOOL, {
            "conversation_id": "97ee5509-0000-4000-8000-000000000000",
            "message_id": "22350474-c98f-46d0-9ec4-1aeb28dd606a",
            "index": 0,
        })
        await asyncio.sleep(0)
        return result


def test_registered_tool_returns_image_content_through_mcp_call_path():
    result = asyncio.run(_call_through_registered_tool())
    content = result.content if hasattr(result, "content") else result[0]
    images = [c for c in content if isinstance(c, ImageContent)]
    assert len(images) == 1, content
    assert images[0].data == _IMG and images[0].mime_type == "image/jpeg"


def test_output_annotation_follows_image_declaring_tools_only():
    # 사진을 돌려주는 도구는 자기 반환 주석을 따르고, 그 밖의 도구는 종전 list[TextContent]를 그대로 둔다.
    from mcp.types import TextContent

    def text_tool() -> list[TextContent]:
        return []

    def image_tool() -> list[TextContent | ImageContent]:
        return []

    assert srv._output_annotation(text_tool) == list[TextContent]
    assert srv._output_annotation(image_tool) == list[TextContent | ImageContent]
