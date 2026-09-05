"""story #3528 라이브 FAIL(2026-09-06, 카디르 QA 22:15Z·PO 코드 실측 確定) — 「상태
자가회수 부재」. `_schedule_next_continuous_poll_if_active`는 due 행이 captured/
failed로 끝난 뒤(process_due_comment_collections 루프 안)에만 불린다 — 배포 前에
이미 due 3창을 전부 소진해 pending/in_progress 행이 0으로 남아 있던 publication은
씨앗 자체가 없어 재생성 체인이 영영 시작되지 않는다. 이 파일은 그 자가회수 스윕
(`_sweep_orphaned_active_publications_for_self_recovery`)을 검증한다.

세팅 헬퍼는 test_3528_comment_continuous_polling.py·test_3497_insight_snapshots.py
와 동형(중복 재발명 금지)."""
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
    """test_3528_comment_continuous_polling.py와 동형 — supports_fetch_replies=True로 등재."""
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


async def _seed_terminal_schedule_row(session, *, org_id, publication_id, channel="sandbox", external_id="media-1", status="captured", due_at=None):
    """due 3창이 이미 전부 소진된 상태 재현 — captured/failed 등 terminal 상태로만
    남고 pending/in_progress는 0(배포 前 시나리오)."""
    from app.models.channel_post_comment import CommentCollectionSchedule

    row = CommentCollectionSchedule(
        id=uuid.uuid4(), org_id=org_id, publication_id=publication_id, channel=channel,
        external_id=external_id, due_at=due_at or (datetime.now(timezone.utc) - timedelta(days=7)),
        status=status, captured_at=datetime.now(timezone.utc) - timedelta(days=7),
    )
    session.add(row)
    await session.commit()
    return row.id


async def _count_schedule_rows(session, *, publication_id):
    from app.models.channel_post_comment import CommentCollectionSchedule
    from sqlalchemy import select

    return (await session.execute(
        select(CommentCollectionSchedule).where(CommentCollectionSchedule.publication_id == publication_id)
    )).scalars().all()


@pytest.mark.anyio
async def test_orphaned_active_publication_gets_seeded_on_first_tick_and_processed_on_second():
    """배포 前 3창 소진 표본(captured 3행·pending 0) → 틱 1회로 pending 씨앗 1건
    생성(이번 틱 claim에는 안 잡힘, due_at=now가 이번 claim보다 뒤에 커밋됨) →
    다음 틱에 그 씨앗이 수집돼 재생성까지 이어진다."""
    from app.services.channel_post_comments import process_due_comment_collections

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-orphan")
            # published_at을 최근으로(활성 판정 통과) — _seed_channel_publication 기본값이 now()라 그대로 활성.
            for _ in range(3):
                await _seed_terminal_schedule_row(s, org_id=org_id, publication_id=pub.id, external_id="media-orphan")

        now = datetime.now(timezone.utc)
        async with Session() as s:
            counts1 = await process_due_comment_collections(s, now=now)
        assert counts1["self_recovery_seeded"] == 1, counts1
        assert counts1["captured"] == 0, "이번 틱에서 바로 처리되면 안 된다(다음 틱 관찰 계약)"

        async with Session() as s:
            rows = await _count_schedule_rows(s, publication_id=pub.id)
            pending_rows = [r for r in rows if r.status == "pending"]
            assert len(pending_rows) == 1, rows

        # 다음 틱 — 방금 심긴 씨앗이 수집되고, 활성이라 다시 재생성된다.
        async with Session() as s:
            counts2 = await process_due_comment_collections(s, now=now + timedelta(seconds=1))
        assert counts2["captured"] == 1, counts2

        async with Session() as s:
            rows = await _count_schedule_rows(s, publication_id=pub.id)
            pending_rows = [r for r in rows if r.status == "pending"]
            assert len(pending_rows) == 1, "captured 뒤 30분 재생성 씨앗이 남아야 한다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_publication_with_open_row_is_not_reseeded():
    """이미 pending/in_progress 행이 있으면(정상 체인) 스윕이 손대지 않는다(중복 씨앗
    방지). status=in_progress·due_at=과거로 심어 두 축을 동시에 단독 격리한다 —
    status='pending'+과거 due_at을 쓰면 메인 due-claim 루프 자체가 그 행을 정상
    처리·재생성해 버려(스윕과 무관한 정상 경로) has_open_row 축을 못 잡고, 반대로
    due_at을 미래로 두면 freshness가 어차피 걸러내 has_open_row 필터를 지워도
    이 테스트가 안 깨지는 맹점이 생긴다(둘 다 뮤테이션으로 실측 확인됨)."""
    from app.services.channel_post_comments import process_due_comment_collections

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-open")
            from app.models.channel_post_comment import CommentCollectionSchedule
            s.add(CommentCollectionSchedule(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, channel="sandbox",
                external_id="media-open", due_at=datetime.now(timezone.utc) - timedelta(days=1), status="in_progress",
            ))
            await s.commit()

        now = datetime.now(timezone.utc)
        async with Session() as s:
            counts = await process_due_comment_collections(s, now=now)
        assert counts["self_recovery_seeded"] == 0, counts

        async with Session() as s:
            rows = await _count_schedule_rows(s, publication_id=pub.id)
            assert len(rows) == 1, "열려 있는 행이 있는데 씨앗이 추가로 심겼다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_normal_state_sweep_costs_exactly_one_query_and_seeds_zero():
    """페드루 PO REQUIRED(2026-09-06, PR#3900 리뷰) — orphan이 0인 정상 상태(다른
    publication들이 전부 열린 행을 가진 상태)에서 스윕 자체의 비용이 SQL 쿼리
    정확히 1건(0행 반환)이어야 한다. 파이썬 루프에서 publication마다 count·max를
    따로 던지던 이전 구현이면 이 assert가 깨진다(발행물 수만큼 쿼리)."""
    from app.services.channel_post_comments import _sweep_orphaned_active_publications_for_self_recovery
    from app.models.channel_post_comment import CommentCollectionSchedule
    from sqlalchemy import event

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            # 3건 모두 "정상"(열린 pending 행 있음) — 실제 운영에서 매 틱 대다수가 이 상태.
            for i in range(3):
                pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id=f"media-normal-{i}")
                s.add(CommentCollectionSchedule(
                    id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, channel="sandbox",
                    external_id=f"media-normal-{i}", due_at=datetime.now(timezone.utc) + timedelta(minutes=10), status="pending",
                ))
            await s.commit()

        now = datetime.now(timezone.utc)
        query_count = 0

        def _count_queries(*args, **kwargs):
            nonlocal query_count
            query_count += 1

        event.listen(engine.sync_engine, "before_cursor_execute", _count_queries)
        try:
            async with Session() as s:
                seeded = await _sweep_orphaned_active_publications_for_self_recovery(s, now=now)
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", _count_queries)

        assert seeded == 0
        assert query_count == 1, f"정상 상태 스윕 비용은 쿼리 1건이어야 하는데 {query_count}건 실행됨"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_inactive_publication_orphan_is_not_reseeded():
    """비활성(published_at 14일 초과) orphan은 씨앗 0 — 자연 소멸 유지."""
    from app.models.channel_publication import ChannelPublication
    from app.services.channel_post_comments import process_due_comment_collections
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-inactive")
            pub_row = (await s.execute(select(ChannelPublication).where(ChannelPublication.id == pub.id))).scalar_one()
            pub_row.published_at = datetime.now(timezone.utc) - timedelta(days=30)
            await s.commit()
            await _seed_terminal_schedule_row(s, org_id=org_id, publication_id=pub.id, external_id="media-inactive")

        now = datetime.now(timezone.utc)
        async with Session() as s:
            counts = await process_due_comment_collections(s, now=now)
        assert counts["self_recovery_seeded"] == 0, counts

        async with Session() as s:
            rows = await _count_schedule_rows(s, publication_id=pub.id)
            assert len(rows) == 1, "비활성 publication에 씨앗이 잘못 심겼다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_over_org_cap_orphan_is_not_reseeded(monkeypatch):
    """org 상한 밖(published_at 순위 밖) orphan은 씨앗 0."""
    import app.services.channel_post_comments as comments_module
    from app.services.channel_post_comments import process_due_comment_collections

    monkeypatch.setattr(comments_module, "_ACTIVE_PUBLICATIONS_ORG_CAP", 1)

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")

            older_pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-older")
            from app.models.channel_publication import ChannelPublication
            from sqlalchemy import select
            older_row = (await s.execute(select(ChannelPublication).where(ChannelPublication.id == older_pub.id))).scalar_one()
            older_row.published_at = now - timedelta(hours=2)
            await s.commit()
            await _seed_terminal_schedule_row(s, org_id=org_id, publication_id=older_pub.id, external_id="media-older")

            # newer_pub도 terminal 행을 심어 "이 테스트가 검증하려는 축"(상한)만
            # 남긴다 — 안 심으면 newer_pub 자체가 "행 0 orphan"이라 상한 안(0등)
            # 이라서 정상적으로 씨앗을 받는데, 그 사실이 이 테스트의 관심사가 아니다.
            newer_pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-newer")
            newer_row = (await s.execute(select(ChannelPublication).where(ChannelPublication.id == newer_pub.id))).scalar_one()
            newer_row.published_at = now - timedelta(hours=1)
            await s.commit()
            await _seed_terminal_schedule_row(s, org_id=org_id, publication_id=newer_pub.id, external_id="media-newer")

        async with Session() as s:
            counts = await process_due_comment_collections(s, now=now)
        # 상한 1 — newer_pub 하나만 랭크 안(0등)이라 그것만 씨앗을 받고, older_pub
        # (1등, 상한 밖)은 못 받는다.
        assert counts["self_recovery_seeded"] == 1, counts

        async with Session() as s:
            rows = await _count_schedule_rows(s, publication_id=older_pub.id)
            assert len(rows) == 1, "org 상한 밖인데 씨앗이 심겼다"
            newer_rows = await _count_schedule_rows(s, publication_id=newer_pub.id)
            assert any(r.status == "pending" for r in newer_rows), "상한 안인데 씨앗을 못 받았다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_removing_sweep_leaves_orphan_starved_forever():
    """뮤테이션 자가검증 — 스윕 호출 자체를 지우면(실 소스 대입) orphan이 여러 틱을
    돌려도 영원히 pending 0으로 남는다(원래 결함 재현). 원복 후 정상 동작 재확認."""
    import app.services.channel_post_comments as comments_module

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="sandbox", external_id="media-mut")
            await _seed_terminal_schedule_row(s, org_id=org_id, publication_id=pub.id, external_id="media-mut")

        now = datetime.now(timezone.utc)

        async def _noop_sweep(db, *, now):
            return 0

        monkeypatch_target = comments_module._sweep_orphaned_active_publications_for_self_recovery
        comments_module._sweep_orphaned_active_publications_for_self_recovery = _noop_sweep
        try:
            async with Session() as s:
                counts1 = await comments_module.process_due_comment_collections(s, now=now)
            assert counts1["self_recovery_seeded"] == 0
            async with Session() as s:
                counts2 = await comments_module.process_due_comment_collections(s, now=now + timedelta(hours=1))
            assert counts2["self_recovery_seeded"] == 0
            async with Session() as s:
                rows = await _count_schedule_rows(s, publication_id=pub.id)
                assert all(r.status != "pending" for r in rows), "스윕 없이도 pending이 생기면 이 테스트가 틀렸다"
        finally:
            comments_module._sweep_orphaned_active_publications_for_self_recovery = monkeypatch_target
    finally:
        await engine.dispose()
