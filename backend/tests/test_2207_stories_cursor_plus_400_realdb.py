"""story #2207([근본]) — 실 PG.

근본: list_stories(board/generic 두 분기)가 `datetime.fromisoformat(cursor)`를 예외처리 없이
불러 잘못된 커서가 500으로 올라갔다. 실제 dev 스택트레이스(까심 발견)에서 잡힌 값은
`2026-07-24T09:47:33.640536 00:00`(원래 `+00:00`인데, URL 쿼리스트링에서 인코딩 안 된 `+`가
공백으로 디코드된 것 — 웹의 오래된 규칙, FE 다섯 호출부 중 둘이 실제로 인코딩을 잊었다).

AC4 규율 그대로 — `+`가 없는 정상 커서로만 도는 테스트는 이 결함을 못 잡는다. 아래는 그
malformed 값(공백 버전) 자체로 검증한다.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

# 실제 dev 스택트레이스에서 잡힌 malformed 값 그대로(원래 '+00:00'이던 자리가 ' 00:00'으로
# 디코드된 것) — AC4: "결함이 있던 값으로 걸어야 판별력이 생긴다".
_MALFORMED_CURSOR = "2026-07-24T09:47:33.640536 00:00"
_VALID_CURSOR_WITH_PLUS = "2026-07-24T09:47:33.640536+00:00"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def test_parse_stories_cursor_raises_400_not_500_for_malformed_value():
    """⭐단위 검증 — malformed 값(공백판)에 ValueError가 그대로 안 올라가고 HTTPException(400)
    으로 변환됨을 고정. AC1 본체."""
    from fastapi import HTTPException

    from app.routers.stories import _parse_stories_cursor

    with pytest.raises(HTTPException) as exc_info:
        _parse_stories_cursor(_MALFORMED_CURSOR)
    assert exc_info.value.status_code == 400


def test_parse_stories_cursor_accepts_valid_iso_with_plus():
    """회귀 0 — 정상 ISO(+00:00 포함, 제대로 디코드된 경우)는 그대로 파싱된다."""
    from datetime import timezone

    from app.routers.stories import _parse_stories_cursor

    result = _parse_stories_cursor(_VALID_CURSOR_WITH_PLUS)
    assert result is not None
    assert result.tzinfo is not None
    assert result.utcoffset().total_seconds() == 0


def test_parse_stories_cursor_none_passthrough():
    from app.routers.stories import _parse_stories_cursor

    assert _parse_stories_cursor(None) is None
    assert _parse_stories_cursor("") is None


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(session):
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="backlog")
    session.add(story)
    await session.commit()

    return {"org_id": org.id, "project_id": project.id}


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, org_id):
    from app.dependencies.auth import AuthContext, get_current_user

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(uuid.uuid4()), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_generic_branch_raw_unencoded_plus_round_trip_returns_400_not_500_realdb():
    """⭐AC4/AC5 핵심 — httpx로 **인코딩 없이** `+`를 URL에 그대로 심어 실제 서버 요청을
    보낸다. 표준 쿼리스트링 디코딩 규칙대로 서버에 도착할 때 `+`가 공백이 되는 것까지
    포함한 실제 왕복(코드만 보고 닫지 않는다 — AC5). ⚠️project_id는 의도적으로 안 준다 —
    `get_project_scoped_org_id`가 project_id 지정 시 별도 단명 세션(전역 엔진, 이 테스트의
    스크래치 DB override 밖)으로 조회해 이 격리 테스트 환경에서 커넥션이 안 열린다(무관
    인프라 제약) — project_id 없이도 generic 분기의 cursor 파싱(:~230, board 분기와 동일
    `_parse_stories_cursor` 공유 헬퍼)은 그대로 탄다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app_human(app, Session, seeded["org_id"])
        client = _client_for(app)
        try:
            # httpx는 문자열 URL을 이미-인코딩된 것으로 취급해 그대로 보낸다 — '+'가 인코딩
            # 안 된 채(브라우저 버그와 동일 모양) 서버에 도달, 표준 x-www-form-urlencoded
            # 규칙(+→공백)으로 디코드된다.
            resp = await client.get(f"/api/v2/stories?cursor={_VALID_CURSOR_WITH_PLUS}")
            assert resp.status_code == 400, (
                f"malformed cursor(+ 미인코딩 왕복)가 400이 아니라 {resp.status_code} — "
                f"body: {resp.text}"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def test_board_branch_reuses_same_cursor_parser_source():
    """board 분기(status_filter+project_id 조합)도 generic 분기와 **같은** `_parse_stories_
    cursor` 헬퍼를 쓰는지 소스 검사로 고정 — 위 HTTP 왕복 테스트가 project_id 의존성 때문에
    board 분기까지 직접 못 도는 것을 이걸로 보강한다(발행 지점이 갈라지면 한쪽만 고쳐지는
    #2131류 결함 재발 방지와 동형 규율)."""
    import inspect

    from app.routers.stories import list_stories

    source = inspect.getsource(list_stories)
    assert source.count("_parse_stories_cursor(cursor)") == 2, (
        "board·generic 두 분기가 같은 헬퍼를 부르지 않으면 한쪽만 고쳐진 것 — "
        f"실제 호출 횟수: {source.count('_parse_stories_cursor(cursor)')}"
    )
