"""story #3263(지원v1·5에스컬레이션) — escalation_task()가 실제로 deliver_escalation_event를
호출하는지, 그리고 요청의 진짜 customer user_id(위임 토큰 claims, 페드루 PO "requester=문의한
고객" 정본 답)와 대화 요약이 올바르게 실리는지를 라우터 레벨(client fixture)로 검증한다.
deliver_escalation_event 자체의 JWT/HTTP 동작은 test_escalation_delivery.py가 이미 커버 —
여기는 escalation_task가 그 함수를 "누구의 user_id로, 무슨 요약으로" 부르는지만 본다."""
from __future__ import annotations

import uuid

from tests.conftest import OTHER_ORG_ID, make_token


async def test_escalation_task_delivers_with_the_real_customer_user_id_from_delegated_token(
    client, fake_llm, monkeypatch,
):
    captured: dict = {}

    async def fake_deliver(**kwargs):
        captured.update(kwargs)
        return True

    import app.execution_tasks as execution_tasks_mod
    monkeypatch.setattr(execution_tasks_mod, "deliver_escalation_event", fake_deliver)

    known_user_id = uuid.uuid4()
    headers = {"Authorization": f"Bearer {make_token(OTHER_ORG_ID, user_id=known_user_id)}"}
    fake_llm.classify_text = "needs_human"

    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]
    resp = await client.post(
        f"/api/v1/sessions/{session_id}/messages", json={"content": "사람이랑 얘기하고 싶어요"}, headers=headers,
    )

    assert resp.status_code == 200
    assert captured["org_id"] == OTHER_ORG_ID
    # 페드루 PO 정본 답 — requester는 시스템이 아니라 «문의한 그 고객»(위임 토큰의 user_id
    # 그대로). 시스템 placeholder를 만들지 않는다.
    assert captured["user_id"] == known_user_id
    assert captured["reason"] == "classifier"
    assert captured["conversation_summary"]  # 빈 문자열이면 카드가 "가서 보라" 스텁이 된다.


async def test_conversation_summary_falls_back_to_recent_messages_when_no_memory_summary_yet(
    client, fake_llm, monkeypatch,
):
    """대화가 짧아 §1.3 메모리 압축(memory_summarize_after_messages) 전이면 원문 메시지
    발췌로 폴백한다 — 새 LLM 요약 호출을 발명하지 않는다(escalation_task 자체 설계)."""
    captured: dict = {}

    async def fake_deliver(**kwargs):
        captured.update(kwargs)
        return True

    import app.execution_tasks as execution_tasks_mod
    monkeypatch.setattr(execution_tasks_mod, "deliver_escalation_event", fake_deliver)

    headers = {"Authorization": f"Bearer {make_token(OTHER_ORG_ID)}"}
    fake_llm.classify_text = "needs_human"

    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]
    await client.post(
        f"/api/v1/sessions/{session_id}/messages",
        json={"content": "이 특정 문의 내용이 요약에 나와야 한다"},
        headers=headers,
    )

    assert "이 특정 문의 내용이 요약에 나와야 한다" in captured["conversation_summary"]
