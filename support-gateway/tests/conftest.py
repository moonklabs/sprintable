from __future__ import annotations

import uuid

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import settings

TEST_TOKEN_SECRET = "test-secret-not-for-prod-padded-to-32-bytes-min"

# story #3259 AC4 — moonklabs 실 org id를 테스트에 실 참여자로 쓴다(특례 없음을 증명하려면
# 이 id로 정확히 같은 코드 경로를 태워봐야 한다). memory reference: list_team_members 실측.
MOONKLABS_ORG_ID = uuid.UUID("54bac162-5c0d-49fa-8e49-85977063a091")
OTHER_ORG_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")


def make_token(org_id: uuid.UUID, user_id: uuid.UUID | None = None, secret: str = TEST_TOKEN_SECRET) -> str:
    user_id = user_id or uuid.uuid4()
    return jwt.encode({"org_id": str(org_id), "user_id": str(user_id)}, secret, algorithm="HS256")


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
