"""story #3527(결함·BE, 페드루 PO 確定 2026-09-06) — `channel_post_comments.py::
process_due_comment_collections`가 만들어진 뒤 어디서도 호출되지 않아(cron.py
어디에도 등록 안 됨) 3516 AC1의 due 3창(+1h·+1d·+7d) 자동 수집이 dev/라이브에서
한 번도 실행된 적이 없었다(수동 refresh만 실제 동작). insight_snapshots와 같은
자리(`/publication-commands` tick)에 피기백해 처방 — 신규 엔드포인트 0.

세팅 헬퍼는 test_3414_publication_command.py(cron tick 테스트 선례)와 동형
(중복 재발명 금지)."""
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


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy import text as sa_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE (runtime_type = 'system-publisher' AND type = 'agent')"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Comment Collection Cron Test Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_channel_publication_with_due_schedule(session, *, org_id, project_id, external_id="sandbox-media-1"):
    """publication + 이미 due(과거 due_at)인 CommentCollectionSchedule 행 1개를
    직접 심는다(schedule_comment_collection의 실제 +1h/+1d/+7d 계산 로직은
    test_3516_channel_post_comments.py가 이미 검증 — 여기선 "tick이 이 행을
    실제로 집어가는가"만 겨눈다)."""
    from app.models.channel_connection import ChannelConnection
    from app.models.channel_publication import ChannelPublication
    from app.models.channel_post_comment import CommentCollectionSchedule
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel="sandbox", account_id=f"acct-{uuid.uuid4().hex[:8]}",
        status="active", credential_kind="none", refresh_mode="manual",
        encrypted_access_token=encrypt_channel_credential("sandbox-token"),
    )
    session.add(conn)
    await session.commit()

    pub = ChannelPublication(
        id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), version_id=uuid.uuid4(), connection_id=conn.id,
        channel="sandbox", external_id=external_id, status="published",
        published_at=datetime.now(timezone.utc) - timedelta(hours=2),
    )
    session.add(pub)
    await session.commit()

    schedule_row = CommentCollectionSchedule(
        id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, channel="sandbox",
        external_id=external_id, due_at=datetime.now(timezone.utc) - timedelta(minutes=5), status="pending",
    )
    session.add(schedule_row)
    await session.commit()
    return pub.id, schedule_row.id


@pytest.mark.anyio
async def test_cron_tick_processes_due_comment_collection_and_upserts_comments(monkeypatch):
    """AC1 — tick 호출 → due 지난 CommentCollectionSchedule 행이 captured로 바뀌고
    sandbox 결정적 댓글 2건이 upsert된다(되돌리면 RED — 뮤테이션은 아래 별도 테스트)."""
    import app.routers.cron as cron_module
    from app.dependencies.database import get_worker_db
    from app.main import app
    from httpx import AsyncClient, ASGITransport
    from sqlalchemy import select
    from app.models.channel_post_comment import ChannelPostComment, CommentCollectionSchedule

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            publication_id, schedule_id = await _seed_channel_publication_with_due_schedule(
                s, org_id=org_id, project_id=project_id,
            )

        async def _worker_db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_worker_db] = _worker_db
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            r = await client.post(
                "/api/v2/internal/cron/publication-commands",
                headers={"Authorization": "Bearer test-cron-secret"},
            )
        assert r.status_code == 200, r.text
        body = r.json()["data"]
        assert body["comment_collections"]["captured"] == 1, body

        async with Session() as s:
            schedule_row = await s.get(CommentCollectionSchedule, schedule_id)
            assert schedule_row.status == "captured"
            comments = (await s.execute(
                select(ChannelPostComment).where(ChannelPostComment.publication_id == publication_id)
            )).scalars().all()
            assert len(comments) == 2, "sandbox 결정적 2건이 upsert돼야 함"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_comment_collection_exception_does_not_corrupt_other_axes_counts(monkeypatch):
    """publication_command.py::test_cron_insight_snapshot_exception_does_not_corrupt_
    publication_command_counts와 동형 — comment_collections 축 예외가 publication_
    commands/insight_snapshots 카운트를 오염시키지 않는다(독립 try 격리 확認)."""
    import app.routers.cron as cron_module
    import app.services.channel_post_comments as comments_module
    from app.dependencies.database import get_worker_db
    from app.main import app
    from httpx import AsyncClient, ASGITransport

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")

    async def _boom(*args, **kwargs):
        raise RuntimeError("comment collection boom(테스트 주입)")

    monkeypatch.setattr(comments_module, "process_due_comment_collections", _boom)

    engine, Session = await _session_factory()
    try:
        async def _worker_db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_worker_db] = _worker_db
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            r = await client.post(
                "/api/v2/internal/cron/publication-commands",
                headers={"Authorization": "Bearer test-cron-secret"},
            )
        assert r.status_code == 200, r.text
        body = r.json()["data"]
        assert body["comment_collections"] == {"error": "unhandled"}
        assert body["completed"] == 0 and body["error"] == 0, (
            "comment_collections 축 예외가 publication_commands 카운트 필드까지 오염시켰다"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
