"""1f01c1ad: dispatched 이벤트 CC relay 갭 — discord 채널 에이전트에 Discord webhook relay.

SSE wake_agent만으로는 MCP SSE 브릿지(on_event=None) 탓에 CC 세션에 미전달.
discord channel preference + 활성 Discord webhook 있는 agent에게 POST relay 추가.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _make_pref(channel: str) -> MagicMock:
    p = MagicMock()
    p.channel = channel
    return p


def _make_wh(url: str) -> MagicMock:
    wh = MagicMock()
    wh.url = url
    return wh


def _mock_db_factory(pref, wh=None):
    """NotificationPreference + WebhookConfig 조회를 모킹하는 DB factory."""
    mock_db = AsyncMock()

    def make_result(obj):
        r = MagicMock()
        r.scalars.return_value.first.return_value = obj
        return r

    side_effects = [make_result(pref)]
    if wh is not None:
        side_effects.append(make_result(wh))

    mock_db.execute = AsyncMock(side_effect=side_effects)
    mock_db.__aenter__ = AsyncMock(return_value=mock_db)
    mock_db.__aexit__ = AsyncMock(return_value=False)
    return mock_db


# ── _relay_dispatched_to_discord 단위 테스트 ──────────────────────────────────

@pytest.mark.anyio
async def test_relay_discord_channel_calls_webhook():
    """discord 채널 preference + 활성 Discord webhook → POST 호출."""
    agent_id = uuid.uuid4()
    event_id = uuid.uuid4()
    wh_url = "https://discord.com/api/webhooks/123/abc"

    mock_db = _mock_db_factory(_make_pref("discord"), _make_wh(wh_url))

    mock_resp = MagicMock()
    mock_resp.status_code = 204

    mock_http = AsyncMock()
    mock_http.post = AsyncMock(return_value=mock_resp)
    mock_http.__aenter__ = AsyncMock(return_value=mock_http)
    mock_http.__aexit__ = AsyncMock(return_value=False)

    with patch("app.core.database.async_session_factory", return_value=mock_db), \
         patch("app.routers.dispatch.httpx.AsyncClient", return_value=mock_http):

        from app.routers.dispatch import _relay_dispatched_to_discord
        await _relay_dispatched_to_discord(event_id, agent_id, "[story] My Story")

    mock_http.post.assert_called_once()
    call_json = mock_http.post.call_args.kwargs["json"]
    assert call_json == {"content": "[story] My Story"}


@pytest.mark.anyio
async def test_relay_sse_channel_skips_webhook():
    """sse 채널 preference → Discord relay 스킵 (wake_agent SSE로 충분)."""
    agent_id = uuid.uuid4()
    event_id = uuid.uuid4()

    mock_db = _mock_db_factory(_make_pref("sse"))

    mock_http = AsyncMock()
    mock_http.__aenter__ = AsyncMock(return_value=mock_http)
    mock_http.__aexit__ = AsyncMock(return_value=False)

    with patch("app.core.database.async_session_factory", return_value=mock_db), \
         patch("app.routers.dispatch.httpx.AsyncClient", return_value=mock_http):

        from app.routers.dispatch import _relay_dispatched_to_discord
        await _relay_dispatched_to_discord(event_id, agent_id, "[story] My Story")

    mock_http.post.assert_not_called()


@pytest.mark.anyio
async def test_relay_discord_channel_no_webhook_config_skips():
    """discord 채널 preference + 활성 webhook 없음 → 스킵 (SSE fallback으로 충분)."""
    agent_id = uuid.uuid4()
    event_id = uuid.uuid4()

    mock_db = _mock_db_factory(_make_pref("discord"), None)

    mock_http = AsyncMock()
    mock_http.__aenter__ = AsyncMock(return_value=mock_http)
    mock_http.__aexit__ = AsyncMock(return_value=False)

    with patch("app.core.database.async_session_factory", return_value=mock_db), \
         patch("app.routers.dispatch.httpx.AsyncClient", return_value=mock_http):

        from app.routers.dispatch import _relay_dispatched_to_discord
        await _relay_dispatched_to_discord(event_id, agent_id, "[story] My Story")

    mock_http.post.assert_not_called()


@pytest.mark.anyio
async def test_relay_non_discord_url_sends_full_payload():
    """discord.com URL이 아닌 일반 webhook URL → full JSON payload (event_type+event_id+content)."""
    agent_id = uuid.uuid4()
    event_id = uuid.uuid4()
    wh_url = "https://my-relay.internal/webhook"

    mock_db = _mock_db_factory(_make_pref("discord"), _make_wh(wh_url))

    mock_resp = MagicMock()
    mock_resp.status_code = 200

    mock_http = AsyncMock()
    mock_http.post = AsyncMock(return_value=mock_resp)
    mock_http.__aenter__ = AsyncMock(return_value=mock_http)
    mock_http.__aexit__ = AsyncMock(return_value=False)

    with patch("app.core.database.async_session_factory", return_value=mock_db), \
         patch("app.routers.dispatch.httpx.AsyncClient", return_value=mock_http):

        from app.routers.dispatch import _relay_dispatched_to_discord
        await _relay_dispatched_to_discord(event_id, agent_id, "[doc] My Doc")

    call_json = mock_http.post.call_args.kwargs["json"]
    assert call_json["event_type"] == "dispatched"
    assert call_json["event_id"] == str(event_id)
    assert call_json["content"] == "[doc] My Doc"


@pytest.mark.anyio
async def test_relay_no_preference_defaults_sse_skips_discord():
    """NotificationPreference 없음 → channel 기본값 sse → Discord relay 스킵."""
    agent_id = uuid.uuid4()
    event_id = uuid.uuid4()

    mock_db = _mock_db_factory(None)  # pref=None

    mock_http = AsyncMock()
    mock_http.__aenter__ = AsyncMock(return_value=mock_http)
    mock_http.__aexit__ = AsyncMock(return_value=False)

    with patch("app.core.database.async_session_factory", return_value=mock_db), \
         patch("app.routers.dispatch.httpx.AsyncClient", return_value=mock_http):

        from app.routers.dispatch import _relay_dispatched_to_discord
        await _relay_dispatched_to_discord(event_id, agent_id, "[epic] My Epic")

    mock_http.post.assert_not_called()


@pytest.mark.anyio
async def test_relay_exception_swallowed():
    """DB 예외 발생 시 caller에게 전파하지 않고 경고 로그만 출력."""
    agent_id = uuid.uuid4()
    event_id = uuid.uuid4()

    with patch("app.core.database.async_session_factory", side_effect=RuntimeError("db down")):
        from app.routers.dispatch import _relay_dispatched_to_discord
        # 예외 전파되지 않아야 함
        await _relay_dispatched_to_discord(event_id, agent_id, "content")
