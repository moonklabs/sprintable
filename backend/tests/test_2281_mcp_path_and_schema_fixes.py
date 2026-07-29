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


# ── 2026-07-29(선생님 지시) — mark_notification_read: 부재→실재로 판정 재정정 ──────
#
# ⛔이 항목은 story #2281 원 AC3에서 ⓒ(명시적 오류)로 판정됐었다 — 그때는 옳은 처방이었다
# (서버에 단건 읽음처리 라우트가 없었고, 재설계와 순서가 얽혀 PO가 순서를 잡기로 했다).
# 그런데 그 판정에 **만료 조건이 없었다** — 서버에 라우트가 실제로 생긴 뒤(notifications.py
# mark_read, PATCH /{id}/read — 48de882a에서 FE Inbox 클릭 경로 보강 목적으로 이미 신설됨)에도
# 도구는 계속 "구현돼 있지 않습니다"를 반환하고 있었다. PO 자기 발견·자기 정정(2026-07-29):
# 「도구가 스스로 '없다'고 말하면 그건 도구의 주장이지 서버의 사실이 아니다」 — 순서가 얽혔던
# 이유(#2201·#2279 알림 재설계)도 #2279가 "벨은 그대로 산다"로 결론나 소멸했다. 지금 잡는다.

@pytest.mark.anyio
async def test_mark_notification_read_calls_real_server_route():
    from sprintable_mcp.tools.notifications import MarkNotificationReadInput, mark_notification_read

    with patch("sprintable_mcp.tools.notifications.client") as mock_client:
        mock_client.patch = AsyncMock(return_value={"id": "n1", "is_read": True})
        out = await mark_notification_read(MarkNotificationReadInput(notification_id="n1"))

    mock_client.patch.assert_awaited_once_with("/api/v2/notifications/n1/read")
    assert json.loads(out[0].text) == {"id": "n1", "is_read": True}


@pytest.mark.anyio
async def test_mark_notification_read_is_read_false_explicit_error_not_silent_ignore():
    """서버 라우트는 항상 읽음으로만 설정한다(unmark 기능 자체가 없다) — is_read=False를
    조용히 무시하지 않고 명시 오류로 막는다(AC4와 동일 규율, mark_all의 type 필터와 동형)."""
    from sprintable_mcp.tools.notifications import MarkNotificationReadInput, mark_notification_read

    with patch("sprintable_mcp.tools.notifications.client") as mock_client:
        mock_client.patch = AsyncMock()
        out = await mark_notification_read(MarkNotificationReadInput(notification_id="n1", is_read=False))

    mock_client.patch.assert_not_awaited()
    assert out[0].text.startswith("Error:") and "지원하지 않습니다" in out[0].text


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
