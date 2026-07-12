"""Shared pytest fixtures for backend tests."""
import ast
import os
import re
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine, text

# 테스트 환경 기본 환경변수
os.environ.setdefault("JWT_SECRET", "test-secret-key-for-pytest-only")


# ─────────────────────────────────────────────────────────────────────────────
# story 9108cb4f: create_all/drop_all 테스트 스키마 자기청소 (migrated-DB teardown 드리프트 봉인).
#
# 근본(디디 조사 2026-07-12·실측): create_all 테스트를 alembic-migrated DB에 실행하면 teardown
# drop_all이 Base.metadata에 없는 migrated-only 오브젝트(team_members VIEW·마이그 전용 FK 등)를
# 못 지워 DependentObjectsStillExistError로 false-fail한다(fresh empty DB엔 clean). 매 realdb QA에
# "pre-existing 아티팩트" 노이즈로 반복 등장했다. fix: destructive_schema 테스트 실행 **전에** 대상
# 스키마를 풀리셋(DROP SCHEMA public CASCADE)해 migrated/잔류 스키마 무관 clean-slate로 만든다 —
# 이러면 create_all은 항상 빈 스키마 위에 모델 테이블만 짓고(VIEW 없음), teardown drop_all도 clean.
# ─────────────────────────────────────────────────────────────────────────────

# ⛔ 안전가드(비협상): DROP SCHEMA는 파괴적이라 오배치 시 실 DB 전소. dev/prod 마커는 명시 flag가
# 있어도 하드-거부(deny-list)하고, 그 외엔 테스트 신호(이름 패턴) 또는 명시 opt-in env가 있을 때만
# 허용(allow-list). 둘 다 통과해야 리셋 — 아니면 즉시 fail-fast(실 DB는 절대 건드리지 않는다).
_FORBIDDEN_DB_RE = re.compile(r"prod|production|sprintable-dev|sprintable-prod", re.IGNORECASE)
# ⚠️ 까심 QA(#2095 RC): 테스트 신호는 반드시 **토큰 경계**로 매치한다 — substring 매치는 fail-open이라
# "test"가 다른 단어 안에 우연히 든 실 DB 이름(customer_data_latest·contest_entries·protest_data·
# orders_latest_snapshot)이 opt-in 없이 통과해 파괴적 DROP SCHEMA가 발동했다. `_`/`-` 또는 문자열
# 경계로 구분된 **온전한 토큰**일 때만 인정(latest 안의 test·contest 안의 test는 불인정).
_TEST_DB_SIGNAL_RE = re.compile(
    r"(?:^|[_-])(?:test\d*|parity|ci|ca\d+|ephemeral|scratch|tmp)(?=$|[_-])",
    re.IGNORECASE,
)


def _db_name(url: str) -> str:
    return url.rsplit("/", 1)[-1].split("?")[0] if "/" in url else url


def assert_disposable_test_db(url: str) -> None:
    """DROP SCHEMA 대상이 disposable 테스트 DB임을 강제. dev/prod 마커면 무조건 거부, 테스트 신호도
    opt-in flag도 없으면 거부. 통과 못 하면 RuntimeError로 즉시 fail-fast(파괴 DDL 미실행)."""
    name = _db_name(url)
    if _FORBIDDEN_DB_RE.search(url):
        raise RuntimeError(
            f"안전가드: DROP SCHEMA 대상 URL에 dev/prod 마커 — 파괴 DDL 거부(DB='{name}'). "
            "테스트 스키마 리셋은 실 DB에서 절대 실행되지 않습니다."
        )
    allow_flag = os.environ.get("ALLOW_DESTRUCTIVE_SCHEMA_RESET") == "1"
    if not (_TEST_DB_SIGNAL_RE.search(name) or allow_flag):
        raise RuntimeError(
            f"안전가드: DROP SCHEMA는 테스트 DB(이름에 test/parity/ci 등) 또는 "
            f"ALLOW_DESTRUCTIVE_SCHEMA_RESET=1 일 때만 허용 — 거부(DB='{name}')."
        )


def _sync_url(url: str) -> str:
    for prefix in ("postgresql+asyncpg://", "postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg2://" + url[len(prefix):]
    return url


def _reset_public_schema(url: str) -> None:
    """대상 스키마 풀리셋 — DROP SCHEMA public CASCADE; CREATE SCHEMA public; + 필요한 extension
    재생성(vector 등, baseline/모델이 요구). 안전가드 통과 후에만 호출."""
    assert_disposable_test_db(url)
    engine = create_engine(_sync_url(url))
    try:
        with engine.begin() as conn:
            conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
            conn.execute(text("CREATE SCHEMA public"))
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    finally:
        engine.dispose()


@pytest.fixture(autouse=True)
def _reset_schema_for_destructive_tests(request):
    """destructive_schema 마커 테스트는 실행 **전** 대상 스키마를 풀리셋해 clean-slate 보장(9108cb4f).
    마커 없는 테스트엔 no-op. realdb URL(PARITY/ALEMBIC) 미설정 시(=테스트 skip 대상) 리셋 생략."""
    if request.node.get_closest_marker(_MARKER_NAME) is None:
        yield
        return
    url = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
    if url:
        _reset_public_schema(url)
    yield


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
