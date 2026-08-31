"""story #3262 3차 dev 실측 근인조사(2026-08-31, 페드루 PO) — 도구가 raise하면 google-genai
SDK의 AFC 디스패치가 예외를 삼켜 Cloud Logging에 흔적이 0였다(런타임 전용 재현, 로컬에선
knowledge_task 단독 실행이 완벽히 동작해 코드·자격·모델 자체는 무죄로 확認됨). 1보(관측성):
도구를 try/except로 감싸 SDK가 예외를 볼 기회 자체를 없애고 logger.exception으로 실
traceback을 남긴다 — 이 테스트는 "감싸짐"과 "로그가 실제로 찍힘"을 검증한다."""
from __future__ import annotations

import logging

import app.execution_tasks as execution_tasks_module
from app.interaction import _TOOL_FAILURE_HONEST_MESSAGE
from tests.conftest import OTHER_ORG_ID, make_token


async def _post_message(client, org_id=OTHER_ORG_ID, content="팀원을 초대하려면 어떻게 하나요?"):
    headers = {"Authorization": f"Bearer {make_token(org_id)}"}
    session = await client.post("/api/v1/sessions", headers=headers)
    session_id = session.json()["id"]
    resp = await client.post(f"/api/v1/sessions/{session_id}/messages", json={"content": content}, headers=headers)
    return resp


async def test_knowledge_search_exception_is_logged_and_does_not_crash_the_turn(client, fake_llm, monkeypatch, caplog):
    def _boom(vector, top_k=3):
        raise RuntimeError("simulated Cloud Run-only failure (예: uvloop×AFC 상호작용)")

    monkeypatch.setattr(execution_tasks_module, "search", _boom)
    fake_llm.classify_text = "inquiry"
    fake_llm.call_tool_name = "knowledge_search"
    fake_llm.call_tool_kwargs = {"query": "팀원을 초대하려면?"}
    fake_llm.interaction_text = "안내드릴게요."

    with caplog.at_level(logging.ERROR, logger="app.interaction"):
        resp = await _post_message(client)

    assert resp.status_code == 200  # 500으로 안 죽는다 — SDK가 삼킬 예외 자체가 안 나간다.
    assert any(
        "knowledge_search 도구 실행 중 예외" in record.message and record.exc_info is not None
        for record in caplog.records
    ), "traceback 포함 exception 로그가 안 찍힘"


async def test_escalate_exception_is_logged_and_does_not_crash_the_turn(client, fake_llm, monkeypatch, caplog):
    async def _boom(db, *, conversation_id, org_id, reason, detail):
        raise RuntimeError("simulated escalation_task failure")

    import app.interaction as interaction_module

    # interaction.py는 `from app.execution_tasks import escalation_task`로 자기 네임스페이스에
    # 이름을 바인딩해뒀다 — execution_tasks_module 쪽을 패치해도 이미 바인딩된 이름엔 안
    # 미친다. 실제 호출부(escalate 클로저)가 참조하는 interaction_module 쪽을 패치해야 한다.
    monkeypatch.setattr(interaction_module, "escalation_task", _boom)

    fake_llm.classify_text = "inquiry"
    fake_llm.call_tool_name = "escalate"
    fake_llm.call_tool_kwargs = {"reason": "고객이 사람 연결을 요청함"}
    fake_llm.interaction_text = "담당자 연결을 시도할게요."

    with caplog.at_level(logging.ERROR, logger="app.interaction"):
        resp = await _post_message(client)

    assert resp.status_code == 200
    assert any(
        "escalate 도구 실행 중 예외" in record.message and record.exc_info is not None for record in caplog.records
    )


async def test_tool_failure_honest_message_has_no_fabrication_markers():
    """폴백 문구 자체가 no_fiction_guard·knowledge_fiction_guard 트리거 패턴을 우연히 안
    건드리는지 확인(순환 오탐 방지)."""
    from app.knowledge_fiction_guard import looks_like_fabricated_product_instructions
    from app.no_fiction_guard import looks_like_fabricated_handoff_claim

    assert looks_like_fabricated_handoff_claim(_TOOL_FAILURE_HONEST_MESSAGE) is False
    assert looks_like_fabricated_product_instructions(_TOOL_FAILURE_HONEST_MESSAGE) is False
