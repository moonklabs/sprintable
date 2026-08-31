"""story #3261 AC1 — Vertex AI SDK 직결(google-genai, `Client(vertexai=True)`). 실호출 지점을
이 파일 하나로 좁혀 테스트가 `LLMClient` 프로토콜만 목킹하면 되게 한다(단위 테스트가 실 Vertex를
때리지 않음 — 비용·네트워크 의존 0).

location="global" 고정 — Blueprint v0.4 §4.3 AC④ 실측: Pro·Flash-Lite 계층이 asia-northeast3
리전 엔드포인트에서 404(그 리전에 없음), global에서만 200. Flash도 global에서 정상 동작 확認돼
전 역할 공통으로 통일했다(리전별 분기 코드 자체를 안 만든다 — 없는 문제의 방어코드 금지).
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from app.config import settings


@dataclass(frozen=True)
class GenerateResult:
    text: str
    input_tokens: int
    output_tokens: int


class LLMClient(Protocol):
    async def generate(self, *, model: str, system_prompt: str, user_text: str) -> GenerateResult: ...

    async def generate_with_tools(
        self, *, model: str, system_prompt: str, user_text: str, tools: list[Callable]
    ) -> GenerateResult:
        """story #3261 AC1/AC2 — Interaction Agent 전용(Blueprint §1.1 "스폰·지휘"). AFC(automatic
        function calling, google-genai Chat)로 tools의 async 함수들을 모델이 필요할 때 직접
        호출·결과를 받아 계속 진행한다 — 호출 루프 자체는 SDK가 관리(app/interaction.py는
        도구 목록만 넘긴다)."""
        ...


class VertexLLMClient:
    """prod/dev 실 경로. Cloud Run 배포 시 전용 서비스계정의 ADC(메타데이터 서버)가 자동
    인증한다 — credentials를 여기서 명시로 안 넘긴다(로컬 개발/실험 시엔 `gcloud auth
    application-default login`으로 ADC를 맞추거나, 이 클래스 대신 FakeLLMClient를 쓴다)."""

    def __init__(self) -> None:
        from google import genai  # 지연 import — 테스트가 이 클래스를 안 쓰면 SDK 자체가 안 실린다.

        self._client = genai.Client(
            vertexai=True, project=settings.vertex_project, location=settings.vertex_location
        )

    async def generate(self, *, model: str, system_prompt: str, user_text: str) -> GenerateResult:
        from google.genai import types

        resp = await self._client.aio.models.generate_content(
            model=model,
            contents=user_text,
            config=types.GenerateContentConfig(system_instruction=system_prompt),
        )
        usage = resp.usage_metadata
        return GenerateResult(
            text=resp.text or "",
            input_tokens=usage.prompt_token_count or 0 if usage else 0,
            output_tokens=usage.candidates_token_count or 0 if usage else 0,
        )

    async def generate_with_tools(
        self, *, model: str, system_prompt: str, user_text: str, tools: list
    ) -> GenerateResult:
        from google.genai import types

        chat = self._client.aio.chats.create(
            model=model, config=types.GenerateContentConfig(system_instruction=system_prompt, tools=tools)
        )
        resp = await chat.send_message(user_text)
        usage = resp.usage_metadata
        return GenerateResult(
            text=resp.text or "",
            input_tokens=usage.prompt_token_count or 0 if usage else 0,
            output_tokens=usage.candidates_token_count or 0 if usage else 0,
        )


_client: LLMClient | None = None


def get_llm_client() -> LLMClient:
    global _client
    if _client is None:
        _client = VertexLLMClient()
    return _client


def set_llm_client(client: LLMClient) -> None:
    """테스트 전용 override — FastAPI dependency_overrides 패턴과 별개로, 이 모듈 레벨
    싱글턴을 직접 스왑한다(라우터를 거치지 않는 app/interaction.py 등에서도 통일된 방식으로
    목이 먹히게 하기 위함)."""
    global _client
    _client = client
