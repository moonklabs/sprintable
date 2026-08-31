from __future__ import annotations

import uuid
from collections.abc import Callable

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import settings
from app.vertex_client import GenerateResult

TEST_TOKEN_SECRET = "test-secret-not-for-prod-padded-to-32-bytes-min"

# story #3259 AC4 — moonklabs 실 org id를 테스트에 실 참여자로 쓴다(특례 없음을 증명하려면
# 이 id로 정확히 같은 코드 경로를 태워봐야 한다). memory reference: list_team_members 실측.
MOONKLABS_ORG_ID = uuid.UUID("54bac162-5c0d-49fa-8e49-85977063a091")
OTHER_ORG_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")


def make_token(org_id: uuid.UUID, user_id: uuid.UUID | None = None, secret: str = TEST_TOKEN_SECRET) -> str:
    user_id = user_id or uuid.uuid4()
    return jwt.encode({"org_id": str(org_id), "user_id": str(user_id)}, secret, algorithm="HS256")


class FakeLLMClient:
    """story #3261 — 실 Vertex 호출 0. classify_text/interaction_text를 테스트가 미리 정해
    orchestration 로직(app/interaction.py)만 검증한다. AFC(도구 호출) 자체는 SDK 스모크
    테스트로 별도 검증 완료(수동, 이 스위트엔 안 실음 — 비용·네트워크 의존 배제)."""

    def __init__(
        self,
        *,
        classify_text: str = "inquiry",
        interaction_text: str = "안녕하세요, 도와드릴게요.",
        input_tokens: int = 10,
        output_tokens: int = 5,
    ) -> None:
        self.classify_text = classify_text
        self.interaction_text = interaction_text
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.calls: list[tuple[str, str]] = []  # (kind, model)

    async def generate(self, *, model: str, system_prompt: str, user_text: str) -> GenerateResult:
        self.calls.append(("generate", model))
        # classifier·memory summarizer 둘 다 이 메서드를 쓴다 — 시스템 프롬프트로 구분.
        if "카테고리" in system_prompt or "라우터" in system_prompt:
            return GenerateResult(text=self.classify_text, input_tokens=self.input_tokens, output_tokens=1)
        return GenerateResult(text="(요약)", input_tokens=self.input_tokens, output_tokens=self.output_tokens)

    async def generate_with_tools(
        self, *, model: str, system_prompt: str, user_text: str, tools: list[Callable]
    ) -> GenerateResult:
        self.calls.append(("generate_with_tools", model))
        return GenerateResult(
            text=self.interaction_text, input_tokens=self.input_tokens, output_tokens=self.output_tokens
        )


@pytest.fixture(autouse=True)
def fake_llm(monkeypatch):
    """autouse — story #3261부터 POST /messages가 항상 LLM 경로(분류기 최소)를 태우므로,
    story #3259 시절 테스트(LLM을 모르던 코드)까지 전부 이 목이 없으면 실 VertexLLMClient
    생성을 시도해 깨진다. 개별 테스트가 `fake_llm` 파라미터로 받아 classify_text/
    interaction_text를 조정할 수 있다(기본값은 무해한 "inquiry" 분류)."""
    import app.vertex_client as vertex_client_module

    fake = FakeLLMClient()
    monkeypatch.setattr(vertex_client_module, "_client", fake)
    return fake


@pytest.fixture(autouse=True)
def _configure_settings(monkeypatch, tmp_path):
    db_path = tmp_path / "test.db"
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{db_path}")
    monkeypatch.setattr(settings, "token_secret", TEST_TOKEN_SECRET)
    monkeypatch.setattr(settings, "session_rate_limit", "1000/minute")


@pytest_asyncio.fixture
async def db_engine():
    from app.models import Base

    engine = create_async_engine(settings.database_url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_engine, monkeypatch):
    import app.db as db_module
    from app.main import app
    from sqlalchemy.ext.asyncio import async_sessionmaker

    session_factory = async_sessionmaker(db_engine, expire_on_commit=False)
    monkeypatch.setattr(db_module, "async_session_factory", session_factory)

    async def _override_get_db():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[db_module.get_db] = _override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()
