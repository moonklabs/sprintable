"""story #4581(E-DESKTOP-2 · 1선, 페드루 PO 判定 2026-10-06 08:59Z) — 런처의 sprintable-channel 플러그인에만 있던
채널 · 사이트 글 도구 11종을 호스티드 MCP로. 데스크톱 앱 세션은 이 서버를 sprintable-desktop으로 대리해 쓰므로
여기 있으면 앱으로 옮긴 에이전트도 같은 도구를 갖는다.

이 도구들의 관심사는 판정이 아니라(전부 BE 몫) 「플러그인과 같은 REST를 같은 body로」뿐이다 — 경로 조립(조직은
늘 키의 조직 = client.org_id · 인자로 못 바꿈), body 키, 거절을 삼키지 않고 그대로 돌려줌, 그룹(content).
test_3614_mcp_withdraw_channel_post_draft.py의 기록 목(mock) 관례를 그대로 쓴다."""
from __future__ import annotations

import json as jsonlib
import sys

import pytest
from pydantic import ValidationError

sys.path.insert(0, ".")

pytestmark = pytest.mark.anyio

ORG = "org-123"


class _Recorder:
    def __init__(self, response: object | None = None):
        self.calls: list[tuple[str, str, dict | None]] = []
        self._response = response if response is not None else {"ok": True}

    def method(self, name: str):
        async def _call(path: str, *, json: dict | None = None, params: dict | None = None):
            self.calls.append((name, path, json))
            return self._response
        return _call


def _wire(monkeypatch, module, response: object | None = None) -> _Recorder:
    rec = _Recorder(response)
    monkeypatch.setattr(module.client, "post", rec.method("POST"))
    monkeypatch.setattr(module.client, "get", rec.method("GET"))
    monkeypatch.setattr(type(module.client), "org_id", property(lambda self: ORG))
    return rec


async def test_channel_post_tools_call_the_plugin_rest_with_the_plugin_body(monkeypatch):
    from sprintable_mcp.tools import channel_posts as cp

    rec = _wire(monkeypatch, cp)
    await cp.create_channel_post_draft(cp.CreateChannelPostDraftInput(work_item_id="w1", connection_id="c1", text="hello", link_url="https://x.test", hook_key="h-1"))
    await cp.create_channel_post_draft(cp.CreateChannelPostDraftInput(work_item_id="w1", connection_id="c1", text="again"))
    await cp.submit_channel_post_draft(cp.SubmitChannelPostDraftInput(draft_id="d1"))
    await cp.submit_channel_post_draft(cp.SubmitChannelPostDraftInput(draft_id="d1", version_id="v2"))
    await cp.get_channel_post_publication(cp.GetChannelPostPublicationInput(draft_id="d1"))
    await cp.list_channel_connections(cp.ListChannelConnectionsInput())
    await cp.get_my_channel_connection_status(cp.GetMyChannelConnectionStatusInput(work_item_type="story", work_item_id="w 1/x"))
    await cp.attach_channel_post_image(cp.AttachChannelPostImageInput(draft_id="d1", image_base64="aGk=", content_type="image/png"))
    await cp.get_channel_post_video_upload_url(cp.GetChannelPostVideoUploadUrlInput(draft_id="d1", content_type="video/mp4"))
    await cp.confirm_channel_post_video(cp.ConfirmChannelPostVideoInput(draft_id="d1", object_path="o/p.mp4"))
    base = f"/api/v2/organizations/{ORG}/channel-posts/drafts"
    assert rec.calls == [
        ("POST", base, {"work_item_id": "w1", "connection_id": "c1", "text": "hello", "link_url": "https://x.test", "hook_key": "h-1"}),
        ("POST", base, {"work_item_id": "w1", "connection_id": "c1", "text": "again", "link_url": None, "hook_key": None}),
        ("POST", f"{base}/d1/submit", {"version_id": None}),
        ("POST", f"{base}/d1/submit", {"version_id": "v2"}),
        ("GET", f"{base}/d1", None),
        # the agent-visible list (no credential fields) — never the full connections endpoint
        ("GET", f"/api/v2/organizations/{ORG}/channel-connections/agent-visible", None),
        # path segments quoted: a work item id with a slash or a space stays one segment
        ("GET", "/api/v2/events/work-items/story/w%201%2Fx/channel-connection", None),
        ("POST", f"{base}/d1/assets/import-image", {"image_base64": "aGk=", "content_type": "image/png"}),
        ("POST", f"{base}/d1/assets/video/upload-url", {"content_type": "video/mp4"}),
        ("POST", f"{base}/d1/assets/video/confirm", {"object_path": "o/p.mp4"}),
    ]


async def test_site_post_tools_carry_forward_what_is_not_given(monkeypatch):
    """campaign_id · connection_id: not given → the key is not in the body (the server keeps the earlier value); given — even
    null — it is sent (null = clear). The plugin's contract (site-posts.ts), the same here."""
    from sprintable_mcp.tools import site_posts as sp

    rec = _wire(monkeypatch, sp)
    common = {"work_item_id": "w1", "title": "T", "slug": "t", "lang": "ko", "summary": "S", "body_md": "# B"}
    await sp.create_site_post_draft(sp.CreateSitePostDraftInput(**common))
    await sp.create_site_post_draft(sp.CreateSitePostDraftInput(**common, tags=["a"], campaign_id="camp", connection_id=None))
    await sp.submit_site_post_draft(sp.SubmitSitePostDraftInput(draft_id="d9"))
    await sp.get_site_post_publication(sp.GetSitePostPublicationInput(draft_id="d9"))
    base = f"/api/v2/organizations/{ORG}/site-posts/drafts"
    first, second = rec.calls[0][2], rec.calls[1][2]
    assert first == {**common, "tags": [], "media_manifest": []}
    assert "campaign_id" not in first and "connection_id" not in first
    assert second == {**common, "tags": ["a"], "media_manifest": [], "campaign_id": "camp", "connection_id": None}
    assert rec.calls[2:] == [("POST", f"{base}/d9/submit", {"version_id": None}), ("GET", f"{base}/d9/publication", None)]


async def test_the_organization_is_always_the_keys_never_an_argument(monkeypatch):
    """AC2: the path's organization is the key's (client.org_id) — an org_id argument is refused, not used."""
    from sprintable_mcp.tools import channel_posts as cp
    from sprintable_mcp.tools import site_posts as sp

    for model, extra in (
        (cp.CreateChannelPostDraftInput, {"work_item_id": "w", "connection_id": "c", "text": "t"}),
        (cp.ListChannelConnectionsInput, {}),
        (cp.GetChannelPostPublicationInput, {"draft_id": "d"}),
        (sp.SubmitSitePostDraftInput, {"draft_id": "d"}),
    ):
        with pytest.raises(ValidationError):
            model(**extra, org_id="another-org")


async def test_a_refusal_comes_back_as_the_servers_words_never_swallowed(monkeypatch):
    """The BE's refusals (409 CHANNEL_CONNECTION_NOT_ACTIVE · 403 another org · 404) reach the agent as an error text."""
    from sprintable_mcp.api_client import SprintableApiError
    from sprintable_mcp.tools import channel_posts as cp
    from sprintable_mcp.tools import site_posts as sp

    async def _refuse(path: str, *, json: dict | None = None, params: dict | None = None):
        raise SprintableApiError(409, "channel connection is not active", {"code": "CHANNEL_CONNECTION_NOT_ACTIVE"})

    for module in (cp, sp):
        monkeypatch.setattr(module.client, "post", _refuse)
        monkeypatch.setattr(module.client, "get", _refuse)
        monkeypatch.setattr(type(module.client), "org_id", property(lambda self: ORG))
    for result in (
        await cp.create_channel_post_draft(cp.CreateChannelPostDraftInput(work_item_id="w", connection_id="c", text="t")),
        await cp.list_channel_connections(cp.ListChannelConnectionsInput()),
        await sp.get_site_post_publication(sp.GetSitePostPublicationInput(draft_id="d")),
    ):
        assert result[0].text.startswith("Error:")
        assert "not active" in result[0].text


async def test_an_answer_is_passed_through_as_json(monkeypatch):
    from sprintable_mcp.tools import channel_posts as cp

    _wire(monkeypatch, cp, response={"draft_id": "d1", "version": 2})
    result = await cp.create_channel_post_draft(cp.CreateChannelPostDraftInput(work_item_id="w", connection_id="c", text="t"))
    assert jsonlib.loads(result[0].text)["version"] == 2


def test_every_new_tool_is_registered_in_the_content_group_and_listed():
    """Registered on the server · in ALL_TOOL_NAMES · grouped «content» (a content-scoped agent sees them; an agent with the
    app's all-groups key does too) · and their REST paths pass a content-only scope."""
    from app.services.mcp_toolset import ALL_TOOL_NAMES, path_allowed_for_scope, tool_group
    from sprintable_mcp.server import _TOOL_DEFS

    new = {
        "sprintable_create_channel_post_draft", "sprintable_submit_channel_post_draft", "sprintable_get_channel_post_publication",
        "sprintable_list_channel_connections", "sprintable_get_my_channel_connection_status", "sprintable_attach_channel_post_image",
        "sprintable_get_channel_post_video_upload_url", "sprintable_confirm_channel_post_video", "sprintable_create_site_post_draft",
        "sprintable_submit_site_post_draft", "sprintable_get_site_post_publication",
    }
    registered = {d[0] for d in _TOOL_DEFS}
    assert new <= registered
    assert new <= set(ALL_TOOL_NAMES)
    assert {tool_group(n) for n in new} == {"content"}
    for path in (
        f"/api/v2/organizations/{ORG}/channel-posts/drafts/d/submit",
        f"/api/v2/organizations/{ORG}/site-posts/drafts/d/publication",
        f"/api/v2/organizations/{ORG}/channel-connections/agent-visible",
        "/api/v2/events/work-items/story/w/channel-connection",
    ):
        assert path_allowed_for_scope(path, ["content"]), path


def test_the_plugins_left_out_tools_are_not_here():
    """PO 08:59Z: the frozen publishers · edit_message (it never edited) · approval_prompt · connector admin · the generation
    connector (plaintext credentials) do not come over."""
    from sprintable_mcp.server import _TOOL_DEFS

    names = {d[0] for d in _TOOL_DEFS}
    for gone in ("publish_stibee_campaign", "publish_instagram_post", "publish_site_post", "edit_message", "approval_prompt",
                 "register_connector_schema", "set_connector_config", "get_generation_connector", "get_threads_insights"):
        assert f"sprintable_{gone}" not in names
