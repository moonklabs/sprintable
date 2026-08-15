"""Shared pytest fixtures for backend tests.

⛔⛔라우터 함수를 직접 호출할 때: `Query(...)`/`Depends(...)` 기본값은 실값이 아니라
«센티널 객체»다 — 명시로 안 넘기면 그 객체 자체가 그대로 들어간다(story #2191이 2026-07-XX
`test_2193_doc_summary_created_at_realdb.py`에서 처음 겪었고, #2659(2026-07-30)가 CI 21건
실패로 같은 병을 두 번째로 냈다).

`x: T | None = Query(default=None)`의 실제 기본값은 `fastapi.params.Query` 인스턴스다 —
FastAPI가 **실제 HTTP 요청 경로**를 탈 때만 이 센티널을 실값(쿼리 파라미터 또는 None)으로
해소한다. 이 코드베이스는 라우터 함수를 `client.get(...)`(HTTP 경유) 대신 `await
list_stories(...)`처럼 **직접 호출**하는 테스트가 흔한데(HTTP 왕복 없이 빠르게 wiring만
보려는 것), 그 경로에서는 FastAPI의 해소가 안 일어난다 — 파라미터를 안 넘기면 센티널
객체가 그대로 함수 안으로 들어가고, `if x is not None:` 같은 가드는 그 객체를 "값이 있다"고
착각해 통과시킨다(크래시하거나, 더 나쁘면 조용히 틀린 분기를 탄다).

⇒ ⭐**규율: 라우터 함수를 직접 호출하는 테스트는 그 함수가 선언한 `Query(...)`/`Depends(...)`
파라미터를 «전부» 명시로 넘겨라** — 하나라도 빠뜨리면 안 된다.

⛔이 규율이 지켜지는지는 CI의 `scripts/lint_query_sentinel_direct_calls.py`(story #2335,
"Query(None) sentinel direct-call lint" 잡)가 AST로 자동 대조한다 — 새로 빠뜨리면 그 잡이
빨개진다. 다만 그 lint를 처음 켠 시점(2026-07-30) develop에 이미 있던 위반은
`scripts/query_sentinel_baseline.txt`에 grandfather로 남아 있다(전부 실행 시 크래시로
드러나는 것이 실측 확認됐고 — 조용히 틀리는 사례는 0건이었다 — 그래서 개별 수리는 안 하기로
판정됐다, story #2335 AC6). 새 테스트를 쓸 때 이 주석을 «봤어야» 그 병을 세 번째로 안 낸다
— 지금까지는 이 주석이 `test_2193_*.py` 파일 안에만 있어서 그 파일을 여는 사람만 읽었다
(story #2335가 잡은 세 번째 재발의 근본 원인). 이 conftest.py는 모든 테스트 파일이 로드
시점에 거치는 자리라, 여기 적어야 «다음 사람도» 읽는다.
"""
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

# story ebfd8252(2026-08-14, 카디르 자수 3연발 — #2998/#3000/#3003 QA에서 각각) — 위
# `_TEST_DB_SIGNAL_RE`는 "이게 실 dev/prod가 아니라 테스트류 DB인가"만 본다. `sprintable_test`는
# 그 축은 통과하지만(토큰 경계 "test" 포함) **동시에 이 조직의 로컬 realdb 관례 기본값**이라 —
# 사람/에이전트 여럿이 같은 로컬 postgres 서버의 같은 DB명을 동시에 가리키는 일이 흔하다. CI에서는
# 안전하다(job마다 완전히 새로운 격리 postgres 서비스 컨테이너를 매번 띄우고 그 안에서만
# `sprintable_test`라는 이름을 쓰므로 "공유"가 구조적으로 불가능 — GitHub Actions가 항상
# `CI=true`를 심어주는 것을 신호로 구분한다, 이 conftest 밖에서도 이미 쓰는 관례:
# test_s6_4_dod.py·test_s7_2_epic_dod.py 참조). CI 밖에서 이 이름을 향한 파괴적 리셋은 —
# 격리를 사람이 «기억」해야 하는 바로 그 자리라 opt-in을 강제한다.
_SHARED_CONVENTION_DB_NAMES = frozenset({"sprintable_test"})


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
    is_ci = bool(os.environ.get("CI"))
    allow_shared_flag = os.environ.get("ALLOW_DESTRUCTIVE_ON_SHARED") == "1"
    if name in _SHARED_CONVENTION_DB_NAMES and not is_ci and not allow_shared_flag:
        raise RuntimeError(
            f"안전가드: '{name}'은 이 조직의 공유 로컬 DB 관례명 — 여러 사람/에이전트가 같은 "
            "postgres 서버의 이 DB를 동시에 realdb 테스트로 쓰고 있을 수 있어 DROP SCHEMA로 "
            "리셋하면 다른 세션의 진행 중인 realdb 스위트가 연쇄로 깨집니다. 전용 throwaway "
            "DB를 새로 만들어 가리키세요(예: `createdb sprintable_test_$(whoami)_$$` 후 그 URL로 "
            f"ALEMBIC_DATABASE_URL/PARITY_TEST_DATABASE_URL을 설정) — 정말 이 공유 DB를 갈아엎어도 "
            f"된다는 걸 알고 있다면 ALLOW_DESTRUCTIVE_ON_SHARED=1로 우회하세요(DB='{name}')."
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
#
# story #2643(2026-08-14, #3031 CI 사고 규명 중 디디 발견): 위 스캔은 SQLAlchemy ORM API
# 호출(`.create_all`/`.drop_all`)만 본다 — `sa.text("DROP TABLE ...")`처럼 raw SQL DDL을
# 문자열로 직접 실행하는 테스트는 같은 파괴력(alembic-migrated 공유 DB의 실 테이블을 DROP)을
# 가지면서도 이 정적 스캔을 완전히 피해간다. 그래서 아래 `_calls_raw_ddl_literal`을 추가해
# **함수 호출의 인자로 쓰인 문자열 리터럴**만 정밀 스캔한다(모든 문자열 상수를 스캔하면
# docstring/주석 프로즈가 "DROP TABLE"을 설명 목적으로 언급만 해도 오탐이 난다 — 실제로
# **실행되는** 문자열인지가 판별축). 동적 조립 문자열(f-string·`+`·`.format()`)은 여전히
# 못 본다 — AST 리터럴이 아니라서 값이 파싱 시점에 없다. 이 클래스는 의도적 잔여 사각으로
# 남긴다(값을 실행 없이 정적으로 복원하려면 별도 데이터-흐름 분석이 필요해 이 가드의 비용
# 대비 이득을 넘어선다) — 다음에 이 사각을 밟는 사람이 있다면 그게 그 판단이 틀렸다는
# 신호이니 그때 확장한다.
_DESTRUCTIVE_ATTRS = {"create_all", "drop_all"}
_MARKER_NAME = "destructive_schema"
_DDL_LITERAL_PATTERN = re.compile(r"\b(DROP|CREATE|TRUNCATE|ALTER)\s+TABLE\b", re.IGNORECASE)


_SQL_EXEC_CALL_NAMES = {"text", "execute"}


def _call_func_name(node: ast.Call) -> str | None:
    func = node.func
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return None


def _calls_raw_ddl_literal(tree: ast.AST) -> bool:
    """`sa.text(...)`/`conn.execute(...)`(함수명이 정확히 "text" 또는 "execute"인 호출)의
    인자로 전달된 **문자열 리터럴**에 DDL 키워드가 있으면 True.

    ⚠️ 처음 버전은 "모든 함수 호출의 문자열 인자"를 봤다가 오탐을 냈다 — `@pytest.mark.xfail(
    reason="...CREATE TABLE 원문 인용...")`처럼 SQL을 실행하지 않고 **설명하는** 프로즈도
    어떤 호출의 키워드 인자이긴 하다(#2643 그라운딩 중 실측 발견, test_event1config_
    webhook_targets.py). 실제로 DB에 위험한 것은 "이 문자열이 SQL 실행 함수로 전달됐는가"
    뿐이므로 함수명을 text/execute로 좁혀 그 오탐을 없앤다 — docstring/주석은 애초에 호출의
    인자가 아니라서 안 걸리고, 이제 "호출은 됐지만 SQL 실행이 아닌" 경우도 안 걸린다."""
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or _call_func_name(node) not in _SQL_EXEC_CALL_NAMES:
            continue
        for arg in list(node.args) + [kw.value for kw in node.keywords]:
            if (
                isinstance(arg, ast.Constant)
                and isinstance(arg.value, str)
                and _DDL_LITERAL_PATTERN.search(arg.value)
            ):
                return True
    return False


def _calls_destructive_schema_api(filepath: Path) -> bool:
    try:
        tree = ast.parse(filepath.read_text(encoding="utf-8"))
    except (SyntaxError, OSError, UnicodeDecodeError):
        return False
    if any(
        isinstance(node, ast.Attribute) and node.attr in _DESTRUCTIVE_ATTRS
        for node in ast.walk(tree)
    ):
        return True
    return _calls_raw_ddl_literal(tree)


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
            "다음 테스트 파일이 Base.metadata.create_all/drop_all 또는 raw SQL DDL 리터럴"
            "(DROP/CREATE/TRUNCATE/ALTER TABLE, story #2643)을 호출하지만 "
            f"@pytest.mark.{_MARKER_NAME} 마커가 없습니다(alembic-migrated 공유 DB를 오염시켜 "
            "무관한 테스트를 연쇄 실패시킬 수 있음 — story 8236bbc3/#2643). 파일 최상단에 "
            f"`pytestmark = pytest.mark.{_MARKER_NAME}` 를 추가하세요:\n"
            + "\n".join(sorted(violations))
        )


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def org_id() -> uuid.UUID:
    return uuid.uuid4()


def override_db_and_read(app, provider) -> None:
    """story #2451(§6 Phase3): DB 세션 오버라이드 «root fix» — get_db 하나만 걸고
    get_read_db 는 잊는 클래스의 회귀가 A1(사후 12건)·A2(사전 스윕에도 legacy alias
    `/api/v2/epics`=goals.router 재마운트를 놓쳐 test_epics.py CI 7건 red, 카디르 QA
    2026-08-04) 두 번 났다 — path-string grep 스윕은 «신규 경로만 잡고 dual-mount
    legacy alias 는 구조적으로 못 본다»는 게 근본 원인.

    처방: get_db 오버라이드를 다는 자리는 이 헬퍼 하나만 거치게 해 get_read_db 를
    «구조적으로» 못 빠뜨리게 한다 — 어떤 path/alias 로 들어오든(라우터가 여러 prefix로
    재마운트되든) 이 두 dependency key 가 항상 같은 provider 를 가리키므로 «놓칠 수
    없다」. 세션 생성 로직(커밋/롤백 유무 등)은 파일마다 달라 통일하지 않는다 — provider
    콜러블 자체를 받아 두 key 에 동일하게 건다."""
    from app.dependencies.database import get_db, get_read_db

    app.dependency_overrides[get_db] = provider
    app.dependency_overrides[get_read_db] = provider


@pytest.fixture
def project_id() -> uuid.UUID:
    return uuid.uuid4()


class FakeAsyncSessionCtx:
    """story #2459(§6 봉합①): get_current_user/get_verified_org_id/get_project_scoped_org_id가
    이제 요청-수명 Depends(get_db) 대신 함수 내부 `async with async_session_factory()` 단명
    세션을 쓴다 — FastAPI dependency_overrides로는 이걸 가로챌 수 없다(Depends 그래프를 안
    타므로). 이 함수들을 직접 호출하는 테스트는 대신 이 패턴으로 패치한다:

        with patch.object(auth, "async_session_factory", return_value=FakeAsyncSessionCtx(mock_db)):
            result = await get_verified_org_id(auth=..., x_org_id=..., x_project_id=..., request=...)

    (test_sse_conn_leak.py의 _FakeSession과 동형 — 여러 파일이 필요로 해 conftest로 공용화.)
    """

    def __init__(self, session):
        self._session = session

    async def __aenter__(self):
        return self._session

    async def __aexit__(self, *exc):
        return False


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
    from app.dependencies.database import get_db, get_read_db
    from app.main import app

    async def _override_db():
        yield mock_session

    async def _override_auth():
        return auth_ctx

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_read_db] = _override_db
    app.dependency_overrides[get_current_user] = _override_auth

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client

    app.dependency_overrides.clear()
