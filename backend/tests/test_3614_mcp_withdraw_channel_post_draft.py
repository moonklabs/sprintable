"""story #3614(Phase2·MCP, 페드루 PO 確定 2026-09-07) — sprintable_withdraw_channel_post_
draft 도구. tools/decisions.py 등 기존 단순 POST 위임 도구와 동형(새 판정 로직 0, 그대로
BE에 위임) — 이 도구의 관심사는 URL 조립(org_id 경로 삽입)과 응답 언래핑뿐이다.

test_2389_mcp_update_field_wiring.py의 _RecordingPatch 관례를 재사용(새 mock 패턴 발명 0)."""
from __future__ import annotations

import json as jsonlib
import sys

import pytest

sys.path.insert(0, ".")

pytestmark = pytest.mark.anyio


class _RecordingPost:
    def __init__(self, response: dict | None = None):
        self.calls: list[tuple[str, dict | None]] = []
        self._response = response if response is not None else {"status": "withdrawn", "gate_id": None, "gate_status": None}

    async def __call__(self, path: str, *, json: dict | None = None):
        self.calls.append((path, json))
        return self._response

    @property
    def last_path(self) -> str:
        return self.calls[-1][0]


async def test_withdraw_posts_to_org_scoped_url_with_draft_id(monkeypatch):
    """URL이 `/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/withdraw`로
    정확히 조립되는지 — 이 도구의 유일한 관심사(판정 로직은 전부 BE 몫)."""
    from sprintable_mcp.tools import channel_posts

    recorder = _RecordingPost()
    monkeypatch.setattr(channel_posts.client, "post", recorder)
    monkeypatch.setattr(type(channel_posts.client), "org_id", property(lambda self: "org-123"))

    result = await channel_posts.withdraw_channel_post_draft(
        channel_posts.WithdrawChannelPostDraftInput(draft_id="draft-abc"),
    )

    assert recorder.last_path == "/api/v2/organizations/org-123/channel-posts/drafts/draft-abc/withdraw"
    body = jsonlib.loads(result[0].text)
    assert body["status"] == "withdrawn"


async def test_withdraw_surfaces_be_error_as_text(monkeypatch):
    """BE가 403/409 등을 던지면(SprintableApiError) 이 도구는 그 메시지를 그대로
    err()로 감싸 텍스트로 낸다 — 삼키지 않는다(tools/decisions.py와 동형 관례)."""
    from sprintable_mcp.tools import channel_posts
    from sprintable_mcp.api_client import SprintableApiError

    async def _raise(path: str, *, json: dict | None = None):
        raise SprintableApiError(403, "이 초안을 폐기할 권한이 없습니다", None)

    monkeypatch.setattr(channel_posts.client, "post", _raise)
    monkeypatch.setattr(type(channel_posts.client), "org_id", property(lambda self: "org-123"))

    result = await channel_posts.withdraw_channel_post_draft(
        channel_posts.WithdrawChannelPostDraftInput(draft_id="draft-abc"),
    )
    assert result[0].text.startswith("Error:")
    assert "권한이 없습니다" in result[0].text
