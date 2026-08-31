"""story #3259 AC5 — 방어 필터 진입점이 실제로 메시지 저장 경로에 배선돼 있는지(내용은
story #6, 여기는 호출 지점 고정만이 산출물)."""
from __future__ import annotations

from unittest.mock import patch

from tests.conftest import OTHER_ORG_ID, make_token


async def test_sanitize_customer_text_called_on_message_create(client):
    headers = {"Authorization": f"Bearer {make_token(OTHER_ORG_ID)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]

    with patch("app.routers.sessions.sanitize_customer_text", wraps=lambda t: t) as spy:
        resp = await client.post(
            f"/api/v1/sessions/{session_id}/messages",
            json={"content": "hello there"},
            headers=headers,
        )
    assert resp.status_code == 200
    spy.assert_called_once_with("hello there")
