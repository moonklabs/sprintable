"""story #3528(BE·Phase2, 페드루 PO 確定 2026-09-06) — 댓글 「지속 폴링」. due 3창
(+1h·+1d·+7d, story #3516·#3527) 뒤에도 활성 게시물(published_at 14일 이내 AND
(댓글 0건이거나 마지막 댓글 7일 이내))은 30분 주기로 자기재생성한다. transient
(429/5xx) 실패는 `next_attempt_at`(마이그 0341) 백오프로 지연. org당 상한 200
(초과분은 재생성 0).

세팅 헬퍼는 test_3516_channel_post_comments.py·test_3497_insight_snapshots.py와
동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory
from tests.test_3497_insight_snapshots import _seed_channel_connection, _seed_channel_publication

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
    """test_3516_channel_post_comments.py와 동형 — supports_fetch_replies=True로 등재."""
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


async def _seed_due_schedule_row(session, *, org_id, publication_id, channel="sandbox", external_id="media-1", due_at=None):
    from app.models.channel_post_comment import CommentCollectionSchedule

    row = CommentCollectionSchedule(
        id=uuid.uuid4(), org_id=org_id, publication_id=publication_id, channel=channel,
        external_id=external_id, due_at=due_at or (datetime.now(timezone.utc) - timedelta(minutes=1)),
        status="pending",
    )
    session.add(row)
    await session.commit()
    return row.id


# ─── 활성 판정 자체(_is_publication_active) ──────────────────────────────────


@pytest.mark.anyio
async def test_is_publication_active_true_when_recently_published_no_comments():
    from app.services.channel_post_comments import _is_publication_active

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox")
            now = datetime.now(timezone.utc)
            assert await _is_publication_active(s, publication_id=pub.id, now=now) is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_is_publication_active_false_after_14_days_published():
    from app.models.channel_publication import ChannelPublication
    from app.services.channel_post_comments import _is_publication_active

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox")
            now = datetime.now(timezone.utc)
            row = await s.get(ChannelPublication, pub.id)
            row.published_at = now - timedelta(days=15)
            await s.commit()
            assert await _is_publication_active(s, publication_id=pub.id, now=now) is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_is_publication_active_false_when_last_comment_older_than_7_days():
    from app.models.channel_post_comment import ChannelPostComment
    from app.services.channel_post_comments import _is_publication_active

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox")
            now = datetime.now(timezone.utc)
            s.add(ChannelPostComment(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, channel="sandbox",
                external_comment_id="c1", text="옛 댓글", text_sha256="x" * 64,
                external_created_at=now - timedelta(days=8), captured_at=now - timedelta(days=8),
            ))
            await s.commit()
            assert await _is_publication_active(s, publication_id=pub.id, now=now) is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_is_publication_active_true_when_last_comment_within_7_days():
    from app.models.channel_post_comment import ChannelPostComment
    from app.services.channel_post_comments import _is_publication_active

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox")
            now = datetime.now(timezone.utc)
            s.add(ChannelPostComment(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, channel="sandbox",
                external_comment_id="c1", text="최근 댓글", text_sha256="x" * 64,
                external_created_at=now - timedelta(days=3), captured_at=now - timedelta(days=3),
            ))
            await s.commit()
            assert await _is_publication_active(s, publication_id=pub.id, now=now) is True
    finally:
        await engine.dispose()


# ─── 자기재생성(AC1) ──────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_captured_row_regenerates_next_due_row_30_minutes_later_when_active():
    from sqlalchemy import select
    from app.models.channel_post_comment import CommentCollectionSchedule
    from app.services.channel_post_comments import process_due_comment_collections

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")
            await _seed_due_schedule_row(s, org_id=org_id, publication_id=pub.id, external_id="media-1")

            now = datetime.now(timezone.utc)
            counts = await process_due_comment_collections(s, now=now)
            assert counts["captured"] == 1, counts

            rows = (await s.execute(
                select(CommentCollectionSchedule).where(CommentCollectionSchedule.publication_id == pub.id)
            )).scalars().all()
            assert len(rows) == 2, "원 행 1개 + 자기재생성 1개가 있어야 함"
            regenerated = [r for r in rows if r.status == "pending"]
            assert len(regenerated) == 1
            assert abs((regenerated[0].due_at - (now + timedelta(minutes=30))).total_seconds()) < 2
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_captured_row_does_not_regenerate_when_publication_inactive():
    """AC1 — 비활성(발행 14일 초과)이면 재생성 0(자연 소멸)."""
    from sqlalchemy import select
    from app.models.channel_post_comment import CommentCollectionSchedule
    from app.models.channel_publication import ChannelPublication
    from app.services.channel_post_comments import process_due_comment_collections

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")
            now = datetime.now(timezone.utc)
            row = await s.get(ChannelPublication, pub.id)
            row.published_at = now - timedelta(days=20)
            await s.commit()
            await _seed_due_schedule_row(s, org_id=org_id, publication_id=pub.id, external_id="media-1")

            counts = await process_due_comment_collections(s, now=now)
            assert counts["captured"] == 1, counts

            rows = (await s.execute(
                select(CommentCollectionSchedule).where(CommentCollectionSchedule.publication_id == pub.id)
            )).scalars().all()
            assert len(rows) == 1, "비활성이면 재생성 행이 없어야 함"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_regeneration_mutation_check_removing_call_stops_continuous_polling(monkeypatch):
    """뮤테이션 — _schedule_next_continuous_poll_if_active를 no-op으로 바꾸면
    위 자기재생성 테스트가 RED가 돼야 한다."""
    import app.services.channel_post_comments as comments_module

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(comments_module, "_schedule_next_continuous_poll_if_active", _noop)

    from sqlalchemy import select
    from app.models.channel_post_comment import CommentCollectionSchedule

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")
            await _seed_due_schedule_row(s, org_id=org_id, publication_id=pub.id, external_id="media-1")

            await comments_module.process_due_comment_collections(s, now=datetime.now(timezone.utc))

            rows = (await s.execute(
                select(CommentCollectionSchedule).where(CommentCollectionSchedule.publication_id == pub.id)
            )).scalars().all()
            assert len(rows) == 1, "뮤테이션 상태에선 재생성이 없어야(원래 있어야 할 게 없어짐=RED 재현)"
    finally:
        await engine.dispose()


# ─── 백오프(AC2) ──────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_transient_failure_sets_next_attempt_at_backoff_and_tick_respects_it(monkeypatch):
    import app.services.sandbox_publish as sandbox_publish
    from app.services.channel_post_comments import CommentFetchError, process_due_comment_collections
    from app.models.channel_post_comment import CommentCollectionSchedule

    async def _rate_limited(client, *, access_token, media_id):
        raise CommentFetchError(error_code="CHANNEL_RATE_LIMITED", message="429 시뮬레이션")

    monkeypatch.setattr(sandbox_publish, "fetch_replies", _rate_limited)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")
            schedule_id = await _seed_due_schedule_row(s, org_id=org_id, publication_id=pub.id, external_id="media-1")

            now = datetime.now(timezone.utc)
            counts = await process_due_comment_collections(s, now=now)
            assert counts["pending_retry"] == 1, counts

            row = await s.get(CommentCollectionSchedule, schedule_id)
            assert row.status == "pending"
            assert row.attempt_count == 1
            expected_delay = timedelta(minutes=2)  # 2**1
            assert abs((row.next_attempt_at - (now + expected_delay)).total_seconds()) < 2

            # tick이 백오프 전엔 이 행을 안 집는지 — due_at은 이미 지났지만 next_attempt_at
            # 이 미래라 다시 처리되면 안 된다(attempt_count가 그대로여야 함).
            counts_again = await process_due_comment_collections(s, now=now + timedelta(minutes=1))
            assert counts_again["pending_retry"] == 0
            row_again = await s.get(CommentCollectionSchedule, schedule_id)
            assert row_again.attempt_count == 1, "백오프 전인데 다시 집혔다"

            # 백오프 시각을 지나면 다시 집힌다.
            counts_after_backoff = await process_due_comment_collections(s, now=now + expected_delay + timedelta(seconds=1))
            assert counts_after_backoff["pending_retry"] == 1
            row_after = await s.get(CommentCollectionSchedule, schedule_id)
            assert row_after.attempt_count == 2
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_transient_failure_exceeds_5_attempts_marks_failed(monkeypatch):
    import app.services.sandbox_publish as sandbox_publish
    from app.services.channel_post_comments import CommentFetchError, process_due_comment_collections
    from app.models.channel_post_comment import CommentCollectionSchedule

    async def _rate_limited(client, *, access_token, media_id):
        raise CommentFetchError(error_code="CHANNEL_RATE_LIMITED", message="429 시뮬레이션")

    monkeypatch.setattr(sandbox_publish, "fetch_replies", _rate_limited)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")
            schedule_id = await _seed_due_schedule_row(s, org_id=org_id, publication_id=pub.id, external_id="media-1")

            now = datetime.now(timezone.utc)
            for _attempt in range(5):
                row = await s.get(CommentCollectionSchedule, schedule_id)
                row.next_attempt_at = None  # 테스트 편의 — 매 시도마다 즉시 재시도되게.
                await s.commit()
                await process_due_comment_collections(s, now=now)

            row = await s.get(CommentCollectionSchedule, schedule_id)
            assert row.status == "failed"
            assert row.attempt_count == 5
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_backoff_mutation_check_removing_next_attempt_at_lets_immediate_retry(monkeypatch):
    """뮤테이션 — next_attempt_at 계산을 안 하면 백오프 테스트가 RED가 돼야 한다
    (다음 tick이 즉시 다시 집어 attempt_count가 곧바로 늘어남)."""
    import app.services.channel_post_comments as comments_module
    import app.services.sandbox_publish as sandbox_publish
    from app.models.channel_post_comment import CommentCollectionSchedule

    async def _rate_limited(client, *, access_token, media_id):
        raise comments_module.CommentFetchError(error_code="CHANNEL_RATE_LIMITED", message="429 시뮬레이션")

    monkeypatch.setattr(sandbox_publish, "fetch_replies", _rate_limited)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-1")
            schedule_id = await _seed_due_schedule_row(s, org_id=org_id, publication_id=pub.id, external_id="media-1")

            now = datetime.now(timezone.utc)
            await comments_module.process_due_comment_collections(s, now=now)

            from app.models.channel_post_comment import CommentCollectionSchedule as CCS
            row = await s.get(CCS, schedule_id)
            row.next_attempt_at = None  # 뮤테이션 재현 — 백오프가 없었다고 가정.
            await s.commit()

            # 백오프가 없었다면 1분 뒤에도 즉시 재시도돼 attempt_count가 늘어야 한다.
            await comments_module.process_due_comment_collections(s, now=now + timedelta(minutes=1))
            row_again = await s.get(CCS, schedule_id)
            assert row_again.attempt_count == 2, "백오프가 무력화되면 즉시 재시도로 attempt_count가 늘어야(뮤테이션 재현)"
    finally:
        await engine.dispose()


# ─── org 상한(AC3) ────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_org_cap_rank_ignores_publications_on_comment_incapable_channels(monkeypatch):
    """페드루 PO 비차단①(2026-09-06, #3882 리뷰) — 상한 순위 카운트는 댓글 수집을
    지원하는 채널(supports_fetch_replies=True)만 센다. hosted_site(미지원)로 더
    최근에 발행된 게 상한 수만큼 있어도, 그건 이 폴링 자원을 안 쓰니 대상
    publication(sandbox)의 순위를 안 밀어야 한다(상한을 1로 낮춰도 통과)."""
    import app.services.channel_post_comments as comments_module
    from sqlalchemy import select
    from app.models.channel_post_comment import CommentCollectionSchedule
    from app.models.channel_publication import ChannelPublication

    monkeypatch.setattr(comments_module, "_ACTIVE_PUBLICATIONS_ORG_CAP", 1)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            now = datetime.now(timezone.utc)

            for i in range(3):
                newer_hosted_site_pub = await _seed_channel_publication(
                    s, org_id=org_id, connection_id=conn.id, channel="hosted_site", external_id=f"newer-hs-{i}",
                )
                row = await s.get(ChannelPublication, newer_hosted_site_pub.id)
                row.published_at = now - timedelta(hours=1)
                await s.commit()

            target_pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="target",
            )
            target_row = await s.get(ChannelPublication, target_pub.id)
            target_row.published_at = now - timedelta(hours=2)
            await s.commit()

            await _seed_due_schedule_row(s, org_id=org_id, publication_id=target_pub.id, external_id="target")
            counts = await comments_module.process_due_comment_collections(s, now=now)
            assert counts["captured"] == 1, counts

            rows = (await s.execute(
                select(CommentCollectionSchedule).where(CommentCollectionSchedule.publication_id == target_pub.id)
            )).scalars().all()
            assert len(rows) == 2, "hosted_site(댓글 미지원) 발행물은 순위에 안 세야 재생성이 통과함"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_org_cap_200_blocks_regeneration_for_older_publications(monkeypatch):
    """AC3 — org당 상한 200. 이 publication보다 최근에 발행된(14일 활성 창 안)
    publication이 200개 이상이면 재생성 0. 상한을 낮춰(2) 테스트 비용을 줄인다."""
    import app.services.channel_post_comments as comments_module
    from sqlalchemy import select
    from app.models.channel_post_comment import CommentCollectionSchedule
    from app.models.channel_publication import ChannelPublication

    monkeypatch.setattr(comments_module, "_ACTIVE_PUBLICATIONS_ORG_CAP", 2)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")

            now = datetime.now(timezone.utc)
            # 이 publication보다 최근에 발행된 것 2개(상한과 같음) — 대상 publication은
            # 상한 밖(순위 3번째)이 되어야 한다.
            for i in range(2):
                newer_pub = await _seed_channel_publication(
                    s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id=f"newer-{i}",
                )
                row = await s.get(ChannelPublication, newer_pub.id)
                row.published_at = now - timedelta(hours=1)
                await s.commit()

            target_pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="target",
            )
            target_row = await s.get(ChannelPublication, target_pub.id)
            target_row.published_at = now - timedelta(hours=2)  # 더 예전 — 순위 밖.
            await s.commit()

            await _seed_due_schedule_row(s, org_id=org_id, publication_id=target_pub.id, external_id="target")

            counts = await comments_module.process_due_comment_collections(s, now=now)
            assert counts["captured"] == 1, counts

            rows = (await s.execute(
                select(CommentCollectionSchedule).where(CommentCollectionSchedule.publication_id == target_pub.id)
            )).scalars().all()
            assert len(rows) == 1, "org 상한 밖이면 재생성 0이어야 함"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_org_cap_mutation_check_removing_check_lets_over_cap_regenerate(monkeypatch):
    """뮤테이션 — _within_org_continuous_poll_cap을 항상 True로 바꾸면 위 상한
    테스트가 RED가 돼야 한다."""
    import app.services.channel_post_comments as comments_module

    async def _always_true(*args, **kwargs):
        return True

    monkeypatch.setattr(comments_module, "_within_org_continuous_poll_cap", _always_true)
    monkeypatch.setattr(comments_module, "_ACTIVE_PUBLICATIONS_ORG_CAP", 2)

    from sqlalchemy import select
    from app.models.channel_post_comment import CommentCollectionSchedule
    from app.models.channel_publication import ChannelPublication

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            now = datetime.now(timezone.utc)

            for i in range(2):
                newer_pub = await _seed_channel_publication(
                    s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id=f"newer-{i}",
                )
                row = await s.get(ChannelPublication, newer_pub.id)
                row.published_at = now - timedelta(hours=1)
                await s.commit()

            target_pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="target",
            )
            target_row = await s.get(ChannelPublication, target_pub.id)
            target_row.published_at = now - timedelta(hours=2)
            await s.commit()

            await _seed_due_schedule_row(s, org_id=org_id, publication_id=target_pub.id, external_id="target")
            await comments_module.process_due_comment_collections(s, now=now)

            rows = (await s.execute(
                select(CommentCollectionSchedule).where(CommentCollectionSchedule.publication_id == target_pub.id)
            )).scalars().all()
            assert len(rows) == 2, "뮤테이션 상태에선 상한 밖인데도 재생성돼야(원래 막혔어야 할 게 통과=RED 재현)"
    finally:
        await engine.dispose()
