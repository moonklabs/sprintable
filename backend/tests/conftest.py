"""Shared pytest fixtures for backend tests."""
import ast
import os
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

# 테스트 환경 기본 환경변수
os.environ.setdefault("JWT_SECRET", "test-secret-key-for-pytest-only")


# story 8236bbc3: destructive_schema 마커 drift 자기표면화 가드(PO crux 게이트②, 2026-07-03).
# 마커 부여 자체는 수동이라(하드코딩 파일리스트와 동일 클래스의 drift 위험) 이 가드가 없으면
# "새 create_all/drop_all 테스트가 마커 없이 들어오면?" 질문에 "alembic-fresh-db job에서 공유
# DB를 오염시켜 무관한 다른 테스트가 연쇄 실패하는 간접 신호"로만 답할 수 있었다(실측: 파일 1개의
# 누락이 116건 연쇄 실패로 나타남 — loud하지만 원인 파일을 바로 못 짚는 혼란스러운 실패). 이
# 가드는 collection 시점에 AST로 create_all/drop_all 호출(`X.metadata.create_all` 형태 —
# `conn.run_sync(Base.metadata.create_all)`처럼 콜백으로 전달되는 경우도 Attribute 노드로 잡힘)을
# 정적 스캔해 마커 누락을 즉시·정확한 파일명으로 표면화한다(로컬 개발 시점에도 동일하게 발동 —
# CI까지 갈 필요도 없음).
_DESTRUCTIVE_ATTRS = {"create_all", "drop_all"}
_MARKER_NAME = "destructive_schema"


def _calls_destructive_schema_api(filepath: Path) -> bool:
    try:
        tree = ast.parse(filepath.read_text(encoding="utf-8"))
    except (SyntaxError, OSError, UnicodeDecodeError):
        return False
    return any(
        isinstance(node, ast.Attribute) and node.attr in _DESTRUCTIVE_ATTRS
        for node in ast.walk(tree)
    )


def pytest_collection_modifyitems(items: list) -> None:
    checked: dict[Path, bool] = {}
    violations: set[str] = set()
    for item in items:
        filepath = Path(str(item.fspath))
        if filepath not in checked:
            checked[filepath] = _calls_destructive_schema_api(filepath)
        if checked[filepath] and _MARKER_NAME not in {m.name for m in item.iter_markers()}:
            violations.add(str(filepath))
    if violations:
        raise pytest.UsageError(
            "다음 테스트 파일이 Base.metadata.create_all/drop_all을 호출하지만 "
            f"@pytest.mark.{_MARKER_NAME} 마커가 없습니다(alembic-migrated 공유 DB를 오염시켜 "
            "무관한 테스트를 연쇄 실패시킬 수 있음 — story 8236bbc3). 파일 최상단에 "
            f"`pytestmark = pytest.mark.{_MARKER_NAME}` 를 추가하세요:\n"
            + "\n".join(sorted(violations))
        )


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def org_id() -> uuid.UUID:
    return uuid.uuid4()


@pytest.fixture
def project_id() -> uuid.UUID:
    return uuid.uuid4()


@pytest.fixture
def mock_session() -> AsyncMock:
    session = AsyncMock()
    session.add = MagicMock()
    session.flush = AsyncMock()
    session.refresh = AsyncMock()
    session.delete = AsyncMock()
    session.execute = AsyncMock()
    return session


@pytest.fixture
def auth_ctx(org_id: uuid.UUID) -> MagicMock:
    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(org_id), "role": "admin"}}
    return ctx


@pytest.fixture
async def test_client(mock_session: AsyncMock, auth_ctx: MagicMock):
    """AsyncClient with mocked DB session + auth. Clears dependency_overrides on teardown."""
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from app.main import app

    async def _override_db():
        yield mock_session

    async def _override_auth():
        return auth_ctx

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_current_user] = _override_auth

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client

    app.dependency_overrides.clear()
