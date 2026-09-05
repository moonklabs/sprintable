"""story #3516(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 댓글 수집+답변 조각①
(테이블+어댑터 능력+수집 3창+수동 refresh+목록 API+보드 comments_count).

세팅 헬퍼는 test_3497_insight_snapshots.py·test_3475_publishing_metrics.py와 동형
(중복 재발명 금지) — sandbox 어댑터는 fetch_replies를 monkeypatch해 «지금은 있고
다음엔 없다»는 삭제 리컨실 시나리오를 결정적으로 재현한다(sandbox_publish.fetch_
replies 자체는 그라운딩①대로 상태 0 스테이트리스라 이 monkeypatch가 유일한 재현
경로)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_agent, _seed_org, _session_factory
from tests.test_3497_insight_snapshots import _seed_channel_connection, _seed_channel_publication
from tests.test_3475_publishing_metrics import _client_for, _seed_human, _setup_org_scoped_app

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


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


@pytest.fixture(autouse=True)
def _enable_sandbox_adapter(monkeypatch):
    """test_3497_insight_snapshots.py의 dict 직접 주입 선례와 동형 — sandbox는
    SANDBOX_CHANNEL_ENABLED env가 모듈 import 시점에 없으면 CHANNEL_ADAPTERS에 아예
    없다. supports_fetch_replies=True로 등재(그라운딩②)."""
    import app.services.channel_adapters as adapters_mod

    sandbox_config = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish,sandbox_delete,sandbox_manage_replies",
        refresh_mode="manual", display_name="Sandbox", credential_kind="none", max_text_length=500,
        utm_source="sandbox", utm_medium="test", supports_unpublish=True,
        unpublish_required_scope="sandbox_delete",
        image_formats=("image/jpeg", "image/png"), image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=10.0, image_width_min=320, image_width_max=1440,
        image_color_space="sRGB", image_max_count=1,
        insight_metrics=("impressions", "reach", "views", "engagements", "clicks", "spend", "conversions"),
        supports_fetch_replies=True, supports_reply=True, reply_required_scope="sandbox_manage_replies",
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "sandbox", sandbox_config)
    yield


def _fake_comment(comment_id: str, text: str = "댓글") -> dict:
    return {
        "id": comment_id, "text": text, "username": "user1",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# ─── schedule_comment_collection: 3창·멱등 ───────────────────────────────────


@pytest.mark.anyio
async def test_schedule_creates_three_rows_and_is_idempotent_on_same_anchor():
    from app.models.channel_post_comment import CommentCollectionSchedule
    from app.services.channel_post_comments import schedule_comment_collection
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            publication_id = uuid.uuid4()
            anchor = datetime.now(timezone.utc)

            await schedule_comment_collection(
                s, org_id=org_id, publication_id=publication_id, channel="sandbox",
                external_id="media-1", anchor_at=anchor,
            )
            await schedule_comment_collection(
                s, org_id=org_id, publication_id=publication_id, channel="sandbox",
                external_id="media-1", anchor_at=anchor,
            )
            await s.commit()

            rows = (await s.execute(
                select(CommentCollectionSchedule).where(CommentCollectionSchedule.publication_id == publication_id)
            )).scalars().all()
            assert len(rows) == 3, "재처리가 중복 행을 만들었다(멱등 깨짐)"
            due_ats = sorted(r.due_at for r in rows)
            assert due_ats[0] - anchor == timedelta(hours=1)
            assert due_ats[1] - anchor == timedelta(days=1)
            assert due_ats[2] - anchor == timedelta(days=7)
    finally:
        await engine.dispose()


# ─── collect_comments_for_publication: upsert + 소프트 삭제 리컨실 ───────────


@pytest.mark.anyio
async def test_collect_upserts_two_comments_then_reconciles_one_as_deleted(monkeypatch):
    from app.models.channel_post_comment import ChannelPostComment
    from app.services.channel_post_comments import collect_comments_for_publication
    import app.services.sandbox_publish as sandbox_publish
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")

            async def _first_fetch(client, *, access_token, media_id):
                return [_fake_comment("c1", "안녕"), _fake_comment("c2", "반가워요")]

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _first_fetch)
            await collect_comments_for_publication(s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1")
            await s.commit()

            rows = (await s.execute(
                select(ChannelPostComment).where(ChannelPostComment.publication_id == pub.id)
            )).scalars().all()
            assert len(rows) == 2
            assert {r.external_comment_id for r in rows} == {"c1", "c2"}
            assert all(r.deleted_at is None for r in rows)

            # 두 번째 수집 — c2가 사라짐(외부에서 삭제됨을 시뮬레이션).
            async def _second_fetch(client, *, access_token, media_id):
                return [_fake_comment("c1", "안녕")]

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _second_fetch)
            await collect_comments_for_publication(s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1")
            await s.commit()

            rows_after = (await s.execute(
                select(ChannelPostComment).where(ChannelPostComment.publication_id == pub.id)
            )).scalars().all()
            assert len(rows_after) == 2, "소프트 삭제라 행 자체는 남아야 한다(하드 삭제 금지)"
            by_id = {r.external_comment_id: r for r in rows_after}
            assert by_id["c1"].deleted_at is None
            assert by_id["c2"].deleted_at is not None, "provider가 더는 안 주는 댓글은 소프트 삭제로 리컨실돼야 한다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_collect_reappearing_comment_undeletes():
    """소프트 삭제됐던 댓글이 다음 수집에서 다시 보이면 부활한다(그라운딩②의 "재현
    가능" 요구를 실현하는 일반 리컨실 로직의 반대 방향 — provider가 다시 주면 다시
    살아있는 게 맞다, 지어내지 않는다)."""
    import app.services.sandbox_publish as sandbox_publish
    from app.models.channel_post_comment import ChannelPostComment
    from app.services.channel_post_comments import collect_comments_for_publication
    from sqlalchemy import select
    import pytest as _pytest

    engine, Session = await _session_factory()
    monkeypatch = _pytest.MonkeyPatch()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")

            async def _only_c1(client, *, access_token, media_id):
                return [_fake_comment("c1")]

            async def _both(client, *, access_token, media_id):
                return [_fake_comment("c1"), _fake_comment("c2")]

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _both)
            await collect_comments_for_publication(s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1")
            await s.commit()

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _only_c1)
            await collect_comments_for_publication(s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1")
            await s.commit()

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _both)
            await collect_comments_for_publication(s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1")
            await s.commit()

            c2 = (await s.execute(
                select(ChannelPostComment).where(
                    ChannelPostComment.publication_id == pub.id, ChannelPostComment.external_comment_id == "c2",
                )
            )).scalar_one()
            assert c2.deleted_at is None, "다시 보이는 댓글은 부활(un-delete)해야 한다"
    finally:
        monkeypatch.undo()
        await engine.dispose()


@pytest.mark.anyio
async def test_collect_unsupported_channel_raises():
    from app.services.channel_post_comments import CommentCollectionUnsupportedError, collect_comments_for_publication

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            with pytest.raises(CommentCollectionUnsupportedError):
                await collect_comments_for_publication(
                    s, org_id=org_id, publication_id=uuid.uuid4(), channel="wordpress", external_id=None,
                )
    finally:
        await engine.dispose()


# ─── process_due_comment_collections: 워커 SKIP LOCKED ───────────────────────


@pytest.mark.anyio
async def test_process_due_marks_captured_and_ignores_not_yet_due(monkeypatch):
    from app.models.channel_post_comment import CommentCollectionSchedule
    from app.services.channel_post_comments import process_due_comment_collections, schedule_comment_collection
    import app.services.sandbox_publish as sandbox_publish

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")

            anchor = datetime.now(timezone.utc) - timedelta(hours=2)
            await schedule_comment_collection(
                s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1", anchor_at=anchor,
            )
            await s.commit()

            async def _fetch(client, *, access_token, media_id):
                return [_fake_comment("c1")]

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _fetch)
            counts = await process_due_comment_collections(s)
            assert counts["captured"] == 1, "+1h 행은 anchor-2h 기준 이미 due라 잡혀야 한다"

            rows = (await s.execute(
                CommentCollectionSchedule.__table__.select().where(CommentCollectionSchedule.publication_id == pub.id)
            )).mappings().all()
            statuses = {r["status"] for r in rows}
            assert "pending" in statuses, "+1d·+7d 행은 아직 안 됐으니 pending 그대로여야 한다"
            assert "captured" in statuses
    finally:
        await engine.dispose()


# ─── refresh_comments_now: 5분 rate limit ────────────────────────────────────


@pytest.mark.anyio
async def test_refresh_now_rate_limited_within_five_minutes(monkeypatch):
    from app.services.channel_post_comments import CommentRefreshRateLimitedError, refresh_comments_now
    import app.services.sandbox_publish as sandbox_publish

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")

            async def _fetch(client, *, access_token, media_id):
                return [_fake_comment("c1")]

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _fetch)
            first = await refresh_comments_now(s, org_id=org_id, publication_id=pub.id)
            assert first["fetched"] == 1

            with pytest.raises(CommentRefreshRateLimitedError):
                await refresh_comments_now(s, org_id=org_id, publication_id=pub.id)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_now_allowed_again_after_five_minutes(monkeypatch):
    from app.models.channel_post_comment import CommentCollectionSchedule
    from app.services.channel_post_comments import refresh_comments_now
    import app.services.sandbox_publish as sandbox_publish

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")

            async def _fetch(client, *, access_token, media_id):
                return [_fake_comment("c1")]

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _fetch)
            await refresh_comments_now(s, org_id=org_id, publication_id=pub.id)

            # 시간이 6분 지난 것처럼 스케줄 행의 captured_at을 과거로 되돌린다.
            row = (await s.execute(
                CommentCollectionSchedule.__table__.select().where(CommentCollectionSchedule.publication_id == pub.id)
            )).mappings().one()
            await s.execute(
                CommentCollectionSchedule.__table__.update()
                .where(CommentCollectionSchedule.id == row["id"])
                .values(captured_at=datetime.now(timezone.utc) - timedelta(minutes=6))
            )
            await s.commit()

            second = await refresh_comments_now(s, org_id=org_id, publication_id=pub.id)
            assert second["fetched"] == 1
    finally:
        await engine.dispose()


# ─── list_comments_for_publication: null(미수집) ≠ 0(수집됐는데 0건) ─────────


@pytest.mark.anyio
async def test_list_comments_null_before_collection_then_zero_after_empty_collection(monkeypatch):
    from app.services.channel_post_comments import list_comments_for_publication, refresh_comments_now
    import app.services.sandbox_publish as sandbox_publish

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")

            before = await list_comments_for_publication(s, org_id=org_id, publication_id=pub.id)
            assert before["last_collected_at"] is None, "한 번도 수집 안 됐으면 null(미수집)이어야 한다"
            assert before["comments"] == []

            async def _empty_fetch(client, *, access_token, media_id):
                return []

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _empty_fetch)
            await refresh_comments_now(s, org_id=org_id, publication_id=pub.id)

            after = await list_comments_for_publication(s, org_id=org_id, publication_id=pub.id)
            assert after["last_collected_at"] is not None, "수집은 됐으니 0건이어도 시각이 찍혀야 한다(null≠0)"
            assert after["comments"] == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_list_comments_cross_org_publication_raises_not_found():
    from app.services.channel_post_comments import CommentPublicationNotFoundError, list_comments_for_publication

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, _ = await _seed_org(s)
            org_b, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_a, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_a, connection_id=conn.id, channel="sandbox", external_id="media-1")

            with pytest.raises(CommentPublicationNotFoundError):
                await list_comments_for_publication(s, org_id=org_b, publication_id=pub.id)
    finally:
        await engine.dispose()


# ─── count_comments_by_publication_ids: 보드 comments_count 배치 ─────────────


@pytest.mark.anyio
async def test_count_comments_by_publication_ids_excludes_deleted(monkeypatch):
    from app.services.channel_post_comments import collect_comments_for_publication, count_comments_by_publication_ids
    import app.services.sandbox_publish as sandbox_publish

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")

            async def _two(client, *, access_token, media_id):
                return [_fake_comment("c1"), _fake_comment("c2")]

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _two)
            await collect_comments_for_publication(s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1")
            await s.commit()

            async def _one(client, *, access_token, media_id):
                return [_fake_comment("c1")]

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _one)
            await collect_comments_for_publication(s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1")
            await s.commit()

            counts = await count_comments_by_publication_ids(s, publication_ids=[pub.id])
            assert counts[pub.id] == 1, "c2가 소프트 삭제됐으니 살아있는 댓글 1개만 세어야 한다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_count_comments_by_publication_ids_empty_input_returns_empty_dict():
    from app.services.channel_post_comments import count_comments_by_publication_ids

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            result = await count_comments_by_publication_ids(s, publication_ids=[])
            assert result == {}
    finally:
        await engine.dispose()


# ─── API: 목록(에이전트도 가능) vs 재수집(휴먼 전용) ─────────────────────────


@pytest.mark.anyio
async def test_api_list_comments_allows_agent_caller(monkeypatch):
    from app.main import app
    import app.services.sandbox_publish as sandbox_publish
    from app.services.channel_post_comments import refresh_comments_now

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")

            async def _fetch(client, *, access_token, media_id):
                return [_fake_comment("c1")]

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _fetch)
            # story #3516 — 실제 배선처럼 refresh_comments_now를 거쳐야 스케줄 행이
            # status="captured"로 남는다(collect_comments_for_publication 단독 호출은
            # 스케줄 테이블을 안 건드린다 — last_collected_at의 진짜 소스는 항상
            # 이 두 호출부(워커·수동 refresh) 중 하나).
            await refresh_comments_now(s, org_id=org_id, publication_id=pub.id)
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        try:
            async with _client_for(app) as client:
                resp = await client.get(f"/api/v2/organizations/{org_id}/publications/{pub.id}/comments")
                assert resp.status_code == 200, resp.text
                body = resp.json()
                assert len(body["comments"]) == 1
                assert body["last_collected_at"] is not None
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_api_refresh_rejects_agent_caller():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        try:
            async with _client_for(app) as client:
                resp = await client.post(f"/api/v2/organizations/{org_id}/publications/{pub.id}/comments/refresh")
                assert resp.status_code == 403
                assert resp.json()["error"]["code"] == "COMMENT_REFRESH_HUMAN_ONLY"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_api_refresh_allows_human_and_returns_counts(monkeypatch):
    from app.main import app
    import app.services.sandbox_publish as sandbox_publish

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")
            human_id = await _seed_human(s, org_id)

        async def _fetch(client, *, access_token, media_id):
            return [_fake_comment("c1"), _fake_comment("c2")]

        monkeypatch.setattr(sandbox_publish, "fetch_replies", _fetch)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        try:
            async with _client_for(app) as client:
                resp = await client.post(f"/api/v2/organizations/{org_id}/publications/{pub.id}/comments/refresh")
                assert resp.status_code == 200, resp.text
                assert resp.json()["fetched"] == 2

                # 5분 내 재요청 — 429.
                resp2 = await client.post(f"/api/v2/organizations/{org_id}/publications/{pub.id}/comments/refresh")
                assert resp2.status_code == 429
                assert resp2.json()["error"]["code"] == "COMMENT_REFRESH_RATE_LIMITED"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── insights_board.py::comments_count 배선 ──────────────────────────────────


@pytest.mark.anyio
async def test_insights_board_row_carries_comments_count_for_channel_publication_only(monkeypatch):
    from app.services.insights_board import list_insights_board
    from app.services.channel_post_comments import collect_comments_for_publication
    import app.services.sandbox_publish as sandbox_publish
    from app.models.site_post import SitePost
    from tests.test_3471_org_content_rules_lint import _seed_story
    from tests.test_3502_insights_board import _seed_channel_publication as _seed_board_channel_publication
    from tests.test_3502_insights_board import _seed_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            work_item_id = await _seed_story(s, org_id, project_id)
            gate = await _seed_gate(s, org_id=org_id, work_item_id=work_item_id)
            # story #3516 — 보드 UNION의 channel_publication 팔은 Gate→Story INNER JOIN을
            # 요구한다(insights_board.py::_build_union). collect_comments_for_publication
            # 자체는 sandbox 경로에서 ChannelConnection을 안 쓰니(그라운딩①) connection_id는
            # 임의값으로 충분 — 이 테스트의 관심사는 오직 comments_count 배선.
            pub = await _seed_board_channel_publication(
                s, org_id=org_id, gate_id=gate.id, channel="sandbox", published_at=datetime.now(timezone.utc),
            )

            async def _fetch(client, *, access_token, media_id):
                return [_fake_comment("c1")]

            monkeypatch.setattr(sandbox_publish, "fetch_replies", _fetch)
            await collect_comments_for_publication(s, org_id=org_id, publication_id=pub.id, channel="sandbox", external_id="media-1")
            await s.commit()

            site_post = SitePost(
                id=uuid.uuid4(), org_id=org_id, lang="ko", slug="post-x", title="t", summary="s",
                tags=[], body_md="본문", published_at=datetime.now(timezone.utc), source_story_id=uuid.uuid4(),
                gate_id=uuid.uuid4(),
            )
            s.add(site_post)
            await s.commit()

            result = await list_insights_board(s, org_id=org_id, window="30d", channel=None, status=None, sort="published_at", sort_dir="desc", cursor=None, limit=50)
            by_pub = {r["publication_id"]: r for r in result["rows"]}
            assert by_pub[pub.id]["comments_count"] == 1
            assert by_pub[site_post.id]["comments_count"] is None, "site_post는 댓글 개념이 없어 null이어야 한다"
    finally:
        await engine.dispose()
