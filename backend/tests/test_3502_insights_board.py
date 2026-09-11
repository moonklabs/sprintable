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
    connection_id=None, status="published", version_id=None,
):
    from app.models.channel_publication import ChannelPublication

    pub = ChannelPublication(
        # story #3656 — version_id 파라미터화(기본값은 기존 그대로 임의 uuid) — 소재/훅
        # 시딩(ChannelPostVersion·ChannelPostImage)이 이 값을 정확히 가리켜야 한다.
        id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, version_id=version_id or uuid.uuid4(),
        connection_id=connection_id or uuid.uuid4(), channel=channel, status=status,
        external_id=f"ext-{uuid.uuid4().hex[:8]}", permalink=permalink, published_at=published_at,
    )
    session.add(pub)
    await session.commit()
    return pub


async def _seed_channel_post_draft(session, *, org_id, work_item_id, channel="instagram"):
    """story #3656 — ChannelPostVersion.draft_id는 실 FK(channel_post_drafts.id)라
    test_3645_evidence_asset_hook_keys.py의 「draft_id=uuid.uuid4() 그대로」 관례를
    그대로 못 따른다(그쪽은 ChannelPostImage/Video만 쓰는데 그 둘은 FK 없음 관례 —
    version만 FK가 있다, 실측으로 확認)."""
    from app.models.channel_post_draft import ChannelPostDraft

    draft = ChannelPostDraft(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, channel=channel,
        connection_id=uuid.uuid4(),
    )
    session.add(draft)
    await session.commit()
    return draft


async def _seed_channel_post_version(session, *, draft_id, version_id, hook_key=None):
    from app.models.channel_post_version import ChannelPostVersion

    version = ChannelPostVersion(
        id=version_id, draft_id=draft_id, version=1, text="본문", body_sha256=uuid.uuid4().hex,
        hook_key=hook_key, author_member_id=uuid.uuid4(), author_kind="human",
    )
    session.add(version)
    await session.commit()
    return version


async def _seed_channel_post_image(session, *, org_id, draft_id, version_id, position, sha256=None):
    from app.models.channel_post_image import ChannelPostImage

    image = ChannelPostImage(
        id=uuid.uuid4(), org_id=org_id, draft_id=draft_id, version_id=version_id, position=position,
        original_object_path=f"org/{org_id}/img-{uuid.uuid4().hex[:8]}.jpg",
        original_sha256=sha256 or uuid.uuid4().hex,
        original_content_type="image/jpeg", original_bytes=1234,
        original_width=1080, original_height=1080, created_by=uuid.uuid4(),
    )
    session.add(image)
    await session.commit()
    return image


# story #3734 AC3 후속(2026-09-09) — 원 초안이 보관되면 발행분도 성과 보드 기본에서
# 빠져야 한다는 회귀를 재는 시딩 헬퍼 둘. 기존 파일의 다른 헬퍼와 동형(직접 모델
# construct, API 경유 안 함).
async def _seed_site_post_draft(
    session, *, org_id, work_item_id, slug, deleted_at=None,
):
    from app.models.site_post_draft import SitePostDraft

    draft = SitePostDraft(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, slug=slug,
        deleted_at=deleted_at,
    )
    session.add(draft)
    await session.commit()
    return draft


async def _seed_channel_post_draft_with_deleted_at(session, *, org_id, work_item_id, channel="instagram", deleted_at=None):
    from app.models.channel_post_draft import ChannelPostDraft

    draft = ChannelPostDraft(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, channel=channel,
        connection_id=uuid.uuid4(), deleted_at=deleted_at,
    )
    session.add(draft)
    await session.commit()
    return draft


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


# story #3734 AC3 후속(PO 라이브 판정 2026-09-09 10:16Z) — 보관은 초안 deleted_at만
# 찍고 발행 기록(SitePost/ChannelPublication)은 무변인데(설계대로, #3291 정합) 이
# 보드가 그 사실을 몰라 보관된 초안의 발행분이 그대로 남아 있었다(실측: 라이브 첫
# 화면 20행 중 17이 스모크 표본). 기본 제외 + include_deleted=True로 복귀 확認.
@pytest.mark.anyio
async def test_site_post_excluded_when_source_draft_archived():
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)
            await _seed_site_post_draft(
                s, org_id=org_id, work_item_id=story_id, slug="post-archived",
                deleted_at=now,
            )
            sp = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-archived", title="보관된 글",
                published_at=now - timedelta(days=1),
            )

            result_default = await list_insights_board(s, org_id=org_id, window="30d")
            result_included = await list_insights_board(s, org_id=org_id, window="30d", include_deleted=True)

        assert result_default["rows"] == []
        assert [r["publication_id"] for r in result_included["rows"]] == [sp.id]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_site_post_not_excluded_when_no_matching_draft_exists():
    """원 초안 매칭이 아예 안 되면(순수 발행 레코드만 있는 표본 등) 보관 여부를
    판정할 수 없다 — "모른다≠보관됨"이라 배제하지 않는다(뮤테이션 표적: OR 절을
    지우면 이 케이스도 신규 발행분처럼 빠져 버린다)."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)
            sp = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-no-draft", title="초안 없는 글",
                published_at=now - timedelta(days=1),
            )

            result = await list_insights_board(s, org_id=org_id, window="30d")

        assert [r["publication_id"] for r in result["rows"]] == [sp.id]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_publication_excluded_when_source_draft_archived():
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            gate = await _seed_gate(s, org_id=org_id, work_item_id=story_id)
            draft = await _seed_channel_post_draft_with_deleted_at(
                s, org_id=org_id, work_item_id=story_id, deleted_at=datetime.now(timezone.utc),
            )
            version_id = uuid.uuid4()
            await _seed_channel_post_version(s, draft_id=draft.id, version_id=version_id)
            pub = await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate.id, channel="threads",
                published_at=datetime.now(timezone.utc) - timedelta(days=1), version_id=version_id,
            )

            result_default = await list_insights_board(s, org_id=org_id, window="30d")
            result_included = await list_insights_board(s, org_id=org_id, window="30d", include_deleted=True)

        assert result_default["rows"] == []
        assert [r["publication_id"] for r in result_included["rows"]] == [pub.id]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_publication_not_excluded_when_draft_not_archived():
    """짝 확認 — 보관 안 된(deleted_at=None) 초안의 발행분은 기본 목록에도 그대로
    남는다(회귀 없음, 기존 5행 표본 테스트와 같은 축이지만 이 파일의 새 join 경로가
    멀쩡한 행까지 실수로 안 뺀다는 걸 직접 pin)."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            gate = await _seed_gate(s, org_id=org_id, work_item_id=story_id)
            draft = await _seed_channel_post_draft(s, org_id=org_id, work_item_id=story_id)
            version_id = uuid.uuid4()
            await _seed_channel_post_version(s, draft_id=draft.id, version_id=version_id)
            pub = await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate.id, channel="threads",
                published_at=datetime.now(timezone.utc) - timedelta(days=1), version_id=version_id,
            )

            result = await list_insights_board(s, org_id=org_id, window="30d")

        assert [r["publication_id"] for r in result["rows"]] == [pub.id]
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

# ─── 조각②(HTTP 라우터: GET insights-board · POST follow-ups)는 story #3604로
# test_3502_insights_board_endpoints.py에 분리됐다 — `from app.main import app`
# 1회 비용(~3.4s, 로컬 무경합)이 이 파일에 섞여 있을 때 60초 러너 가드의 등재/경합
# 배율을 왜곡했다(그 파일 머리 주석에 실측 상세). 이 파일에 남은 14개는 전부
# list_insights_board를 서비스 함수로 직접 부르며 app.main을 안 건드린다.

# ─── story #3656(Phase2·FE+BE, 페드루 PO 確定 2026-09-07) — asset_sha256s·hook_key
# additive. 3645(#4002)의 _resolve_channel_publication_asset_evidence 재사용(새
# 판정 0) — 여기 테스트는 "그 헬퍼가 list_insights_board 행에도 정확히 배선됐는가"
# 만 잰다(헬퍼 자신의 로직 커버리지는 test_3645_evidence_asset_hook_keys.py가 이미
# 갖고 있다, 이중 검증 안 함).
@pytest.mark.anyio
async def test_channel_publication_row_carries_asset_sha256s_and_hook_key():
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            gate = await _seed_gate(s, org_id=org_id, work_item_id=story_id)
            draft = await _seed_channel_post_draft(s, org_id=org_id, work_item_id=story_id)
            draft_id = draft.id
            version_id = uuid.uuid4()
            await _seed_channel_post_version(s, draft_id=draft_id, version_id=version_id, hook_key="hook-A")
            await _seed_channel_post_image(
                s, org_id=org_id, draft_id=draft_id, version_id=version_id, position=0, sha256="sha-first",
            )
            await _seed_channel_post_image(
                s, org_id=org_id, draft_id=draft_id, version_id=version_id, position=1, sha256="sha-second",
            )
            pub = await _seed_channel_publication(
                s, org_id=org_id, gate_id=gate.id, channel="instagram",
                published_at=datetime.now(timezone.utc) - timedelta(days=1), version_id=version_id,
            )

            result = await list_insights_board(s, org_id=org_id, window="30d")
        row = next(r for r in result["rows"] if r["publication_id"] == pub.id)
        assert row["asset_sha256s"] == ["sha-first", "sha-second"]
        assert row["hook_key"] == "hook-A"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_site_post_row_asset_and_hook_always_null():
    """site_post(hosted_site)는 이미지/영상·hook_key 개념 자체가 없다 — 있는 걸
    지어내지 않는다(_resolve_channel_publication_asset_evidence의 (None, None)
    조기 반환과 동형 계약을 list_insights_board 행에서도 그대로 고정)."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            sp = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-no-asset", title="글",
                published_at=datetime.now(timezone.utc) - timedelta(days=1),
            )

            result = await list_insights_board(s, org_id=org_id, window="30d")
        row = next(r for r in result["rows"] if r["publication_id"] == sp.id)
        assert row["asset_sha256s"] is None
        assert row["hook_key"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_asset_hook_evidence_query_count_not_proportional_to_row_count():
    """PO CHANGES(2026-09-07) — channel_publication 행마다 소재/훅을 조회하면
    N+1(페이지 상한 200 기준 최악 800쿼리, "보드가 못 견딘다"). 1건일 때와 4건일
    때 SELECT 문 수가 같아야 한다(test_3394_channel_post_list_be_fields.py의
    before_cursor_execute 실측 관례 그대로 재사용 — 새 계측 패턴 발명 0)."""
    from sqlalchemy import event
    from app.services.insights_board import list_insights_board

    def _capture(bucket: list[str]):
        def _listener(conn, cursor, statement, parameters, context, executemany):
            bucket.append(statement)
        return _listener

    async def _seed_one_row(session, *, org_id, story_id, slug_suffix):
        gate = await _seed_gate(session, org_id=org_id, work_item_id=story_id)
        draft = await _seed_channel_post_draft(session, org_id=org_id, work_item_id=story_id)
        version_id = uuid.uuid4()
        await _seed_channel_post_version(session, draft_id=draft.id, version_id=version_id, hook_key=f"hook-{slug_suffix}")
        await _seed_channel_post_image(session, org_id=org_id, draft_id=draft.id, version_id=version_id, position=0)
        await _seed_channel_publication(
            session, org_id=org_id, gate_id=gate.id, channel="instagram",
            published_at=datetime.now(timezone.utc) - timedelta(days=1), version_id=version_id,
        )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_one_row(s, org_id=org_id, story_id=story_id, slug_suffix="1")

        statements_1: list[str] = []
        listener_1 = _capture(statements_1)
        event.listen(engine.sync_engine, "before_cursor_execute", listener_1)
        try:
            async with Session() as s:
                result_1 = await list_insights_board(s, org_id=org_id, window="30d")
                assert len(result_1["rows"]) == 1
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", listener_1)
        select_count_1 = len([st for st in statements_1 if st.strip().upper().startswith("SELECT")])

        async with Session() as s:
            for n in range(2, 5):
                await _seed_one_row(s, org_id=org_id, story_id=story_id, slug_suffix=str(n))

        statements_4: list[str] = []
        listener_4 = _capture(statements_4)
        event.listen(engine.sync_engine, "before_cursor_execute", listener_4)
        try:
            async with Session() as s:
                result_4 = await list_insights_board(s, org_id=org_id, window="30d")
                assert len(result_4["rows"]) == 4
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", listener_4)
        select_count_4 = len([st for st in statements_4 if st.strip().upper().startswith("SELECT")])

        print(f"\n=== N+1 실측(insights-board 소재/훅): 1건 SELECT={select_count_1}, 4건 SELECT={select_count_4}")
        assert select_count_4 == select_count_1, (
            f"쿼리 수가 행 수에 비례한다(N+1) — 1건={select_count_1}, 4건={select_count_4}"
        )
    finally:
        await engine.dispose()


# story #3746(유나 v5, 2026-09-09) — 「수집 대기」는 pending+in_progress 한 통이다
# (다음 발이 같다 — 기다린다). FE는 이 통을 status=pending 하나로 보낸다 — 서비스가
# 그 값을 두 실 상태로 넓힌다.
@pytest.mark.anyio
async def test_status_filter_pending_matches_both_pending_and_in_progress():
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)
            sp_pending = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-pending", title="Pending",
                published_at=now - timedelta(days=1),
            )
            await _seed_snapshot(
                s, org_id=org_id, work_item_id=story_id, publication_id=sp_pending.id,
                publication_kind="site_post", channel="hosted_site",
                due_at=sp_pending.published_at + timedelta(days=1), status="pending",
            )
            sp_in_progress = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-in-progress", title="InProgress",
                published_at=now - timedelta(days=1),
            )
            await _seed_snapshot(
                s, org_id=org_id, work_item_id=story_id, publication_id=sp_in_progress.id,
                publication_kind="site_post", channel="hosted_site",
                due_at=sp_in_progress.published_at + timedelta(days=1), status="in_progress",
            )
            sp_captured = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-captured", title="Captured",
                published_at=now - timedelta(days=1),
            )
            await _seed_snapshot(
                s, org_id=org_id, work_item_id=story_id, publication_id=sp_captured.id,
                publication_kind="site_post", channel="hosted_site",
                due_at=sp_captured.published_at + timedelta(days=1), status="captured",
                normalized={"views": 1, "impressions": None, "reach": None, "engagements": None,
                            "clicks": None, "spend": None, "conversions": None},
            )

            result = await list_insights_board(s, org_id=org_id, window="30d", status="pending")

        publication_ids = {r["publication_id"] for r in result["rows"]}
        assert publication_ids == {sp_pending.id, sp_in_progress.id}
        assert sp_captured.id not in publication_ids
    finally:
        await engine.dispose()


# story #3746(유나 v5) — superseded는 목록의 원천(list_insights_board 스냅샷 배치
# 조회)에서 기본 배제한다. 화면 넷이 같은 함수를 부르므로 단일화 지점은 여기 하나뿐
# (화면마다 거르면 「동기화」가 아니라 「갈림」이 된다).
@pytest.mark.anyio
async def test_superseded_snapshot_never_surfaces_as_bucket_data():
    """⭐되돌리면 RED — superseded 배제(`InsightSnapshot.status != "superseded"`)를
    지우면 이 스냅샷이 d1 버킷 데이터로 다시 뜬다."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)
            sp = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-superseded-only", title="Superseded",
                published_at=now - timedelta(days=1),
            )
            # 재발행이 회수한 옛 사이클의 pending 잔존 행 — 이 publication의 유일한
            # 스냅샷이라, 배제가 없으면 이 값이 d1으로 뜬다.
            await _seed_snapshot(
                s, org_id=org_id, work_item_id=story_id, publication_id=sp.id,
                publication_kind="site_post", channel="hosted_site",
                due_at=sp.published_at + timedelta(days=1), status="superseded",
            )

            result = await list_insights_board(s, org_id=org_id, window="30d")

        row = next(r for r in result["rows"] if r["publication_id"] == sp.id)
        # 배제가 서 있으면 후보 자체가 없어 "미스케줄"(None)로 떨어진다 — superseded
        # 행의 존재가 d1에 어떤 형태로도 새지 않는다.
        assert row["d1"] is None
    finally:
        await engine.dispose()


# story #3746(유나 v5, 정밀 근인) — label_snapshot_offset이 round(초/86400)라 ±12시간이
# 같은 정수로 접힌다. 재발행 앵커가 12시간 미만 움직이면 옛 사이클 행(재발행 자가회수로
# superseded)과 새 행이 둘 다 "1d"로 라벨될 수 있다 — 배제가 있으면 옛 행이 애초에
# 후보에서 빠져 새 행이 결정적으로 그 칸을 차지한다(DB 반환 순서 무관).
@pytest.mark.anyio
async def test_narrow_window_republish_collision_prefers_fresh_over_superseded():
    """⭐되돌리면 RED — superseded 배제를 지우면 이 표본에서 d1 값이 옛 행(정지된
    값)과 새 행(진짜 값) 사이에서 DB 반환 순서에 좌우돼 비결정적이 된다."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)
            # 재발행 뒤 최신 published_at.
            published_at = now - timedelta(days=2)
            sp = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-republished", title="Republished",
                published_at=published_at,
            )
            # 옛 사이클(재발행 前 anchor) 잔존 행 — due_at이 새 published_at 기준
            # +23시간(반올림하면 "1d")인데, superseded로 회수됐다(옛 사이클 값이라
            # 신뢰할 수 없다 — 여기 정규화값은 "틀린" 표본값 999로 표시해 혼입 시 바로
            # 드러나게 한다).
            await _seed_snapshot(
                s, org_id=org_id, work_item_id=story_id, publication_id=sp.id,
                publication_kind="site_post", channel="hosted_site",
                due_at=published_at + timedelta(hours=23), status="superseded",
                normalized={"views": 999, "impressions": None, "reach": None, "engagements": None,
                            "clicks": None, "spend": None, "conversions": None},
            )
            # 새 사이클(재발행 後) 행 — due_at이 +25시간(반올림해도 "1d", 옛 행과 같은
            # 라벨) — 이 값이 진짜다.
            await _seed_snapshot(
                s, org_id=org_id, work_item_id=story_id, publication_id=sp.id,
                publication_kind="site_post", channel="hosted_site",
                due_at=published_at + timedelta(hours=25), status="captured",
                normalized={"views": 7, "impressions": None, "reach": None, "engagements": None,
                            "clicks": None, "spend": None, "conversions": None},
            )

            result = await list_insights_board(s, org_id=org_id, window="30d")

        row = next(r for r in result["rows"] if r["publication_id"] == sp.id)
        assert row["d1"] is not None
        assert row["d1"]["status"] == "captured"
        assert row["d1"]["normalized"]["views"] == 7, "옛(superseded) 행의 값 999가 새 값을 덮으면 안 된다"
    finally:
        await engine.dispose()


# story #3746(3734 §4-C, 유나 실측) — SitePost 유니크는 (org_id, lang, slug)라
# work_item_id가 없다 — 초안 하나가 여러 lang의 발행 행에 걸린다. 그 초안 보관 하나가
# 언어별 발행 행 N개를 한꺼번에 숨긴다 — hidden_count가 그 N을 낸다.
@pytest.mark.anyio
async def test_hidden_count_counts_all_lang_rows_hidden_by_one_archived_draft():
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)
            # 원 초안 1개 — 보관됨.
            await _seed_site_post_draft(
                s, org_id=org_id, work_item_id=story_id, slug="multi-lang-post", deleted_at=now,
            )
            # 같은 초안에서 파생된 언어별 발행 행 2개(ko·en) — SitePost 유니크가
            # (org_id, lang, slug)라 같은 work_item_id·slug로 둘 다 만들 수 있다.
            sp_ko = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="multi-lang-post", lang="ko",
                title="다국어 글", published_at=now - timedelta(days=1),
            )
            sp_en = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="multi-lang-post", lang="en",
                title="Multi-lang post", published_at=now - timedelta(days=1),
            )

            result = await list_insights_board(s, org_id=org_id, window="30d")

        assert result["rows"] == []  # 기본 뷰 — 보관돼 둘 다 안 보인다.
        assert result["hidden_count"] == 2, f"ko·en 두 행이 한 초안 보관으로 숨었다 — {sp_ko.id}, {sp_en.id}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_hidden_count_null_when_include_deleted_true():
    """include_deleted=True(「보관됨 보기」 켠 뷰)에서는 이미 다 보이므로 hidden_count가
    null이다 — 0으로 지어내지 않는다(그 값 자체가 무의미한 축)."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)
            await _seed_site_post_draft(
                s, org_id=org_id, work_item_id=story_id, slug="hidden-in-both", deleted_at=now,
            )
            await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="hidden-in-both", title="글",
                published_at=now - timedelta(days=1),
            )

            result = await list_insights_board(s, org_id=org_id, window="30d", include_deleted=True)

        assert result["hidden_count"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_hidden_count_zero_when_nothing_archived():
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            story_id = await _seed_story(s, org_id, project_id)
            now = datetime.now(timezone.utc)
            await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="not-archived", title="글",
                published_at=now - timedelta(days=1),
            )

            result = await list_insights_board(s, org_id=org_id, window="30d")

        assert result["hidden_count"] == 0
    finally:
        await engine.dispose()


# story #3583(Phase2·마케팅운영, 페드루 PO 確定 2026-09-10) — 성과 보드 셀이 GA4 유입
# 지표(inflow_sessions·inflow_users) null의 원인을 「지표 키 이름」만으로 «GA4 미연결»로
# 단정하던 결함. 실제로는 연결이 살아 있어도(GA4 처리 지연·해당 창 유입 0·일시
# OAuthError) null일 수 있다(_fetch_ga4_inflow_metrics, insight_snapshots.py:~915 —
# `if inflow and …`) — 원인은 「연결 상태」가 정한다. 진리표 4행(GA4Connection 행 없음·
# property_pending·needs_reauth·connected) — 뮤테이션 대상: _derive_board_ga4_
# connection_status를 「행 존재 여부만」으로 되돌리면(connected/needs_reauth 구별 소실)
# 아래 needs_reauth·connected 행 2건이 RED여야 한다.
async def _seed_ga4_connection(session, *, org_id, status, property_id="properties/123"):
    from app.models.ga4_connection import GA4Connection

    conn = GA4Connection(
        id=uuid.uuid4(), org_id=org_id,
        encrypted_access_token="enc-access-token", encrypted_refresh_token="enc-refresh-token",
        property_id=property_id if status == "connected" else None,
        status=status,
    )
    session.add(conn)
    await session.commit()
    return conn


@pytest.mark.anyio
async def test_ga4_connection_status_not_connected_when_no_row():
    """행1 — GA4Connection 행 자체가 없음(연결한 적 없음) → not_connected."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            result = await list_insights_board(s, org_id=org_id, window="30d")

        assert result["ga4_connection_status"] == "not_connected"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ga4_connection_status_not_connected_when_property_pending():
    """행2 — 토큰만 있고 속성 미선택(콜백 직후) → not_connected(fetch 자체가 안 됨)."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_ga4_connection(s, org_id=org_id, status="property_pending")

            result = await list_insights_board(s, org_id=org_id, window="30d")

        assert result["ga4_connection_status"] == "not_connected"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ga4_connection_status_needs_reauth():
    """행3 — 사람이 다시 연결해야 풀림 → needs_reauth(연결 자체는 있었다)."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_ga4_connection(s, org_id=org_id, status="needs_reauth")

            result = await list_insights_board(s, org_id=org_id, window="30d")

        assert result["ga4_connection_status"] == "needs_reauth"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ga4_connection_status_connected():
    """행4 — 토큰+property 둘 다 있음 → connected(이 상태의 inflow null은 "집계 대기")."""
    from app.services.insights_board import list_insights_board

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_ga4_connection(s, org_id=org_id, status="connected")

            result = await list_insights_board(s, org_id=org_id, window="30d")

        assert result["ga4_connection_status"] == "connected"
    finally:
        await engine.dispose()
