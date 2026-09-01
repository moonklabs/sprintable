"""story #3261 AC1 — Vertex AI SDK 직결(google-genai, `Client(vertexai=True)`). 실호출 지점을
이 파일 하나로 좁혀 테스트가 `LLMClient` 프로토콜만 목킹하면 되게 한다(단위 테스트가 실 Vertex를
때리지 않음 — 비용·네트워크 의존 0).

location="global" 고정 — Blueprint v0.4 §4.3 AC④ 실측: Pro·Flash-Lite 계층이 asia-northeast3
리전 엔드포인트에서 404(그 리전에 없음), global에서만 200. Flash도 global에서 정상 동작 확認돼
전 역할 공통으로 통일했다(리전별 분기 코드 자체를 안 만든다 — 없는 문제의 방어코드 금지).
"""
from __future__ import annotations

import json
import logging
import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from app.config import settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class GenerateResult:
    text: str
    input_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class EmbedResult:
    """story #3262(지원v1·4지식원) — 임베딩은 생성 모델과 과금 단위 자체가 다르다(토큰이
    아니라 문자수, 실측 확認 — `EmbedContentResponse.metadata.billable_character_count`).
    GenerateResult를 억지로 재사용하면 "input_tokens"라는 이름이 거짓말이 된다."""

    vectors: list[list[float]]
    billable_character_count: int


class LLMClient(Protocol):
    async def generate(self, *, model: str, system_prompt: str, user_text: str) -> GenerateResult: ...

    async def generate_with_tools(
        self, *, model: str, system_prompt: str, user_text: str, tools: list[Callable],
        force_tool_names: list[str] | None = None,
    ) -> GenerateResult:
        """story #3261 AC1/AC2 — Interaction Agent 전용(Blueprint §1.1 "스폰·지휘"). AFC(automatic
        function calling, google-genai Chat)로 tools의 async 함수들을 모델이 필요할 때 직접
        호출·결과를 받아 계속 진행한다 — 호출 루프 자체는 SDK가 관리(app/interaction.py는
        도구 목록만 넘긴다).

        story #3277(지원v1·후속) — `force_tool_names`가 주어지면 AUTO(모델이 알아서 선택)
        대신 `tool_config.function_calling_config.mode=ANY`(+`allowed_function_names`)로
        그 목록 중 하나를 **반드시** 호출하게 강제한다. 모델이 도구를 안 부르고 자체 지식으로
        답해 #3261/#3262/#3270의 code-조립·no-fiction 가드 체인 전체를 우회하던 경로를
        구조적으로 소거한다(app/classifier.py의 needs_grounding 판정이 이 값을 채운다)."""
        ...

    async def embed(self, *, model: str, texts: list[str], task_type: str) -> EmbedResult:
        """story #3262 — 지식 검색층. task_type은 google-genai `EmbedContentConfig.task_type`
        그대로("RETRIEVAL_QUERY" 질의용 vs "RETRIEVAL_DOCUMENT" 문서색인용 — 둘을 섞으면
        검색 품질이 떨어진다, Vertex 공식 권고)."""
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
        self, *, model: str, system_prompt: str, user_text: str, tools: list,
        force_tool_names: list[str] | None = None,
    ) -> GenerateResult:
        from google.genai import types

        tool_config = (
            types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode="ANY", allowed_function_names=force_tool_names
                )
            )
            if force_tool_names
            else None
        )
        chat = self._client.aio.chats.create(
            model=model,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt, tools=tools, tool_config=tool_config
            ),
        )
        resp = await chat.send_message(user_text)

        # story #3262 2보-a(2026-08-31) — SDK 자체의 "도구에 무슨 일이 있었다고 믿는지" 원장.
        # 1보(try/except+logger.exception)가 배포됐는데도 재실측에서 로그가 0였다 — 도구
        # 코드가 아예 안 돌았는지(SDK가 디스패치 자체를 실패), 아니면 다른 이유로 로그가 안
        # 찍혔는지를 이걸로 가른다. 임시 계측(근본원인 확定 후 걷어낼 코드) — 항상 남기지 않음.
        afc_history = resp.automatic_function_calling_history
        afc_summary = (
            [c.model_dump(mode="json", exclude_none=True) for c in afc_history] if afc_history else []
        )
        logger.info("automatic_function_calling_history: %s", json.dumps(afc_summary, ensure_ascii=False))
        print(
            f"[tool-trace] automatic_function_calling_history: {json.dumps(afc_summary, ensure_ascii=False)}",
            file=sys.stderr,
            flush=True,
        )

        usage = resp.usage_metadata
        return GenerateResult(
            text=resp.text or "",
            input_tokens=usage.prompt_token_count or 0 if usage else 0,
            output_tokens=usage.candidates_token_count or 0 if usage else 0,
        )

    async def embed(self, *, model: str, texts: list[str], task_type: str) -> EmbedResult:
        from google.genai import types

        resp = await self._client.aio.models.embed_content(
            model=model, contents=texts, config=types.EmbedContentConfig(task_type=task_type)
        )
        vectors = [list(e.values) for e in resp.embeddings]
        billable = (resp.metadata.billable_character_count if resp.metadata else None) or 0
        return EmbedResult(vectors=vectors, billable_character_count=billable)


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
