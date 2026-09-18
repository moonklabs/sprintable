"""story #3261 보완(2026-08-31, 페드루 PO 실 왕복 실측 지적) — agent_message.content 계약
구멍 + GET /messages(대화 이력) 신설."""
from __future__ import annotations

from tests.conftest import MOONKLABS_ORG_ID, OTHER_ORG_ID, make_token


async def test_message_exchange_response_includes_reply_content(client, fake_llm):
    fake_llm.interaction_text = "안녕하세요! 무엇을 도와드릴까요?"
    headers = {"Authorization": f"Bearer {make_token(OTHER_ORG_ID)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]

    resp = await client.post(
        f"/api/v1/sessions/{session_id}/messages", json={"content": "hi"}, headers=headers
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["customer_message"]["content"] == "hi"
    assert body["agent_message"]["content"] == "안녕하세요! 무엇을 도와드릴까요?"


async def test_get_messages_returns_history_in_order(client, fake_llm):
    headers = {"Authorization": f"Bearer {make_token(OTHER_ORG_ID)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]

    await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": "first"}, headers=headers)
    await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": "second"}, headers=headers)

    resp = await client.get(f"/api/v1/sessions/{session_id}/messages", headers=headers)
    assert resp.status_code == 200
    messages = resp.json()["messages"]
    assert [m["content"] for m in messages if m["role"] == "customer"] == ["first", "second"]
    assert all("content" in m for m in messages)
    # 시간순 오름차순(위젯 재오픈 시 위→아래 렌더 가정)
    assert messages == sorted(messages, key=lambda m: m["created_at"])


async def test_get_messages_empty_conversation_returns_empty_list(client, fake_llm):
    headers = {"Authorization": f"Bearer {make_token(OTHER_ORG_ID)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]

    resp = await client.get(f"/api/v1/sessions/{session_id}/messages", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["messages"] == []


async def test_get_messages_cross_org_404(client, fake_llm):
    token_a = make_token(OTHER_ORG_ID)
    session = await client.post("/api/v1/sessions", headers={"Authorization": f"Bearer {token_a}"})
    session_id = session.json()["id"]

    token_moonklabs = make_token(MOONKLABS_ORG_ID)
    resp = await client.get(
        f"/api/v1/sessions/{session_id}/messages", headers={"Authorization": f"Bearer {token_moonklabs}"}
    )
    assert resp.status_code == 404
