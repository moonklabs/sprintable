"""story #3502(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 성과 보드 API 조각①
(UNION ALL 서비스 함수+인덱스). 세팅 헬퍼는 test_3471_org_content_rules_lint.py와
동형(중복 재발명 금지) — org/story 시딩은 재사용하고, 이 스토리 전용(SitePost·
ChannelPublication+Gate+Story 조인 축·InsightSnapshot)만 새로 추가한다.

표본 5행(PO 確定 그대로) — hosted_site 2·threads 2·webhook 1, 스냅샷 있음/없음/
unsupported 섞음."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_3471_org_content_rules_lint import (
    _client_for,
    _seed_agent,
    _seed_human,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
)

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


async def _seed_site_post(
    session, *, org_id, work_item_id, lang="ko", slug, title, published_at, unpublished_at=None,
):
    from app.models.site_post import SitePost

    post = SitePost(
        id=uuid.uuid4(), org_id=org_id, lang=lang, slug=slug, title=title, summary="요약",
        tags=[], body_md="본문", published_at=published_at, source_story_id=work_item_id,
        gate_id=uuid.uuid4(), unpublished_at=unpublished_at,
    )
    session.add(post)
    await session.commit()
    return post


async def _seed_gate(session, *, org_id, work_item_id, status="approved"):
    from app.models.gate import Gate

    gate = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type="story",
        gate_type="external_publish", status=status,
    )
    session.add(gate)
    await session.commit()
    return gate


async def _seed_channel_publication(
    session, *, org_id, gate_id, channel, published_at, permalink="https://example.com/post",
    connection_id=None, status="published",
):
    from app.models.channel_publication import ChannelPublication

    pub = ChannelPublication(
        id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, version_id=uuid.uuid4(),
        connection_id=connection_id or uuid.uuid4(), channel=channel, status=status,
        external_id=f"ext-{uuid.uuid4().hex[:8]}", permalink=permalink, published_at=published_at,
    )
    session.add(pub)
    await session.commit()
    return pub


async def _seed_snapshot(
    session, *, org_id, work_item_id, publication_id, publication_kind, channel,
    due_at, status="captured", normalized=None,
):
    from app.models.insight_snapshot import InsightSnapshot

    snap = InsightSnapshot(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
        publication_kind=publication_kind, channel=channel, due_at=due_at, status=status,
        captured_at=datetime.now(timezone.utc) if status == "captured" else None,
        normalized=normalized,
    )
    session.add(snap)
    await session.commit()
    return snap


@pytest.mark.anyio
async def test_pivot_matches_real_scheduler_offsets_not_a_hand_rolled_assumption():
    """페드루 PO 기록①(PR#3849 리뷰) — insights_board.py의 피벗(`.days`/round 판정)이
    insight_snapshots.py::schedule_insight_snapshots()의 실제 `_SNAPSHOT_OFFSETS`
    (+1일·+7일)와 짝으로 맞는지 «직접» 잠근다. 이 파일의 다른 테스트는 전부 스냅샷을
    수작업(_seed_snapshot)으로 심는데, 그 수작업이 스케줄러의 실제 due_at 계산과
    조용히 갈리면(예: 스케줄러가 오프셋을 바꿔도 이 테스트들은 여전히 통과) 드리프트를
    못 잡는다 — 이 테스트만 진짜 스케줄러 함수를 부른다."""
    from app.services.insight_snapshots import schedule_insight_snapshots
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            sp = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-real-sched", title="Real",
                published_at=datetime.now(timezone.utc) - timedelta(days=10),
            )
            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=story_id, publication_id=sp.id,
                publication_kind="site_post", channel="hosted_site", external_id=None,
                anchor_at=sp.published_at,
            )
            await s.commit()

            result = await list_insights_board(s, org_id=org_id, window="30d")
        row = next(r for r in result["rows"] if r["publication_id"] == sp.id)
        assert row["d1"] is not None, "스케줄러가 심은 +1일 행을 피벗이 못 찾았다(오프셋 드리프트)"
        assert row["d7"] is not None, "스케줄러가 심은 +7일 행을 피벗이 못 찾았다(오프셋 드리프트)"
        assert row["d1"]["status"] == "pending" and row["d7"]["status"] == "pending"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_five_row_sample_unified_across_hosted_site_and_channels():
    """AC1 표본 — hosted_site 2·threads 2·webhook 1, 스냅샷 있음/없음/unsupported."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)

            # hosted_site #1 — d7 스냅샷 captured(views=100).
            sp1 = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-1", title="글1",
                published_at=now - timedelta(days=10),
            )
            await _seed_snapshot(
                s, org_id=org_id, work_item_id=story_id, publication_id=sp1.id,
                publication_kind="site_post", channel="hosted_site",
                due_at=sp1.published_at + timedelta(days=7), status="captured",
                normalized={"views": 100, "impressions": None, "reach": None, "engagements": None,
                            "clicks": None, "spend": None, "conversions": None},
            )

            # hosted_site #2 — 스냅샷 아예 없음.
            sp2 = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-2", title="글2",
                published_at=now - timedelta(days=5),
            )

            # threads #1 — d7 unsupported.
            gate1 = await _seed_gate(s, org_id=org_id, work_item_id=story_id)
            cp1 = await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate1.id, channel="threads", published_at=now - timedelta(days=8),
            )
            await _seed_snapshot(
                s, org_id=org_id, work_item_id=story_id, publication_id=cp1.id,
                publication_kind="channel_publication", channel="threads",
                due_at=cp1.published_at + timedelta(days=7), status="unsupported",
            )

            # threads #2 — 스냅샷 없음.
            gate2 = await _seed_gate(s, org_id=org_id, work_item_id=story_id)
            cp2 = await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate2.id, channel="threads", published_at=now - timedelta(days=3),
            )

            # webhook #1 — d1 captured(views=50), d7 captured(views=80).
            gate3 = await _seed_gate(s, org_id=org_id, work_item_id=story_id)
            cp3 = await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate3.id, channel="webhook", published_at=now - timedelta(days=9),
            )
            await _seed_snapshot(
                s, org_id=org_id, work_item_id=story_id, publication_id=cp3.id,
                publication_kind="channel_publication", channel="webhook",
                due_at=cp3.published_at + timedelta(days=1), status="captured",
                normalized={"views": 50, "impressions": None, "reach": None, "engagements": None,
                            "clicks": None, "spend": None, "conversions": None},
            )
            await _seed_snapshot(
                s, org_id=org_id, work_item_id=story_id, publication_id=cp3.id,
                publication_kind="channel_publication", channel="webhook",
                due_at=cp3.published_at + timedelta(days=7), status="captured",
                normalized={"views": 80, "impressions": None, "reach": None, "engagements": None,
                            "clicks": None, "spend": None, "conversions": None},
            )

            result = await list_insights_board(s, org_id=org_id, window="30d")

        rows = result["rows"]
        assert len(rows) == 5, [r["publication_id"] for r in rows]
        by_id = {r["publication_id"]: r for r in rows}

        row1 = by_id[sp1.id]
        assert row1["kind"] == "site_post" and row1["channel"] == "hosted_site"
        assert row1["work_item_id"] == story_id and row1["title"] == "글1"
        assert row1["connection_id"] is None
        assert row1["d7"]["status"] == "captured" and row1["d7"]["normalized"]["views"] == 100
        assert row1["d1"] is None

        row2 = by_id[sp2.id]
        assert row2["d1"] is None and row2["d7"] is None

        row_cp1 = by_id[cp1.id]
        assert row_cp1["kind"] == "channel_publication" and row_cp1["channel"] == "threads"
        assert row_cp1["work_item_id"] == story_id, "ChannelPublication에 없는 축이라 Gate 조인으로 와야 한다"
        assert row_cp1["title"] == "콘텐츠", "title은 Story에서 와야 한다(ChannelPublication엔 컬럼 자체가 없음)"
        assert row_cp1["d7"]["status"] == "unsupported"

        row_cp3 = by_id[cp3.id]
        assert row_cp3["d1"]["normalized"]["views"] == 50
        assert row_cp3["d7"]["normalized"]["views"] == 80
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_filter_hosted_site_excludes_channel_publications():
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)
            sp = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-x", title="X",
                published_at=now - timedelta(days=1),
            )
            gate = await _seed_gate(s, org_id=org_id, work_item_id=story_id)
            await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate.id, channel="threads", published_at=now - timedelta(days=1),
            )

            result = await list_insights_board(s, org_id=org_id, window="30d", channel="hosted_site")
        assert [r["publication_id"] for r in result["rows"]] == [sp.id]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_filter_threads_excludes_hosted_site_and_other_channels():
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)
            await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-y", title="Y",
                published_at=now - timedelta(days=1),
            )
            gate1 = await _seed_gate(s, org_id=org_id, work_item_id=story_id)
            cp_threads = await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate1.id, channel="threads", published_at=now - timedelta(days=1),
            )
            gate2 = await _seed_gate(s, org_id=org_id, work_item_id=story_id)
            await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate2.id, channel="webhook", published_at=now - timedelta(days=1),
            )

            result = await list_insights_board(s, org_id=org_id, window="30d", channel="threads")
        assert [r["publication_id"] for r in result["rows"]] == [cp_threads.id]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_status_filter_only_returns_rows_with_matching_snapshot_status():
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)
            sp_captured = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-cap", title="Cap",
                published_at=now - timedelta(days=2),
            )
            await _seed_snapshot(
                s, org_id=org_id, work_item_id=story_id, publication_id=sp_captured.id,
                publication_kind="site_post", channel="hosted_site",
                due_at=sp_captured.published_at + timedelta(days=1), status="captured",
                normalized={"views": 1, "impressions": None, "reach": None, "engagements": None,
                            "clicks": None, "spend": None, "conversions": None},
            )
            sp_no_snapshot = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-nosnap", title="NoSnap",
                published_at=now - timedelta(days=2),
            )

            result = await list_insights_board(s, org_id=org_id, window="30d", status="captured")
        assert [r["publication_id"] for r in result["rows"]] == [sp_captured.id]
        assert sp_no_snapshot.id not in [r["publication_id"] for r in result["rows"]]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_window_filter_excludes_publications_outside_window():
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)
            recent = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-recent", title="Recent",
                published_at=now - timedelta(days=5),
            )
            await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-old", title="Old",
                published_at=now - timedelta(days=40),
            )

            result = await list_insights_board(s, org_id=org_id, window="7d")
        assert [r["publication_id"] for r in result["rows"]] == [recent.id]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublished_site_post_excluded():
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)
            await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-unpub", title="Unpub",
                published_at=now - timedelta(days=1), unpublished_at=now,
            )

            result = await list_insights_board(s, org_id=org_id, window="30d")
        assert result["rows"] == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sort_by_metric_puts_null_last():
    """PO 確定 (c) — (metric NULLS LAST, published_at DESC, id) 3키. views_d7 정렬 시
    스냅샷이 없는(=metric null) 행이 항상 맨 뒤로 간다."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)

            sp_high = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-high", title="High",
                published_at=now - timedelta(days=10),
            )
            await _seed_snapshot(
                s, org_id=org_id, work_item_id=story_id, publication_id=sp_high.id,
                publication_kind="site_post", channel="hosted_site",
                due_at=sp_high.published_at + timedelta(days=7), status="captured",
                normalized={"views": 500, "impressions": None, "reach": None, "engagements": None,
                            "clicks": None, "spend": None, "conversions": None},
            )
            sp_null = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-null", title="Null",
                published_at=now - timedelta(days=9),
            )
            sp_low = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-low", title="Low",
                published_at=now - timedelta(days=8),
            )
            await _seed_snapshot(
                s, org_id=org_id, work_item_id=story_id, publication_id=sp_low.id,
                publication_kind="site_post", channel="hosted_site",
                due_at=sp_low.published_at + timedelta(days=7), status="captured",
                normalized={"views": 10, "impressions": None, "reach": None, "engagements": None,
                            "clicks": None, "spend": None, "conversions": None},
            )

            result = await list_insights_board(s, org_id=org_id, window="30d", sort="views_d7")
        ids = [r["publication_id"] for r in result["rows"]]
        assert ids == [sp_high.id, sp_low.id, sp_null.id], "높은 값 먼저·null은 맨 뒤여야 한다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sort_by_metric_asc_orders_low_to_high():
    """페드루 PO 실측(2026-09-05, fd57310d4 리뷰) — metric 정렬 분기가 sort_dir를
    완전히 무시하고 desc로 하드코딩돼 있었다(ORDER BY·커서 비교 세 자리 전부).
    양성대조: 이 테스트는 그 fix 이전 코드에서 RED여야 한다(고정값 10<500이 desc로만
    나오면 [high, low] 순서가 나와 이 assert가 깨진다)."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)

            sp_high = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-high-asc", title="High",
                published_at=now - timedelta(days=10),
            )
            await _seed_snapshot(
                s, org_id=org_id, work_item_id=story_id, publication_id=sp_high.id,
                publication_kind="site_post", channel="hosted_site",
                due_at=sp_high.published_at + timedelta(days=7), status="captured",
                normalized={"views": 500, "impressions": None, "reach": None, "engagements": None,
                            "clicks": None, "spend": None, "conversions": None},
            )
            sp_low = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-low-asc", title="Low",
                published_at=now - timedelta(days=8),
            )
            await _seed_snapshot(
                s, org_id=org_id, work_item_id=story_id, publication_id=sp_low.id,
                publication_kind="site_post", channel="hosted_site",
                due_at=sp_low.published_at + timedelta(days=7), status="captured",
                normalized={"views": 10, "impressions": None, "reach": None, "engagements": None,
                            "clicks": None, "spend": None, "conversions": None},
            )

            result = await list_insights_board(
                s, org_id=org_id, window="30d", sort="views_d7", sort_dir="asc",
            )
        ids = [r["publication_id"] for r in result["rows"]]
        assert ids == [sp_low.id, sp_high.id], "asc면 낮은 값(10)이 먼저, 높은 값(500)이 뒤여야 한다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sort_by_metric_asc_cursor_pagination_no_duplicates_no_gaps():
    """metric asc 2페이지째가 (desc 하드코딩 커서 비교 탓에) 뒤로 점프하지 않는지 —
    서로 다른 값 4개를 오름차순으로 페이지네이션."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)
            ids = []
            for i, views in enumerate([40, 10, 30, 20]):
                sp = await _seed_site_post(
                    s, org_id=org_id, work_item_id=story_id, slug=f"post-asc-page-{i}", title=f"P{i}",
                    published_at=now - timedelta(days=i),
                )
                await _seed_snapshot(
                    s, org_id=org_id, work_item_id=story_id, publication_id=sp.id,
                    publication_kind="site_post", channel="hosted_site",
                    due_at=sp.published_at + timedelta(days=7), status="captured",
                    normalized={"views": views, "impressions": None, "reach": None, "engagements": None,
                                "clicks": None, "spend": None, "conversions": None},
                )
                ids.append((views, sp.id))
            expected_order = [pid for _v, pid in sorted(ids, key=lambda t: t[0])]

            page1 = await list_insights_board(
                s, org_id=org_id, window="30d", sort="views_d7", sort_dir="asc", limit=2,
            )
            assert len(page1["rows"]) == 2 and page1["has_more"] is True
            page2 = await list_insights_board(
                s, org_id=org_id, window="30d", sort="views_d7", sort_dir="asc", limit=2,
                cursor=page1["next_cursor"],
            )
            assert len(page2["rows"]) == 2 and page2["has_more"] is False

            seen = [r["publication_id"] for p in (page1, page2) for r in p["rows"]]
        assert seen == expected_order, "asc 커서 페이지네이션이 오름차순으로 중복/누락 없이 이어져야 한다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sort_by_metric_asc_null_group_still_last_with_cursor_continuity():
    """PO 決定 (c) — nulls_last()는 방향 무관 상수. asc에서도 null 그룹은 맨 뒤이고,
    그 null 그룹 «안에서»의 커서 연속(published_at/id tie-break)도 asc 방향으로
    맞아야 한다."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)

            sp_value = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-asc-value", title="Value",
                published_at=now - timedelta(days=20),
            )
            await _seed_snapshot(
                s, org_id=org_id, work_item_id=story_id, publication_id=sp_value.id,
                publication_kind="site_post", channel="hosted_site",
                due_at=sp_value.published_at + timedelta(days=7), status="captured",
                normalized={"views": 5, "impressions": None, "reach": None, "engagements": None,
                            "clicks": None, "spend": None, "conversions": None},
            )
            # null 그룹 — published_at 서로 다른 2행(둘 다 스냅샷 없음=metric null).
            sp_null_older = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-asc-null-older", title="NullOlder",
                published_at=now - timedelta(days=9),
            )
            sp_null_newer = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-asc-null-newer", title="NullNewer",
                published_at=now - timedelta(days=8),
            )

            page1 = await list_insights_board(
                s, org_id=org_id, window="30d", sort="views_d7", sort_dir="asc", limit=1,
            )
            assert [r["publication_id"] for r in page1["rows"]] == [sp_value.id], (
                "값 있는 행이 null 그룹보다 먼저(asc에서도 null은 맨 뒤)"
            )
            page2 = await list_insights_board(
                s, org_id=org_id, window="30d", sort="views_d7", sort_dir="asc", limit=2,
                cursor=page1["next_cursor"],
            )
        ids2 = [r["publication_id"] for r in page2["rows"]]
        assert ids2 == [sp_null_older.id, sp_null_newer.id], (
            "null 그룹 안에서도 커서가 published_at asc 순서로 이어져야 한다"
        )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cursor_pagination_published_at_no_duplicates_no_gaps():
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)
            ids = []
            for i in range(5):
                sp = await _seed_site_post(
                    s, org_id=org_id, work_item_id=story_id, slug=f"post-page-{i}", title=f"P{i}",
                    published_at=now - timedelta(days=i),
                )
                ids.append(sp.id)

            page1 = await list_insights_board(s, org_id=org_id, window="30d", limit=2)
            assert len(page1["rows"]) == 2 and page1["has_more"] is True
            page2 = await list_insights_board(
                s, org_id=org_id, window="30d", limit=2, cursor=page1["next_cursor"],
            )
            assert len(page2["rows"]) == 2 and page2["has_more"] is True
            page3 = await list_insights_board(
                s, org_id=org_id, window="30d", limit=2, cursor=page2["next_cursor"],
            )
            assert len(page3["rows"]) == 1 and page3["has_more"] is False

            seen = [r["publication_id"] for p in (page1, page2, page3) for r in p["rows"]]
        assert seen == ids, "커서 페이지네이션이 중복/누락 없이 전량을 정확한 순서로 내야 한다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cursor_pagination_tied_published_at_no_duplicates_no_gaps():
    """pagination.py 자신의 docstring이 경고하는 그 병(같은 정렬키 동률 구간에서
    페이지 경계 행 누락/중복) — published_at이 완전히 같은 3행을 만들어 id를
    2차 정렬키로 실제로 쓰는지 확認한다(이전 테스트는 전부 서로 다른 published_at
    이라 이 축을 못 잡았다)."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            tied_at = datetime.now(timezone.utc) - timedelta(days=1)
            ids = []
            for i in range(3):
                sp = await _seed_site_post(
                    s, org_id=org_id, work_item_id=story_id, slug=f"post-tied-{i}", title=f"T{i}",
                    published_at=tied_at,
                )
                ids.append(sp.id)
            ids.sort(reverse=True)  # id DESC가 2차 정렬키(구현 관례).

            page1 = await list_insights_board(s, org_id=org_id, window="30d", limit=2)
            assert len(page1["rows"]) == 2 and page1["has_more"] is True
            page2 = await list_insights_board(
                s, org_id=org_id, window="30d", limit=2, cursor=page1["next_cursor"],
            )
            assert len(page2["rows"]) == 1 and page2["has_more"] is False

            seen = [r["publication_id"] for p in (page1, page2) for r in p["rows"]]
        assert seen == ids, "동률 published_at 구간에서 id 2차 정렬키가 안 먹으면 행이 새거나 겹친다"
        assert len(set(seen)) == 3, "중복 행이 나왔다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_invalid_window_raises():
    from app.services.insights_board import InsightsBoardInvalidWindowError, list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            with pytest.raises(InsightsBoardInvalidWindowError):
                await list_insights_board(s, org_id=org_id, window="14d")
    finally:
        await engine.dispose()


# ─── 조각②: HTTP 라우터(GET insights-board · POST follow-ups) ─────────────────


@pytest.mark.anyio
async def test_get_insights_board_endpoint_agent_200_with_rows():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-http", title="HTTP",
                published_at=datetime.now(timezone.utc) - timedelta(days=1),
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/insights-board")
        assert r.status_code == 200, r.text
        body = r.json()
        assert len(body["rows"]) == 1
        assert body["rows"][0]["title"] == "HTTP"
        assert body["has_more"] is False
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_insights_board_endpoint_invalid_window_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/insights-board?window=14d")
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "INSIGHTS_BOARD_INVALID_WINDOW"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_follow_up_creates_story_with_number_and_evidence():
    from app.main import app
    from app.models.evidence import Evidence
    from app.models.pm import Story
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="member")
            story_id = await _seed_story(s, org_id, project_id, title="원문")
            sp = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-fu", title="FU",
                published_at=datetime.now(timezone.utc) - timedelta(days=2),
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{sp.id}/follow-ups",
                json={"kind": "republish", "note": "다시 내보내자"},
            )
        assert r.status_code == 201, r.text
        new_story_id = uuid.UUID(r.json()["story_id"])

        async with Session() as s:
            new_story = (await s.execute(select(Story).where(Story.id == new_story_id))).scalar_one()
            assert new_story.project_id == project_id
            assert new_story.story_number is not None, "allocate_story_number()가 채번해야 한다"
            assert "원문" in new_story.title

            evidence = (await s.execute(
                select(Evidence).where(Evidence.work_item_id == new_story_id)
            )).scalar_one()
            assert evidence.payload["kind"] == "follow_up_created"
            assert evidence.payload["follow_up_kind"] == "republish"
            assert evidence.payload["publication_id"] == str(sp.id)
            assert evidence.payload["recorded_by"] == "platform"
            assert evidence.created_by is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_follow_up_agent_forbidden():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            sp = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-fu-agent", title="FUA",
                published_at=datetime.now(timezone.utc) - timedelta(days=2),
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{sp.id}/follow-ups",
                json={"kind": "edit"},
            )
        assert r.status_code == 403, r.text
        assert r.json()["error"]["code"] == "FOLLOW_UP_CREATE_HUMAN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_follow_up_other_org_publication_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, project_a = await _seed_org(s)
            story_a = await _seed_story(s, org_a, project_a)
            sp_a = await _seed_site_post(
                s, org_id=org_a, work_item_id=story_a, slug="post-org-a", title="A",
                published_at=datetime.now(timezone.utc) - timedelta(days=1),
            )
            org_b, project_b = await _seed_org(s)
            human_b = await _seed_human(s, org_b, role="member")

        _setup_org_scoped_app(app, Session, org_b, user_id=human_b)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_b}/publications/{sp_a.id}/follow-ups",
                json={"kind": "stop"},
            )
        assert r.status_code == 404, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_follow_up_invalid_kind_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="member")
            story_id = await _seed_story(s, org_id, project_id)
            sp = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-fu-badkind", title="Bad",
                published_at=datetime.now(timezone.utc) - timedelta(days=1),
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{sp.id}/follow-ups",
                json={"kind": "delete_everything"},
            )
        assert r.status_code == 422, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
