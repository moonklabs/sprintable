"""story #3497(Phase2·마케팅운영, 페드루 決定 2026-09-05) — 인사이트 수집 잡 + evidence
정규화. 블루프린트 v3 §2(d)·§3 「발행 후 1일·7일 스냅샷·0과 미제공 구분」의 핵심 테스트.

세팅 헬퍼는 test_e4fc29fa_site_post_orchestration.py와 동형(중복 재발명 금지) — 이
스토리의 관심사(스케줄링·정규화·evidence·연결승격)만 직접 서비스 함수 호출로 격리해서
잰다(전체 submit→approve→publish 파이프라인은 다른 파일이 이미 잰다)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import (
    _seed_org,
    _session_factory,
)
from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app, _seed_human

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


async def _seed_site_post(session, *, org_id, work_item_id, lang="ko", slug="post-1"):
    from app.models.site_post import SitePost

    post = SitePost(
        id=uuid.uuid4(), org_id=org_id, lang=lang, slug=slug, title="제목", summary="요약",
        tags=[], body_md="본문", published_at=datetime.now(timezone.utc), source_story_id=work_item_id,
        gate_id=uuid.uuid4(),
    )
    session.add(post)
    await session.commit()
    return post


async def _seed_channel_connection(session, org_id, *, channel="threads", status="active"):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel, account_id=f"acct-{uuid.uuid4().hex[:8]}",
        status=status, credential_kind="oauth", refresh_mode="reissue_from_access_token",
        encrypted_access_token=encrypt_channel_credential("plain-token"),
    )
    session.add(conn)
    await session.commit()
    return conn


async def _seed_channel_publication(session, *, org_id, connection_id, channel, external_id="media-1"):
    from app.models.channel_publication import ChannelPublication

    pub = ChannelPublication(
        id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), version_id=uuid.uuid4(),
        connection_id=connection_id, channel=channel, status="published",
        external_id=external_id, published_at=datetime.now(timezone.utc),
    )
    session.add(pub)
    await session.commit()
    return pub


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
    """test_5b27b32f_sandbox_channel.py의 dict 직접 주입 선례와 동형 — sandbox는
    SANDBOX_CHANNEL_ENABLED env가 모듈 import 시점에 없으면 CHANNEL_ADAPTERS에 아예
    없다(dev 전용 등재). insight_metrics 포함해서 다시 등재한다."""
    import app.services.channel_adapters as adapters_mod

    sandbox_config = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish,sandbox_delete",
        refresh_mode="manual", display_name="Sandbox", credential_kind="none", max_text_length=500,
        utm_source="sandbox", utm_medium="test", supports_unpublish=True,
        unpublish_required_scope="sandbox_delete",
        image_formats=("image/jpeg", "image/png"), image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=10.0, image_width_min=320, image_width_max=1440,
        image_color_space="sRGB", image_max_count=1,
        insight_metrics=("impressions", "reach", "views", "engagements", "clicks", "spend", "conversions"),
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "sandbox", sandbox_config)
    yield


# ─── schedule_insight_snapshots: 멱등 ────────────────────────────────────────


@pytest.mark.anyio
async def test_schedule_creates_two_rows_and_is_idempotent_on_same_anchor():
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            work_item_id = uuid.uuid4()
            publication_id = uuid.uuid4()
            anchor = datetime.now(timezone.utc)

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                publication_kind="site_post", channel="sandbox", external_id=None, anchor_at=anchor,
            )
            # 재처리(같은 앵커) — 멱등, 새 행이 안 는다(페드루 決定①).
            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                publication_kind="site_post", channel="sandbox", external_id=None, anchor_at=anchor,
            )
            await s.commit()

            rows = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == publication_id)
            )).scalars().all()
            assert len(rows) == 2, "재처리가 중복 행을 만들었다(멱등 깨짐)"
            due_ats = sorted(r.due_at for r in rows)
            assert due_ats[0] - anchor == timedelta(days=1)
            assert due_ats[1] - anchor == timedelta(days=7)
    finally:
        await engine.dispose()


# ─── story #3660 — 재발행 자가회수(옛 사이클 pending/in_progress → superseded) ──


@pytest.mark.anyio
async def test_republish_supersedes_old_pending_rows_collector_skips_them():
    """AC1·AC2 — 최초 사이클 2행(pending) → 재발행 → 옛 2행 superseded·새 2행
    pending. 수집기 1틱을 옛 due_at(이미 지남)로 돌려도 superseded는 안 집힌다
    (status=="pending" 필터가 구조적으로 배제 — 뮤테이션은 아래 별도 테스트)."""
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            work_item_id = uuid.uuid4()
            publication_id = uuid.uuid4()
            first_anchor = datetime.now(timezone.utc) - timedelta(days=20)

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                publication_kind="site_post", channel="sandbox", external_id=None, anchor_at=first_anchor,
            )
            await s.commit()

            second_anchor = datetime.now(timezone.utc) - timedelta(days=5)
            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                publication_kind="site_post", channel="sandbox", external_id=None, anchor_at=second_anchor,
            )
            await s.commit()

            rows = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == publication_id)
                .order_by(InsightSnapshot.due_at.asc())
            )).scalars().all()
            assert len(rows) == 4
            statuses = sorted(r.status for r in rows)
            assert statuses == ["pending", "pending", "superseded", "superseded"], statuses

        async with Session() as s:
            # 옛 due_at(20일 전 기준 +1d/+7d)은 이미 지났다 — 수집기가 지금 돌아도
            # superseded 2행은 안 집힌다(둘 다 지금 처리 대상인 새 pending 2행과 due_at이
            # 겹치지 않아 이 tick에선 어차피 due 도래도 아니다, 별도로 재확認).
            counts = await process_due_insight_snapshots(s, now=datetime.now(timezone.utc))
            await s.commit()

        async with Session() as s:
            rows = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == publication_id)
            )).scalars().all()
            superseded_rows = [r for r in rows if r.status == "superseded"]
            assert len(superseded_rows) == 2, "superseded 행이 수집기에 건드려짐"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_republish_mutation_removing_status_pending_filter_lets_superseded_get_collected():
    """뮤테이션 — 수집기 due 쿼리에서 status=="pending" 필터를 빼면(원래 방어가 없어지면)
    superseded 행도 due 도래분으로 집혀 in_progress로 전이된다 — RED 재현."""
    from app.models.insight_snapshot import InsightSnapshot
    from sqlalchemy import select, update

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            snap = InsightSnapshot(
                id=uuid.uuid4(), org_id=org_id, work_item_id=uuid.uuid4(),
                publication_id=uuid.uuid4(), publication_kind="site_post", channel="sandbox",
                due_at=datetime.now(timezone.utc) - timedelta(hours=1), status="superseded",
            )
            s.add(snap)
            await s.commit()
            snap_id = snap.id

            # 원래 코드의 필터(status=="pending")를 뺀 "버그" 쿼리를 직접 재현 — RED.
            buggy_due_rows = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.due_at <= datetime.now(timezone.utc))
            )).scalars().all()
            assert any(r.id == snap_id for r in buggy_due_rows), (
                "뮤테이션이 무력화됨 — status 필터 없는 쿼리가 superseded를 안 집었다"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_republish_same_anchor_retry_leaves_two_rows_no_supersede():
    """PO 確定① 회귀 — 같은 anchor로 재처리(워커 재시도 등)는 due_at이 new_due_ats와
    일치해 supersede WHERE에 안 걸린다. 2행 그대로(4행 아님)."""
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            work_item_id = uuid.uuid4()
            publication_id = uuid.uuid4()
            anchor = datetime.now(timezone.utc)

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                publication_kind="site_post", channel="sandbox", external_id=None, anchor_at=anchor,
            )
            await s.commit()
            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                publication_kind="site_post", channel="sandbox", external_id=None, anchor_at=anchor,
            )
            await s.commit()

            rows = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == publication_id)
            )).scalars().all()
            assert len(rows) == 2, "같은 anchor 재처리가 행을 늘리거나 superseded로 잘못 회수함"
            assert all(r.status == "pending" for r in rows)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_republish_already_captured_old_cycle_row_stays_captured_not_superseded():
    """AC1 — 옛 사이클 행이 이미 captured(재발행 前에 수집 완료)면 재발행이 그 행을
    건드리지 않는다(pending/in_progress만 전이 대상 — 이력 불변)."""
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            work_item_id = uuid.uuid4()
            publication_id = uuid.uuid4()
            first_anchor = datetime.now(timezone.utc) - timedelta(days=20)

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                publication_kind="site_post", channel="sandbox", external_id=None, anchor_at=first_anchor,
            )
            await s.commit()

            captured_due_at = first_anchor + timedelta(days=1)
            row = (await s.execute(
                select(InsightSnapshot).where(
                    InsightSnapshot.publication_id == publication_id, InsightSnapshot.due_at == captured_due_at,
                )
            )).scalar_one()
            row.status = "captured"
            row.captured_at = datetime.now(timezone.utc)
            await s.commit()
            captured_row_id = row.id

            second_anchor = datetime.now(timezone.utc) - timedelta(days=5)
            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                publication_kind="site_post", channel="sandbox", external_id=None, anchor_at=second_anchor,
            )
            await s.commit()

            captured_row = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.id == captured_row_id)
            )).scalar_one()
            assert captured_row.status == "captured", "이미 captured된 이력이 재발행에 덮어써짐"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_finalize_write_race_in_progress_then_superseded_then_capture_attempt_keeps_superseded():
    """페드루 PO CHANGES①(PR #4015, 2026-09-07) — 수집기가 행을 클레임(pending→
    in_progress·commit)한 뒤, 그 사이 같은 publication의 재발행이 그 행을 superseded로
    회수하면, 수집기가 나중에 그 행을 종결(예: captured)하려 해도 그 회수가 유지돼야
    한다(status 되돌림 금지 — 역전 결함, 실측으로 발견·처방됨). `_finalize_snapshot_
    write`를 직접 호출해 그 창을 재현한다."""
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import _finalize_snapshot_write, schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            work_item_id = uuid.uuid4()
            publication_id = uuid.uuid4()
            first_anchor = datetime.now(timezone.utc) - timedelta(days=20)

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                publication_kind="site_post", channel="sandbox", external_id=None, anchor_at=first_anchor,
            )
            await s.commit()

            # 클레임(수집기의 1단계) — pending → in_progress, commit.
            row = (await s.execute(
                select(InsightSnapshot).where(
                    InsightSnapshot.publication_id == publication_id,
                    InsightSnapshot.due_at == first_anchor + timedelta(days=1),
                )
            )).scalar_one()
            row.status = "in_progress"
            await s.commit()
            row_id = row.id

            # 그 사이 재발행 — 이 행을 superseded로 회수(별도 커밋, 클레임과 종결
            # 사이의 창을 그대로 재현).
            second_anchor = datetime.now(timezone.utc) - timedelta(days=5)
            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                publication_kind="site_post", channel="sandbox", external_id=None, anchor_at=second_anchor,
            )
            await s.commit()

            confirm = (await s.execute(
                select(InsightSnapshot.status).where(InsightSnapshot.id == row_id)
            )).scalar_one()
            assert confirm == "superseded", f"사전조건 실패 — 재발행이 회수를 안 함(status={confirm})"

            # 수집기의 2단계(종결) — 이미 detach된 `row` 객체로 captured 시도.
            wrote = await _finalize_snapshot_write(s, row, new_status="captured")
            assert wrote is False, "가드가 뚫려 superseded 뒤에도 종결 쓰기가 성공함"

        async with Session() as s:
            final = (await s.execute(
                select(InsightSnapshot.status).where(InsightSnapshot.id == row_id)
            )).scalar_one()
            assert final == "superseded", f"역전 결함 — captured 시도 뒤 status={final}(superseded 유지돼야)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_unconditional_finalize_write_reverts_superseded_status():
    """뮤테이션 — `_finalize_snapshot_write`의 가드(WHERE status='in_progress')를
    없애고 무조건 UPDATE하면(원래 결함 재현), superseded가 captured로 되돌아간다 —
    RED."""
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import schedule_insight_snapshots
    from sqlalchemy import select, update

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            work_item_id = uuid.uuid4()
            publication_id = uuid.uuid4()
            first_anchor = datetime.now(timezone.utc) - timedelta(days=20)

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                publication_kind="site_post", channel="sandbox", external_id=None, anchor_at=first_anchor,
            )
            await s.commit()

            row = (await s.execute(
                select(InsightSnapshot).where(
                    InsightSnapshot.publication_id == publication_id,
                    InsightSnapshot.due_at == first_anchor + timedelta(days=1),
                )
            )).scalar_one()
            row_id = row.id
            row.status = "in_progress"
            await s.commit()

            second_anchor = datetime.now(timezone.utc) - timedelta(days=5)
            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                publication_kind="site_post", channel="sandbox", external_id=None, anchor_at=second_anchor,
            )
            await s.commit()

            # 원래 결함 재현 — 가드 없는 무조건 UPDATE.
            await s.execute(
                update(InsightSnapshot).where(InsightSnapshot.id == row_id).values(status="captured")
            )
            await s.commit()

            reverted = (await s.execute(
                select(InsightSnapshot.status).where(InsightSnapshot.id == row_id)
            )).scalar_one()
            assert reverted == "captured", "뮤테이션이 무력화됨 — 무조건 UPDATE가 실제로 되돌리지 않음"
    finally:
        await engine.dispose()


# ─── sandbox 전 과정(멱등 등록 → tick → captured → evidence) ──────────────────


@pytest.mark.anyio
async def test_sandbox_end_to_end_captures_all_seven_keys_and_records_evidence():
    from app.models.evidence import Evidence
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import NORMALIZED_KEYS, process_due_insight_snapshots, schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            work_item_id = uuid.uuid4()
            publication_id = uuid.uuid4()
            due_soon = datetime.now(timezone.utc) - timedelta(minutes=1)  # 이미 도래.

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                publication_kind="site_post", channel="sandbox", external_id=None,
                anchor_at=due_soon - timedelta(days=1),  # +1d due_at이 이미 지났게.
            )
            await s.commit()

            counts = await process_due_insight_snapshots(s)
            assert counts["captured"] == 1, counts

            snapshot = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == publication_id)
            )).scalars().first()
            assert snapshot.status == "captured"
            assert snapshot.captured_at is not None
            assert set(snapshot.normalized.keys()) == set(NORMALIZED_KEYS)
            original_seven = ("impressions", "reach", "views", "engagements", "clicks", "spend", "conversions")
            assert all(snapshot.normalized[k] is not None for k in original_seven), "sandbox는 7키 전부 값이 있어야 한다"
            # story #3583-BE — inflow_* 3키는 GA4 연결 축(org 미연결)이라 null이 맞다
            # (이 스냅샷은 publication_kind="site_post"라 애초에 그 축 대상도 아님).
            for key in ("inflow_sessions", "inflow_users", "inflow_conversions"):
                assert snapshot.normalized[key] is None

            evidence = (await s.execute(
                select(Evidence).where(Evidence.ref == str(snapshot.id))
            )).scalar_one()
            assert evidence.type == "metric"
            assert evidence.work_item_id == work_item_id
            assert evidence.created_by is None, "행위자 없는 시스템 기록인데 created_by가 채워졌다(NIL 센티널류 지어냄)"
            assert evidence.payload is not None
            assert evidence.payload["snapshot_id"] == str(snapshot.id)
            assert evidence.payload["source"] == "sandbox"
            assert evidence.payload["recorded_by"] == "platform"
    finally:
        await engine.dispose()


# ─── hosted_site: 0 vs 미제공(척추 축) ────────────────────────────────────────


@pytest.mark.anyio
async def test_hosted_site_views_null_when_no_metering_key_provisioned():
    from app.services.insight_snapshots import _fetch_hosted_site, _normalize

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            post = await _seed_site_post(s, org_id=org_id, work_item_id=uuid.uuid4())

            result = await _fetch_hosted_site(s, org_id=org_id, publication_id=post.id)
            normalized = _normalize(declared_metrics=("views",), values=result["values"])
            assert normalized["views"] is None, "beacon 미도입인데 views가 0으로 지어내졌다"
            assert normalized["impressions"] is None  # hosted_site는 애초에 이 축 미선언.
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_hosted_site_views_zero_when_metering_key_exists_but_no_pageviews():
    from app.models.org_metering_key import OrgMeteringKey
    from app.services.insight_snapshots import _fetch_hosted_site, _normalize

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            post = await _seed_site_post(s, org_id=org_id, work_item_id=uuid.uuid4())
            s.add(OrgMeteringKey(id=uuid.uuid4(), org_id=org_id, public_key="pub-key-1"))
            await s.commit()

            result = await _fetch_hosted_site(s, org_id=org_id, publication_id=post.id)
            normalized = _normalize(declared_metrics=("views",), values=result["values"])
            assert normalized["views"] == 0, "beacon은 있고 집계 0인데 null로 나왔다(0≠미제공 축 붕괴)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_hosted_site_views_reflects_real_pageview_count():
    from app.models.org_metering_key import OrgMeteringKey
    from app.models.org_pageview_daily import OrgPageviewDaily
    from app.services.insight_snapshots import _fetch_hosted_site
    from app.services.site_posts import _blog_post_path

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            post = await _seed_site_post(s, org_id=org_id, work_item_id=uuid.uuid4(), lang="ko", slug="hello")
            s.add(OrgMeteringKey(id=uuid.uuid4(), org_id=org_id, public_key="pub-key-2"))
            s.add(OrgPageviewDaily(
                id=uuid.uuid4(), org_id=org_id, path=_blog_post_path(lang="ko", slug="hello"),
                day=datetime.now(timezone.utc).date(), count=42,
            ))
            await s.commit()

            result = await _fetch_hosted_site(s, org_id=org_id, publication_id=post.id)
            assert result["values"]["views"] == 42
    finally:
        await engine.dispose()


# ─── hosted_site: clicks(story #3506·PO 決定 (e), views와 동형 path 축) ────────


@pytest.mark.anyio
async def test_hosted_site_clicks_null_when_no_metering_key_provisioned():
    """views와 동형 — beacon 자체가 없으면 clicks도 미제공(null), 0으로 지어내지 않는다.
    어댑터 실 선언(views, clicks) 그대로 _normalize에 넣는다(story #3506이 insight_
    metrics를 확장한 실물을 직접 검증)."""
    from app.services.insight_snapshots import _fetch_hosted_site, _normalize

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            post = await _seed_site_post(s, org_id=org_id, work_item_id=uuid.uuid4())

            result = await _fetch_hosted_site(s, org_id=org_id, publication_id=post.id)
            normalized = _normalize(declared_metrics=("views", "clicks"), values=result["values"])
            assert normalized["clicks"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_hosted_site_clicks_zero_when_metering_key_exists_but_no_utm_pageviews():
    from app.models.org_metering_key import OrgMeteringKey
    from app.services.insight_snapshots import _fetch_hosted_site, _normalize

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            post = await _seed_site_post(s, org_id=org_id, work_item_id=uuid.uuid4())
            s.add(OrgMeteringKey(id=uuid.uuid4(), org_id=org_id, public_key="pub-key-clicks-0"))
            await s.commit()

            result = await _fetch_hosted_site(s, org_id=org_id, publication_id=post.id)
            normalized = _normalize(declared_metrics=("views", "clicks"), values=result["values"])
            assert normalized["clicks"] == 0, "beacon은 있고 UTM 집계 0인데 null로 나왔다(0≠미제공 축 붕괴)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_hosted_site_clicks_sums_utm_daily_by_path_ignoring_dimension_values():
    """PO 決定(A) — utm_content 특정값 매칭이 아니라 path 축으로 utm 4필드 중 하나라도
    있던 방문 전부를 합산한다(서로 다른 campaign 2행도 같이 더해진다)."""
    from app.models.org_metering_key import OrgMeteringKey
    from app.models.org_pageview_utm_daily import OrgPageviewUtmDaily
    from app.services.insight_snapshots import _fetch_hosted_site
    from app.services.site_posts import _blog_post_path

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            post = await _seed_site_post(s, org_id=org_id, work_item_id=uuid.uuid4(), lang="ko", slug="utm-clicks")
            path = _blog_post_path(lang="ko", slug="utm-clicks")
            s.add(OrgMeteringKey(id=uuid.uuid4(), org_id=org_id, public_key="pub-key-clicks-sum"))
            s.add(OrgPageviewUtmDaily(
                id=uuid.uuid4(), org_id=org_id, path=path, day=datetime.now(timezone.utc).date(),
                utm_source="twitter", utm_medium="social", utm_campaign="spring", utm_content="draft-1",
                count=5,
            ))
            s.add(OrgPageviewUtmDaily(
                id=uuid.uuid4(), org_id=org_id, path=path, day=datetime.now(timezone.utc).date(),
                utm_source="newsletter", utm_medium="email", utm_campaign="summer", utm_content="draft-2",
                count=3,
            ))
            # 다른 path의 utm 집계는 이 글의 clicks에 안 섞인다.
            s.add(OrgPageviewUtmDaily(
                id=uuid.uuid4(), org_id=org_id, path="/ko/blog/other-post", day=datetime.now(timezone.utc).date(),
                utm_source="twitter", utm_medium="social", utm_campaign="spring", utm_content="draft-3",
                count=100,
            ))
            await s.commit()

            result = await _fetch_hosted_site(s, org_id=org_id, publication_id=post.id)
            assert result["values"]["clicks"] == 8, "path 밖 행이 섞였거나 자기 path 행 일부를 놓쳤다"
            assert len(result["raw"]["utm_breakdown"]) == 2
            assert {b["utm_campaign"] for b in result["raw"]["utm_breakdown"]} == {"spring", "summer"}
    finally:
        await engine.dispose()


# ─── wordpress/webhook: unsupported 즉시(어댑터 미선언) ───────────────────────


@pytest.mark.anyio
async def test_unsupported_channel_marks_immediately_with_zero_adapter_calls(monkeypatch):
    """카디르 QA③ — `raw_payload is None`만으로는 "안 불렀다"를 증명 못 한다(정규화
    실패로 raw만 남고 normalized가 비었을 경우도 같은 모양이 된다). `_fetch_for_snapshot`
    자체를 spy로 감싸 실제 호출 횟수를 잰다 — 양성대조(sandbox=1회 호출)를 같은
    tick 안에 같이 둬서 "이 spy가 원래 호출을 관측할 수는 있다"는 것도 함께 증명한다."""
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    import app.services.insight_snapshots as insight_module
    from sqlalchemy import select

    call_log: list[str] = []
    _original_fetch = insight_module._fetch_for_snapshot

    async def _spy_fetch(db, snapshot):
        call_log.append(snapshot.channel)
        return await _original_fetch(db, snapshot)

    monkeypatch.setattr(insight_module, "_fetch_for_snapshot", _spy_fetch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            work_item_id = uuid.uuid4()
            unsupported_publication_id = uuid.uuid4()
            supported_publication_id = uuid.uuid4()
            anchor = datetime.now(timezone.utc) - timedelta(days=8)

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=unsupported_publication_id,
                publication_kind="channel_publication", channel="wordpress", external_id="post-9",
                anchor_at=anchor,
            )
            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=supported_publication_id,
                publication_kind="site_post", channel="sandbox", external_id=None, anchor_at=anchor,
            )
            await s.commit()

            counts = await process_due_insight_snapshots(s)
            assert counts["unsupported"] == 2, counts  # +1d·+7d 둘 다 이미 도래.
            assert counts["captured"] == 2

            assert call_log.count("wordpress") == 0, (
                f"미지원 채널인데 adapter fetch가 {call_log.count('wordpress')}회 호출됐다(spy 실측)"
            )
            assert call_log.count("sandbox") == 2, "양성대조(sandbox)가 spy에 안 잡혔다 — spy 배선 자체가 무효"

            rows = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == unsupported_publication_id)
            )).scalars().all()
            assert all(r.status == "unsupported" for r in rows)
            assert all(r.raw_payload is None for r in rows), "미지원인데 adapter가 호출된 흔적(raw_payload)이 남았다"
    finally:
        await engine.dispose()


# ─── threads mock: 401→connection 승격, 429→transient 재시도, 200→captured ───


def _patch_threads_transport(monkeypatch, handler) -> None:
    """`httpx.AsyncClient()`(인자 없음, `_fetch_threads_via_connection`이 그대로 호출)가
    이 mock transport로 뜨도록 클래스 자체를 감싼다 — real 토큰 없이 200/401/429/5xx를
    HTTP 레벨에서 흉내(페드루 決定③ "mock까지")."""
    import httpx

    real_async_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)

    class _PatchedAsyncClient(real_async_client):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = transport
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", _PatchedAsyncClient)


@pytest.mark.anyio
async def test_threads_401_promotes_connection_and_marks_snapshot_failed(monkeypatch):
    import httpx

    from app.models.channel_connection import ChannelConnection
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id)
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=connection.id, channel="threads")
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="threads", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()

            _patch_threads_transport(
                monkeypatch, lambda request: httpx.Response(401, json={"error": {"message": "expired"}}),
            )
            counts = await process_due_insight_snapshots(s)

            assert counts["failed"] == 2, counts

            snap = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == pub.id)
            )).scalars().first()
            assert snap.status == "failed"
            assert snap.error_code == "CHANNEL_TOKEN_EXPIRED"

            refreshed_conn = await s.get(ChannelConnection, connection.id)
            assert refreshed_conn.status == "expired", "401이 연결 상태를 승격하지 않았다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_threads_200_captures_views_and_engagements(monkeypatch):
    import httpx

    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id)
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=connection.id, channel="threads")
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="threads", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()

            _patch_threads_transport(monkeypatch, lambda request: httpx.Response(200, json={"data": [
                {"name": "views", "values": [{"value": 120}]},
                {"name": "likes", "values": [{"value": 10}]},
                {"name": "replies", "values": [{"value": 3}]},
            ]}))
            counts = await process_due_insight_snapshots(s)

            assert counts["captured"] == 2, counts
            snap = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == pub.id)
            )).scalars().first()
            assert snap.normalized["views"] == 120
            assert snap.normalized["engagements"] == 13
            assert snap.normalized["impressions"] is None  # threads가 선언 안 한 축.
    finally:
        await engine.dispose()


# ─── 조각3: 조회 API + 카운트 함수 ────────────────────────────────────────────


@pytest.mark.anyio
async def test_insights_list_endpoint_returns_captured_snapshot():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            work_item_id = uuid.uuid4()
            publication_id = uuid.uuid4()

            from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                publication_kind="site_post", channel="sandbox", external_id=None,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()
            await process_due_insight_snapshots(s)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publications/{publication_id}/insights")
        assert r.status_code == 200, r.text
        rows = r.json()
        assert len(rows) == 2, "+1d·+7d 두 행이 스케줄됐어야 한다"
        assert {row["status"] for row in rows} == {"captured"}
        assert all(row["normalized"] is not None for row in rows)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_insights_list_endpoint_empty_list_for_unknown_publication():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publications/{uuid.uuid4()}/insights")
        assert r.status_code == 200, r.text
        assert r.json() == [], "존재하지 않는 publication_id는 404가 아니라 빈 목록(지어내지 않는다)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_insights_list_endpoint_org_mismatch_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            other_org_id = uuid.uuid4()

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{other_org_id}/publications/{uuid.uuid4()}/insights")
        assert r.status_code == 403, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_insights_list_endpoint_offset_label_nulls_out_superseded_snapshots_after_republish():
    """카디르 발견(PR#4003, 2026-09-07) — hosted_site 재발행은 같은 publication_id를
    유지한 채 published_at을 갱신하고 새 due_at 2행을 더 연다(UNIQUE(publication_id,
    due_at)는 «새» due_at을 안 막는다). offset_label은 due_at을 «지금» published_at
    기준으로 재해석해야 한다 — 옛 사이클의 due_at은 더 이상 +1일/+7일 어느 쪽도
    아니게 되어 null, 재발행 사이클의 두 행만 1d/7d로 라벨돼야 한다(인덱스 기반
    라벨링이던 시절은 이 값이 서버에 없었다 — 지금은 소비부가 대신 흉내 낼 필요가
    없다는 것 자체가 이 계약의 요점)."""
    from app.main import app
    from app.models.site_post import SitePost
    from app.services.insight_snapshots import schedule_insight_snapshots

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            work_item_id = uuid.uuid4()

            first_published_at = datetime.now(timezone.utc) - timedelta(days=20)
            post = SitePost(
                id=uuid.uuid4(), org_id=org_id, lang="ko", slug="republish-post", title="제목",
                summary="요약", tags=[], body_md="본문", published_at=first_published_at,
                source_story_id=work_item_id, gate_id=uuid.uuid4(),
            )
            s.add(post)
            await s.commit()

            # 최초 발행 사이클 — 이 두 due_at은 재발행 뒤 더 이상 유효한 1d/7d가 아니다.
            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=post.id,
                publication_kind="site_post", channel="hosted_site", external_id=None,
                anchor_at=first_published_at,
            )
            await s.commit()

            # 재발행 — published_at 갱신 + 새 due_at 2행(다른 anchor_at이라 UNIQUE 충돌 없음).
            republish_at = datetime.now(timezone.utc) - timedelta(days=5)
            post.published_at = republish_at
            await s.commit()
            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=post.id,
                publication_kind="site_post", channel="hosted_site", external_id=None,
                anchor_at=republish_at,
            )
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publications/{post.id}/insights")
        assert r.status_code == 200, r.text
        rows = r.json()
        assert len(rows) == 4, "최초 사이클 2행 + 재발행 사이클 2행"

        by_label: dict[str | None, int] = {}
        for row in rows:
            by_label[row["offset_label"]] = by_label.get(row["offset_label"], 0) + 1
        assert by_label == {None: 2, "1d": 1, "7d": 1}, by_label

        # story #3660 — 최초 사이클의 pending 2행이 재발행으로 superseded 회수됐다(옛
        # pending 스냅샷이 살아서 수집되던 자가회수 부재의 근본 처방).
        by_status: dict[str, int] = {}
        for row in rows:
            by_status[row["status"]] = by_status.get(row["status"], 0) + 1
        assert by_status == {"superseded": 2, "pending": 2}, by_status

        # 카운트만으론 부족 — «어느 사이클»의 due_at이 1d/7d로 라벨됐는지 직접 확認한다
        # (뮤테이션 대상: rows[0].due_at 기준 역산 같은 우회는 이 표본에서 우연히 같은
        # 카운트 분포를 낼 수 있다 — 실제 republish_at 앵커와 정확히 일치해야 한다).
        labeled_by_due_at = {row["due_at"]: row["offset_label"] for row in rows}
        expected_1d_due = (republish_at + timedelta(days=1)).isoformat().replace("+00:00", "Z")
        expected_7d_due = (republish_at + timedelta(days=7)).isoformat().replace("+00:00", "Z")
        matched_1d = [due for due, label in labeled_by_due_at.items() if label == "1d"]
        matched_7d = [due for due, label in labeled_by_due_at.items() if label == "7d"]
        assert len(matched_1d) == 1 and matched_1d[0].startswith(expected_1d_due[:19])
        assert len(matched_7d) == 1 and matched_7d[0].startswith(expected_7d_due[:19])
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_compute_insight_snapshot_counts_tallies_by_status_within_window():
    """확定⑤ — 3475 접합용 카운트 함수(이 PR에선 호출부 미배선, 함수만). created_at
    기준 window 밖 행은 안 세고, pending 행도 안 센다(3종만)."""
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import compute_insight_snapshot_counts

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            work_item_id = uuid.uuid4()

            def _row(status, created_at, publication_id=None):
                return InsightSnapshot(
                    id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id,
                    publication_id=publication_id or uuid.uuid4(), publication_kind="site_post",
                    channel="sandbox", due_at=now, status=status, created_at=created_at,
                )

            s.add_all([
                _row("captured", now - timedelta(days=1)),
                _row("captured", now - timedelta(days=2)),
                _row("failed", now - timedelta(days=3)),
                _row("unsupported", now - timedelta(days=4)),
                _row("pending", now - timedelta(days=1)),  # 3종 밖 — 안 세야 한다.
                _row("captured", now - timedelta(days=9)),  # window(7d) 밖 — 안 세야 한다.
            ])
            await s.commit()

            counts = await compute_insight_snapshot_counts(s, org_id=org_id, window_days=7, now=now)
            assert counts == {"captured": 2, "failed": 1, "unsupported": 1}
    finally:
        await engine.dispose()
