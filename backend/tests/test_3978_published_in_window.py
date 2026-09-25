"""story #3978(E-UX-OVERHAUL·「결과」 구현 2/N·BE) — `_resolve_published_today`(story
#3821)에서 추출한 공용 `resolve_published_since`/`resolve_published_in_window`
(today_service.py) + `insights-board` 응답의 `published_in_window` additive 필드
(insights_board.py) 검증. 「오늘」 무회귀는 test_3823_today_aggregate_route.py::
test_published_today_aggregates_by_channel_within_tz_boundary_realdb가 이미 고정 —
이 파일은 새 공용 함수·새 필드만 추가로 검증(중복 재검증 0)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org3978", slug=f"org3978-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_connection(session, org_id, *, channel="threads"):
    from app.models.channel_connection import ChannelConnection

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel, account_id=f"acct-{uuid.uuid4().hex[:8]}",
        status="active", credential_kind="oauth",
    )
    session.add(conn)
    await session.commit()
    return conn.id


async def _seed_completed_command(session, org_id, connection_id, *, updated_at):
    from app.models.publication_command import PublicationCommand

    cmd = PublicationCommand(
        id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), destination=connection_id,
        approved_version=uuid.uuid4(), operation="publish", status="completed",
        requested_by_member_id=uuid.uuid4(), updated_at=updated_at,
    )
    session.add(cmd)
    await session.commit()
    return cmd.id


@pytest.mark.anyio
async def test_resolve_published_since_boundary_inclusive():
    """공용 함수 기간 경계 — since 시각과 정확히 같은 updated_at은 포함(>=), 그 직전은
    제외."""
    from app.services.today_service import resolve_published_since

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org_project(s)
            conn_id = await _seed_connection(s, org_id)
            since = datetime(2026, 9, 17, 0, 0, 0, tzinfo=timezone.utc)
            await _seed_completed_command(s, org_id, conn_id, updated_at=since)  # 경계 그 자체 — 포함
            await _seed_completed_command(
                s, org_id, conn_id, updated_at=since - timedelta(seconds=1),
            )  # 경계 직전 — 제외

            result = await resolve_published_since(s, org_id, since)
            assert result["count"] == 1
            assert result["by_channel"] == [{"channel_kind": "threads", "count": 1}]
            assert result["since"] == since
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_published_in_window_null_when_no_connections():
    """AC3 — 채널 연결이 org에 0개면 null(발행 개념 자체가 아직 없음)."""
    from app.services.today_service import resolve_published_in_window

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org_project(s)
            result = await resolve_published_in_window(
                s, org_id, datetime.now(timezone.utc) - timedelta(days=7),
            )
            assert result is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_published_in_window_zero_when_connected_but_nothing_published():
    """AC3 반대편 — 연결은 있고 기간 내 발행이 0건이면 null이 아니라 실 0."""
    from app.services.today_service import resolve_published_in_window

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org_project(s)
            await _seed_connection(s, org_id)  # 발행 이력은 안 심음
            result = await resolve_published_in_window(
                s, org_id, datetime.now(timezone.utc) - timedelta(days=7),
            )
            assert result == {"count": 0, "by_channel": [], "since": result["since"]}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_insights_board_response_includes_published_in_window():
    """AC2 — insights-board 응답에 published_in_window가 실제로 실린다(연결 있고
    기간 내 발행 1건인 경우 count=1)."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org_project(s)
            conn_id = await _seed_connection(s, org_id)
            await _seed_completed_command(s, org_id, conn_id, updated_at=datetime.now(timezone.utc))

            result = await list_insights_board(s, viewer_is_human=True, org_id=org_id, window="7d")
            assert result["published_in_window"] is not None
            assert result["published_in_window"]["count"] == 1
            assert result["published_in_window"]["by_channel"] == [{"channel_kind": "threads", "count": 1}]
    finally:
        await engine.dispose()


async def _seed_site_post_with_d7_view(session, *, org_id, published_at, views):
    """story #3978 CHANGES — SitePost 1건 + 그 D+7 organic captured InsightSnapshot
    1건(views=주어진 값). test_3502_insights_board.py::_seed_site_post와 동형(중복
    재발명 아님, 이 파일 self-contained 유지를 위해 최소 인라인)."""
    from app.models.site_post import SitePost
    from app.models.insight_snapshot import InsightSnapshot

    work_item_id = uuid.uuid4()
    post = SitePost(
        id=uuid.uuid4(), org_id=org_id, lang="ko", slug=f"post-{uuid.uuid4().hex[:8]}", title="제목",
        summary="요약", tags=[], body_md="본문", published_at=published_at, source_story_id=work_item_id,
        gate_id=uuid.uuid4(),
    )
    session.add(post)
    await session.commit()
    snap = InsightSnapshot(
        id=uuid.uuid4(), org_id=org_id, publication_id=post.id, publication_kind="site_post",
        work_item_id=work_item_id, channel="hosted_site", due_at=published_at + timedelta(days=7),
        status="captured", normalized={"views": views},
    )
    session.add(snap)
    await session.commit()
    return post.id


@pytest.mark.anyio
async def test_views_in_window_sums_captured_d7_views_page_independent():
    """CHANGES AC — 페이지 크기 1로 불러도 합이 같다(전체 집계가 rows[] 페이지네이션과
    무관함을 고정)."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        async with Session() as s:
            org_id, _project_id = await _seed_org_project(s)
            await _seed_site_post_with_d7_view(s, org_id=org_id, published_at=now - timedelta(days=1), views=100)
            await _seed_site_post_with_d7_view(s, org_id=org_id, published_at=now - timedelta(days=2), views=50)

            full_page = await list_insights_board(s, viewer_is_human=True, org_id=org_id, window="7d", limit=50)
            one_page = await list_insights_board(s, viewer_is_human=True, org_id=org_id, window="7d", limit=1)

        assert full_page["views_in_window"] == {"sum": 150, "captured_rows": 2, "total_rows": 2}
        assert one_page["views_in_window"] == full_page["views_in_window"]  # 페이지 크기 무관
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_views_in_window_null_when_nothing_captured():
    """CHANGES AC — 창 안에 발행은 있어도 D+7 captured 스냅샷이 0건이면 null(미측정,
    0을 지어내지 않는다)."""
    from app.services.insights_board import list_insights_board
    from app.models.site_post import SitePost

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org_project(s)
            # 스냅샷 없이 발행만(아직 D+7 캡처 시점이 안 됐거나 실패한 상황을 흉내).
            post = SitePost(
                id=uuid.uuid4(), org_id=org_id, lang="ko", slug=f"post-{uuid.uuid4().hex[:8]}", title="제목",
                summary="요약", tags=[], body_md="본문",
                published_at=datetime.now(timezone.utc) - timedelta(days=1),
                source_story_id=uuid.uuid4(), gate_id=uuid.uuid4(),
            )
            s.add(post)
            await s.commit()

            result = await list_insights_board(s, viewer_is_human=True, org_id=org_id, window="7d")

        assert result["views_in_window"] is None
    finally:
        await engine.dispose()
