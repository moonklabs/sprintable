"""story #3283(지원v1·후속, 2026-09-01 PO 라이브 실증) — VertexLLMClient.generate_with_tools의
실 SDK 설정 배선 pin. genai.Client 자체를 몽키패치해 실 Vertex 호출 0 — force_tool_names에
따라 tool_config(mode=ANY)와 automatic_function_calling(maximum_remote_calls=2)이 정확히
조립되는지만 검증한다. 실 AFC 루프 동작(모델이 진짜 몇 번 반복 호출하는지)은 페이크로
재현 불가 — 수동 SDK 스모크 테스트 영역(기존 관례, conftest.py FakeLLMClient 문서 참고)."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


class _FakeChats:
    def __init__(self, captured: dict) -> None:
        self._captured = captured

    def create(self, *, model: str, config):
        self._captured["model"] = model
        self._captured["config"] = config
        chat = SimpleNamespace()
        chat.send_message = AsyncMock(
            return_value=SimpleNamespace(
                text="ok",
                usage_metadata=SimpleNamespace(prompt_token_count=1, candidates_token_count=1),
                automatic_function_calling_history=[],
            )
        )
        return chat


@pytest.fixture
def vertex_client(monkeypatch):
    from app import vertex_client as vertex_client_module

    captured: dict = {}
    fake_genai_client = SimpleNamespace(aio=SimpleNamespace(chats=_FakeChats(captured)))
    monkeypatch.setattr("google.genai.Client", lambda **kwargs: fake_genai_client)

    client = vertex_client_module.VertexLLMClient()
    return client, captured


async def test_force_tool_names_sets_any_mode_and_reduces_call_cap(vertex_client):
    client, captured = vertex_client
    await client.generate_with_tools(
        model="gemini-x", system_prompt="sp", user_text="hi", tools=[], force_tool_names=["knowledge_search"]
    )
    config = captured["config"]
    assert config.tool_config.function_calling_config.mode == "ANY"
    assert config.tool_config.function_calling_config.allowed_function_names == ["knowledge_search"]
    assert config.automatic_function_calling is not None
    assert config.automatic_function_calling.maximum_remote_calls == 2


async def test_no_force_tool_names_leaves_auto_mode_and_sdk_default_cap(vertex_client):
    """force_tool_names가 없는 일반 AUTO 턴은 SDK 기본 상한(10, 실측 재현과 일치)을 그대로
    쓴다 — story #3283 스코프는 강제 턴 한정(PO 확定)."""
    client, captured = vertex_client
    await client.generate_with_tools(
        model="gemini-x", system_prompt="sp", user_text="hi", tools=[], force_tool_names=None
    )
    config = captured["config"]
    assert config.tool_config is None
    assert config.automatic_function_calling is None
