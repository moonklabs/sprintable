"""story #2281 — #2271에서 발견된 MCP 도구↔서버 경로 불일치 4건의 회귀가드.

AC6: "고친 도구마다 경로를 고정하는 테스트가 있어야 한다" — retro.py가 「테스트가 전무해
미검출」이었던 것이 그 병의 뿌리였다. 여기서는 mock client로 각 도구가 실제로 부르는
경로/메서드/바디를 고정하고, 부재였던 두 건(ⓐ건은 실제 서버 라우트, ⓒ건은 명시적 오류)의
새 행동을 고정한다.
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── AC1 — mark_all_notifications_read: 경로 수정 + body 무의미 문제 해소 ──────────

@pytest.mark.anyio
async def test_mark_all_notifications_read_calls_correct_path_no_body():
    from sprintable_mcp.tools.notifications import MarkAllNotificationsReadInput, mark_all_notifications_read

    with patch("sprintable_mcp.tools.notifications.client") as mock_client:
        mock_client.patch = AsyncMock(return_value={"ok": True})
        out = await mark_all_notifications_read(MarkAllNotificationsReadInput())

    mock_client.patch.assert_awaited_once_with("/api/v2/notifications/mark-all-read")
    assert json.loads(out[0].text) == {"ok": True}


@pytest.mark.anyio
async def test_mark_all_notifications_read_type_filter_explicit_error_not_silent_ignore():
    """서버가 type 필터를 지원 안 하므로, 조용히 무시하지 않고 명시 오류로 막는다(AC4)."""
    from sprintable_mcp.tools.notifications import MarkAllNotificationsReadInput, mark_all_notifications_read

    with patch("sprintable_mcp.tools.notifications.client") as mock_client:
        mock_client.patch = AsyncMock()
        out = await mark_all_notifications_read(MarkAllNotificationsReadInput(type="mention"))

    mock_client.patch.assert_not_awaited()
    assert out[0].text.startswith("Error:") and "지원하지 않습니다" in out[0].text


# ── AC3ⓒ — mark_notification_read: 부재를 명시 오류로(조용한 404 금지, AC4) ──────

@pytest.mark.anyio
async def test_mark_notification_read_explicit_unsupported_error_not_silent_404():
    from sprintable_mcp.tools.notifications import MarkNotificationReadInput, mark_notification_read

    with patch("sprintable_mcp.tools.notifications.client") as mock_client:
        out = await mark_notification_read(MarkNotificationReadInput(notification_id="n1"))

    mock_client.assert_not_called()  # 서버 호출 자체를 안 함 — 없는 기능을 부르지 않는다
    assert out[0].text.startswith("Error:") and "구현돼 있지 않습니다" in out[0].text


# ── AC2 — update_retro_action_status: 경로+입력스키마(session_id) 동시 수정 ────────

@pytest.mark.anyio
async def test_update_retro_action_status_requires_session_id_in_schema():
    from sprintable_mcp.tools.standup import UpdateRetroActionStatusInput
    assert "session_id" in UpdateRetroActionStatusInput.model_fields


@pytest.mark.anyio
async def test_update_retro_action_status_calls_correct_nested_path():
    from sprintable_mcp.tools.standup import UpdateRetroActionStatusInput, update_retro_action_status

    with patch("sprintable_mcp.tools.standup.client") as mock_client:
        mock_client.patch = AsyncMock(return_value={"id": "a1", "status": "done"})
        out = await update_retro_action_status(
            UpdateRetroActionStatusInput(session_id="s1", action_id="a1", status="done")
        )

    mock_client.patch.assert_awaited_once_with(
        "/api/v2/retros/s1/actions/a1", json={"status": "done"}
    )
    assert json.loads(out[0].text)["status"] == "done"


# ── AC3ⓐ — get_retro_session: 새 서버 라우트(POST /api/v2/retros/by-sprint) 호출 ────

@pytest.mark.anyio
async def test_get_retro_session_calls_new_by_sprint_route():
    from sprintable_mcp.tools.standup import GetRetroSessionInput, get_retro_session

    with patch("sprintable_mcp.tools.standup.client") as mock_client:
        mock_client.post = AsyncMock(return_value={"id": "sess1", "sprint_id": "sp1"})
        out = await get_retro_session(GetRetroSessionInput(sprint_id="sp1"))

    mock_client.post.assert_awaited_once_with(
        "/api/v2/retros/by-sprint", json={"sprint_id": "sp1"}
    )
    assert json.loads(out[0].text)["id"] == "sess1"


@pytest.mark.anyio
async def test_get_retro_session_passes_title_when_given():
    from sprintable_mcp.tools.standup import GetRetroSessionInput, get_retro_session

    with patch("sprintable_mcp.tools.standup.client") as mock_client:
        mock_client.post = AsyncMock(return_value={"id": "sess1"})
        await get_retro_session(GetRetroSessionInput(sprint_id="sp1", title="스프린트 3 회고"))

    mock_client.post.assert_awaited_once_with(
        "/api/v2/retros/by-sprint", json={"sprint_id": "sp1", "title": "스프린트 3 회고"}
    )
