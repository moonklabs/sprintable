"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각③c) — 외부 목적지
(WordPress 등) 발행 오케스트레이션. site_post 승인이 publication_command를 자동
생성하고(gate_service.py 훅 확장), 워커(`process_due_publication_commands`)가
`content_kind="site_post"` 커맨드를 blog_destinations 디스패치로 처리한다.

이 파일의 승인 경로는 cfc1a55a(#3443) 선례와 동형으로 `gate_service.py::
transition_gate()`를 직접 호출한다(`_approve_gate_directly` 우회는 훅을 안 태운다).

AC7 "실왕복" — `httpx.MockTransport`가 아니라 `dev_wordpress_stub.py`/`dev_webhook_
stub.py`를 실 uvicorn 서버로 띄워(진짜 소켓) 각 publish 모듈이 그 서버에 진짜 HTTP를
치는지 증명한다(페드루 明示 — MockTransport는 AC7이 아니다). webhook 쪽은 스텁 자신이
서명을 실제로 재계산해 검증하고 nonce를 실 DB에 남긴다(AC4 明示, wordpress 스텁의
"헤더 존재만 확인"보다 한 단계 더)."""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone

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


@pytest.fixture
async def live_wordpress_stub(monkeypatch):
    """dev_wordpress_stub.router만 얹은 최소 FastAPI 앱을 실 uvicorn 서버(127.0.0.1,
    임시 포트)로, 테스트 이벤트 루프와 별도인 **백그라운드 스레드**(자기 자신의 asyncio
    루프)에서 띄운다 — 메인 앱(app.main.app)의 lifespan/DB 설정과 완전히 격리되고,
    테스트의 무거운 DB 세션 활동과 같은 루프를 공유하지 않아(공유 루프 기아 방지)
    진짜 소켓으로 왕복한다(MockTransport 아님).

    라우터의 실제 마운트 경로(`/api/dev/wordpress-stub/wp-json/wp/v2`, app/main.py가
    실 배포에서 등재하는 그 경로 그대로 — 페드루 확定 예시)를 이 테스트 전용 앱에도
    그대로 유지한다(스텁 코드 자체는 무변경) — 그래서 `site_url`은 origin이 아니라
    `{origin}/api/dev/wordpress-stub`(wordpress_publish.py가 여기 뒤에 `/wp-json/wp/v2/
    posts`를 붙인다)."""
    import threading

    import uvicorn
    from fastapi import FastAPI

    from app.routers.dev_wordpress_stub import _POSTS, router as stub_router

    # 페드루 리뷰 B1(2026-09-04) — loopback HTTPS 예외는 이 플래그가 켜졌을 때만 산다
    # (SSRF 방지, wordpress_publish.py 참고). 이 라이브 스텁 자체가 그 플래그의 유일한
    # 실사용처라 여기서 켠다.
    monkeypatch.setenv("WORDPRESS_TEST_STUB_ENABLED", "true")
    _POSTS.clear()
    stub_app = FastAPI()
    stub_app.include_router(stub_router)
    config = uvicorn.Config(stub_app, host="127.0.0.1", port=0, log_level="warning")
    server = uvicorn.Server(config)

    def _run() -> None:
        asyncio.run(server.serve())

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    for _ in range(500):
        if server.started:
            break
        await asyncio.sleep(0.01)
    else:
        raise RuntimeError("dev_wordpress_stub 라이브 서버가 기동하지 않았습니다")
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}/api/dev/wordpress-stub"
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        _POSTS.clear()


@pytest.fixture
async def live_webhook_stub(monkeypatch):
    """`dev_webhook_stub.py`를 실 uvicorn 서버(백그라운드 스레드)로 띄운다 —
    `live_wordpress_stub`과 같은 사상이지만 이 스텁은 서명 검증·nonce 재전송 거부에
    실 DB가 필요하다(AC4 明示 — wordpress 스텁의 "헤더 존재만 확인"보다 한 단계 더).
    스텁 전용 SQLAlchemy 엔진을 **스레드 안에서** 만든다 — async 엔진/커넥션은
    이벤트루프에 묶여(asyncpg) 테스트 메인 루프와 공유하면 위험하다. 같은 Postgres
    DB(같은 `_REAL_DB_URL`)를 가리키므로 스텁이 쓴 nonce 행을 테스트 쪽 별도 세션으로
    그대로 읽을 수 있다."""
    import threading

    import uvicorn
    from fastapi import FastAPI

    monkeypatch.setenv("WEBHOOK_TEST_STUB_ENABLED", "true")

    server_holder: dict[str, "uvicorn.Server"] = {}
    port_holder: dict[str, int] = {}
    error_holder: dict[str, BaseException] = {}

    def _run() -> None:
        async def _serve() -> None:
            from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

            from app.dependencies.database import get_db
            from app.routers.dev_webhook_stub import router as stub_router

            engine = create_async_engine(_async_url())
            Session = async_sessionmaker(engine, expire_on_commit=False)

            async def _db():
                async with Session() as s:
                    try:
                        yield s
                        await s.commit()
                    except Exception:
                        await s.rollback()
                        raise

            stub_app = FastAPI()
            stub_app.include_router(stub_router)
            stub_app.dependency_overrides[get_db] = _db

            config = uvicorn.Config(stub_app, host="127.0.0.1", port=0, log_level="warning")
            server = uvicorn.Server(config)
            server_holder["server"] = server
            try:
                await server.serve()
            finally:
                await engine.dispose()

        try:
            asyncio.run(_serve())
        except BaseException as exc:  # noqa: BLE001 — 메인 스레드로 기동 실패를 전달.
            error_holder["error"] = exc

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    for _ in range(500):
        if "error" in error_holder:
            raise error_holder["error"]
        server = server_holder.get("server")
        if server is not None and server.started:
            port_holder["port"] = server.servers[0].sockets[0].getsockname()[1]
            break
        await asyncio.sleep(0.01)
    else:
        raise RuntimeError("dev_webhook_stub 라이브 서버가 기동하지 않았습니다")

    try:
        yield f"http://127.0.0.1:{port_holder['port']}/api/dev/webhook-stub"
    finally:
        server_holder["server"].should_exit = True
        thread.join(timeout=5)


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

    org = Organization(id=uuid.uuid4(), name="Site Post Orchestration Test Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="담롱"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_human(session, org_id, *, role="owner"):
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return user.id, om.id


async def _seed_story(session, org_id, project_id, *, title="사이트 포스트"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_default_role(session, org_id):
    from app.models.participation import ParticipationRole

    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
    session.add(role)
    await session.commit()
    return role.id


async def _seed_wordpress_connection(session, org_id, *, site_url, username="editor", app_password="app-pw-abcd-1234"):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel="wordpress", account_id=site_url, account_label=username,
        status="active", credential_kind="pasted_secret", refresh_mode="manual",
        encrypted_access_token=encrypt_channel_credential(app_password),
    )
    session.add(conn)
    await session.commit()
    return conn.id


async def _seed_webhook_connection(session, org_id, *, target_url_builder, secret=None):
    """story e4fc29fa(조각④) — `dev_webhook_stub.py`가 URL 경로(`/deliver/{connection_id}`)
    로 발신 connection을 식별하므로, 이 connection의 `id`를 먼저 확정한 뒤 그 id를
    담은 target_url을 조립해야 한다(`target_url_builder(connection_id) -> str`).
    secret 기본값은 `dev_webhook_stub.py::_DEFAULT_TEST_SECRET`과 동일(스텁이 검증할
    수 있는 유일한 값)."""
    from app.models.channel_connection import ChannelConnection
    from app.routers.dev_webhook_stub import stub_test_secret
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn_id = uuid.uuid4()
    target_url = target_url_builder(conn_id)
    conn = ChannelConnection(
        id=conn_id, org_id=org_id, channel="webhook", account_id=target_url,
        status="active", credential_kind="pasted_secret", refresh_mode="manual",
        encrypted_access_token=encrypt_channel_credential(secret or stub_test_secret()),
    )
    session.add(conn)
    await session.commit()
    return conn.id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_org_scoped_app(app, Session, org_id, *, user_id, agent: bool = False):
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
        claims = {"app_metadata": {"org_id": str(org_id)}}
        if agent:
            claims["app_metadata"]["api_key_id"] = "test-agent-key"
        return AuthContext(user_id=str(user_id), email="caller@test", claims=claims)

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


async def _create_and_submit_site_post_draft(
    client, *, org_id, story_id, connection_id, slug=None,
) -> tuple[uuid.UUID, uuid.UUID]:
    slug = slug or f"post-{uuid.uuid4().hex[:8]}"
    r = await client.post(
        f"/api/v2/organizations/{org_id}/site-posts/drafts",
        json={
            "work_item_id": str(story_id), "title": "제목", "slug": slug, "lang": "ko",
            "summary": "요약", "tags": [], "body_md": "본문", "media_manifest": [],
            "connection_id": str(connection_id),
        },
    )
    assert r.status_code == 201, r.text
    draft_id = uuid.UUID(r.json()["draft_id"])
    r_submit = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={})
    assert r_submit.status_code == 200, r_submit.text
    gate_id = uuid.UUID(r_submit.json()["gate_id"])
    return draft_id, gate_id


@pytest.mark.anyio
async def test_approval_of_blog_destination_gate_auto_creates_site_post_command():
    """훅(gate_service.py) 확장 — wordpress 목적지 site_post 게이트가 approved로
    전이되면 즉시(scheduled_at=None) content_kind="site_post" 커맨드가 생긴다. 뮤테이션
    대상: 훅의 site_post 분기를 지우면 이 assert가 RED."""
    from app.services.gate_service import transition_gate
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_wordpress_connection(s, org_id, site_url="https://customer-blog.example.com")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
            )

        async with Session() as s:
            gate = await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()
            assert gate.status == "approved"

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from app.models.site_post_version import SitePostVersion
            from sqlalchemy import select

            rows = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalars().all()
            assert len(rows) == 1, "승인 즉시 site_post publication_command가 자동 생성되지 않았다"
            cmd = rows[0]
            assert cmd.status == "pending"
            assert cmd.content_kind == "site_post"
            assert cmd.operation == "publish"
            assert cmd.destination == connection_id
            assert cmd.scheduled_at is None
            assert cmd.requested_by_member_id == human_id

            latest_version_id = (await s.execute(
                select(SitePostVersion.id)
                .where(SitePostVersion.draft_id == draft_id)
                .order_by(SitePostVersion.version.desc()).limit(1)
            )).scalar_one()
            assert cmd.approved_version == latest_version_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_approval_of_hosted_site_gate_does_not_create_command():
    """hosted_site(connection_id=None)는 훅이 스킵한다 — 기존 내부 동기 경로 그대로.
    뮤테이션 대상: 이 가드가 없으면 hosted_site 승인마다 불필요한 command가 생긴다."""
    from app.services.gate_service import transition_gate
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(story_id), "title": "제목", "slug": "hosted-post",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문", "media_manifest": [],
                },
            )
            assert r.status_code == 201, r.text
            draft_id = uuid.UUID(r.json()["draft_id"])
            r_submit = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={})
            assert r_submit.status_code == 200, r_submit.text
            gate_id = uuid.UUID(r_submit.json()["gate_id"])

        async with Session() as s:
            gate = await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()
            assert gate.status == "approved"

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select

            rows = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalars().all()
            assert rows == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_endpoint_returns_pending_command_for_external_destination():
    """라우터 분기 — connection_id != None인 draft의 /publish는 200(외부는 새 리소스가
    아니라 커맨드라 201이 아니다)+command_id+status="pending"을 돌려주고 url/
    published_at은 비운다. 실제 발행은 워커 몫(이 테스트는 라우터 분기만 잰다)."""
    from app.services.gate_service import transition_gate
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_wordpress_connection(s, org_id, site_url="https://customer-blog.example.com")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
            )

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=human_user_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["command_id"] is not None
        assert body["status"] == "pending"
        assert body["url"] is None
        assert body["published_at"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_worker_publishes_site_post_command_against_live_wordpress_stub(live_wordpress_stub):
    """AC7 실왕복 — 승인이 만든 command를 워커(process_due_publication_commands)가
    처리하면 wordpress_publish.publish()가 실 uvicorn 서버(dev_wordpress_stub)에 진짜
    HTTP POST를 치고, 그 응답(id/link)이 channel_publications에 그대로 기록된다."""
    from app.services.gate_service import transition_gate
    from app.services.publication_command import process_due_publication_commands
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_wordpress_connection(s, org_id, site_url=live_wordpress_stub)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
            )

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from app.models.channel_publication import ChannelPublication
            from sqlalchemy import select

            cmd = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalar_one()
            assert cmd.status == "completed"

            pub = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_id)
            )).scalar_one()
            assert pub.status == "published"
            assert pub.external_id is not None
            assert pub.permalink is not None and pub.permalink.startswith("https://dev-wordpress-stub.internal/")
            assert pub.connection_id == connection_id
            assert pub.channel == "wordpress"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_worker_unpublish_site_post_command_against_live_wordpress_stub(live_wordpress_stub):
    """AC2 unpublish=status draft 전환 — 발행 뒤 회수 요청도 같은 커맨드 경로를 타고,
    워커가 wordpress_publish.unpublish()로 실 스텁에 status=draft를 친다."""
    from app.services.gate_service import transition_gate
    from app.services.publication_command import process_due_publication_commands
    from app.services.site_posts import request_site_post_external_unpublish
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_wordpress_connection(s, org_id, site_url=live_wordpress_stub)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
            )

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with Session() as s:
            await request_site_post_external_unpublish(
                s, org_id=org_id, draft_id=draft_id, requested_by_member_id=human_id,
            )

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with Session() as s:
            from app.models.channel_publication import ChannelPublication
            from sqlalchemy import select

            pub = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_id)
            )).scalar_one()
            assert pub.status == "unpublished"

        from app.routers.dev_wordpress_stub import _POSTS
        stub_row = _POSTS[int(pub.external_id)]
        assert stub_row["status"] == "draft"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_worker_publish_second_draft_same_connection_does_not_overwrite_first(live_wordpress_stub):
    """카디르·PO 실물 확認(2026-09-04, PR#3797 블로커) — 같은 WordPress connection에
    글이 둘(draft A·B)이면, 수정 전 코드는 connection_id로만 좁힌 조회가 "가장 최근
    published"를 A/B 구분 없이 집어 B 첫 발행이 A의 external_id를 prior로 잡아
    WordPress update 경로를 태워 A를 B 내용으로 덮어썼다. 이 테스트는 그 회귀를
    고정한다 — B 첫 발행은 항상 create(신규 post_id)여야 하고, A의 publication
    행·스텁 원장 둘 다 무변(양성대조: A 자신의 값이 그대로 남는다)."""
    from app.services.gate_service import transition_gate
    from app.services.publication_command import process_due_publication_commands
    from app.models.channel_publication import ChannelPublication
    from app.routers.dev_wordpress_stub import _POSTS
    from app.main import app
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_a = await _seed_story(s, org_id, project_id, title="A")
            story_b = await _seed_story(s, org_id, project_id, title="B")
            connection_id = await _seed_wordpress_connection(s, org_id, site_url=live_wordpress_stub)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_a, gate_a = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_a, connection_id=connection_id, slug="post-a",
            )
        async with Session() as s:
            await transition_gate(s, org_id, gate_a, "approved", resolver_id=human_id)
            await s.commit()
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with Session() as s:
            pub_a_before = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_a)
            )).scalar_one()
            a_external_id, a_permalink = pub_a_before.external_id, pub_a_before.permalink
        assert a_external_id is not None

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_b, gate_b = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_b, connection_id=connection_id, slug="post-b",
            )
        async with Session() as s:
            await transition_gate(s, org_id, gate_b, "approved", resolver_id=human_id)
            await s.commit()
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with Session() as s:
            pub_b = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_b)
            )).scalar_one()
            pub_a_after = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_a)
            )).scalar_one()

        # B는 A와 별개의 post(신규 create) — prior_external_id를 A에서 잘못 물려받지 않았다.
        assert pub_b.external_id is not None
        assert pub_b.external_id != a_external_id
        # A 자신의 행은 B 발행 뒤에도 그대로(양성대조).
        assert pub_a_after.external_id == a_external_id
        assert pub_a_after.permalink == a_permalink
        # 스텁 원장(진짜 HTTP 왕복 결과) 레벨에서도 A가 B 내용으로 덮이지 않았다.
        assert _POSTS[int(a_external_id)]["slug"] == "post-a"
        assert _POSTS[int(pub_b.external_id)]["slug"] == "post-b"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_worker_unpublish_first_draft_same_connection_does_not_touch_second(live_wordpress_stub):
    """카디르·PO 실물 확認(2026-09-04, PR#3797 블로커) — 같은 connection에 글이
    둘(A·B) 발행된 상태에서 A 회수 요청이, 수정 전 코드는 connection_id로만 좁힌
    "가장 최근 published"를 집어 더 최근인 B를 회수해 버렸다. 이 테스트는 그 회귀를
    고정한다 — A 회수는 A 자신의 publication 행만 unpublished로 바꾸고, B는
    published로 그대로 남는다(양성대조)."""
    from app.services.gate_service import transition_gate
    from app.services.publication_command import process_due_publication_commands
    from app.services.site_posts import request_site_post_external_unpublish
    from app.models.channel_publication import ChannelPublication
    from app.main import app
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_a = await _seed_story(s, org_id, project_id, title="A")
            story_b = await _seed_story(s, org_id, project_id, title="B")
            connection_id = await _seed_wordpress_connection(s, org_id, site_url=live_wordpress_stub)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_a, gate_a = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_a, connection_id=connection_id, slug="post-a",
            )
        async with Session() as s:
            await transition_gate(s, org_id, gate_a, "approved", resolver_id=human_id)
            await s.commit()
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        # B가 A보다 나중에 발행돼야 "가장 최근 published"가 B가 되는(수정 전 버그 재현
        # 조건)을 확실히 만든다.
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_b, gate_b = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_b, connection_id=connection_id, slug="post-b",
            )
        async with Session() as s:
            await transition_gate(s, org_id, gate_b, "approved", resolver_id=human_id)
            await s.commit()
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with Session() as s:
            await request_site_post_external_unpublish(
                s, org_id=org_id, draft_id=draft_a, requested_by_member_id=human_id,
            )
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with Session() as s:
            pub_a = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_a)
            )).scalar_one()
            pub_b = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_b)
            )).scalar_one()

        assert pub_a.status == "unpublished"
        assert pub_b.status == "published"  # 양성대조 — B는 A 회수에 건드려지지 않는다.
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_worker_publishes_webhook_site_post_command_against_live_stub(live_webhook_stub):
    """story e4fc29fa(조각④) AC7 실왕복 — 승인이 만든 site_post 커맨드를 워커가
    처리하면 webhook_publish.publish()가 실 uvicorn 서버(dev_webhook_stub)에 서명된
    POST를 진짜로 치고, 스텁이 서명을 실제로 검증한 뒤(진짜 DB로) 응답한 external_id
    가 channel_publications에 그대로 기록된다."""
    from app.services.gate_service import transition_gate
    from app.services.publication_command import process_due_publication_commands
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_webhook_connection(
                s, org_id, target_url_builder=lambda cid: f"{live_webhook_stub}/deliver/{cid}",
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
            )

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with Session() as s:
            from app.models.channel_publication import ChannelPublication
            from sqlalchemy import select

            pub = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_id)
            )).scalar_one()
            assert pub.status == "published"
            assert pub.external_id is not None
            assert pub.external_id.startswith("webhook-")
            assert pub.connection_id == connection_id
            assert pub.channel == "webhook"

            from app.models.webhook_delivery_nonce import WebhookDeliveryNonce

            nonce_rows = (await s.execute(
                select(WebhookDeliveryNonce).where(WebhookDeliveryNonce.connection_id == connection_id)
            )).scalars().all()
            assert len(nonce_rows) == 1, "스텁이 서명 검증을 통과한 뒤 nonce를 실제로 기록해야 한다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_worker_publish_webhook_wrong_secret_is_rejected_by_live_stub(live_webhook_stub):
    """story e4fc29fa(조각④) — 스텁의 서명 검증이 「진짜」임을 증명: 다른 비밀로 서명된
    요청은 401로 거부되고, 워커는 이를 CHANNEL_PUBLISH_AUTH_REJECTED(connection kind)
    로 분류해 즉시 blocked로 보낸다(잘못된 자격은 백오프 재시도로 못 고친다 — 사람의
    재연결이 필요하다는 뜻, site_posts.py::_blog_publish_error_code). 뮤테이션 대상:
    스텁이 서명을 실제로 검증하지 않으면(존재만 확인) 이 테스트가 실패를 못 만들어
    RED가 안 된다."""
    from app.services.gate_service import transition_gate
    from app.services.publication_command import process_due_publication_commands
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_webhook_connection(
                s, org_id, target_url_builder=lambda cid: f"{live_webhook_stub}/deliver/{cid}",
                secret="wrong-secret-not-matching-stub",
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id,
            )

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["blocked"] == 1, counts

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select

            cmd = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalar_one()
            assert cmd.status == "blocked"
            assert cmd.failure_kind == "connection"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_worker_publish_webhook_replay_rejected_by_live_stub(live_webhook_stub):
    """story e4fc29fa(조각④) AC3 — 재전송(같은 nonce) 거부를 증명: 같은 승인 커맨드를
    워커가 두 번 실행하면(정상 운영에선 안 나는 상황이지만, 스텁의 재전송 방어 자체를
    직접 검증하려고 커맨드를 강제로 pending에 되돌려 재실행) 두 번째 시도는 스텁이
    새 nonce를 발급해 보내므로(webhook_publish.py가 매 호출마다 uuid4 nonce를 새로
    만든다) 사실 이 경로로는 재전송을 재현 못 한다 — 대신 스텁에 같은 nonce로 직접
    2회 POST해 409를 증명한다(발신측 재시도 로직과 무관하게 스텁 자신의 방어를 잰다)."""
    import hashlib
    import hmac
    import time

    import httpx

    from app.routers.dev_webhook_stub import stub_test_secret

    # 이 테스트는 org/story 등을 안 만들지만, `webhook_delivery_nonces` 테이블은
    # 있어야 한다 — destructive_schema 마커의 autouse 리셋(tests/conftest.py)이 매
    # 테스트 시작 전 스키마를 통째로 비우므로, 이 파일의 다른 테스트가 먼저 스키마를
    # 만들어 뒀다는 보장이 없다(테스트는 서로 독립이어야 한다).
    engine, _Session = await _session_factory()
    try:
        connection_id = uuid.uuid4()
        body = b'{"event":"publish","slug":"replay-test"}'
        secret = stub_test_secret()
        signature = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        # story e4fc29fa(조각④, 페드루 리뷰 B2) — timestamp 창(300s) 신설 뒤로는 지금
        # 시각이어야 이 재전송 시나리오 자체가 통과선을 넘는다(창 자체는 별도 테스트가
        # 잰다).
        headers = {
            "X-Sprintable-Signature": signature, "X-Sprintable-Timestamp": str(int(time.time())),
            "X-Sprintable-Nonce": "fixed-nonce-for-replay-test", "Content-Type": "application/json",
        }

        async with httpx.AsyncClient() as client:
            r1 = await client.post(f"{live_webhook_stub}/deliver/{connection_id}", content=body, headers=headers)
            assert r1.status_code == 200, r1.text
            r2 = await client.post(f"{live_webhook_stub}/deliver/{connection_id}", content=body, headers=headers)
            assert r2.status_code == 409, r2.text
            assert r2.json()["detail"]["code"] == "replay_rejected"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_webhook_stub_rejects_timestamp_outside_window(live_webhook_stub):
    """story e4fc29fa(조각④, 페드루 리뷰 B2) — 정본 §4 "timestamp 창" 明示. 서명
    자체는 유효해도 timestamp가 지금과 300s 넘게 벌어져 있으면 401(timestamp_out_of_
    window)로 거부한다. 뮤테이션 대상: 이 창 검사를 지우면(존재만 확인하던 이전
    구현) 유출된 서명된 요청이 시간 무관하게 영원히 재생 가능해진다."""
    import hashlib
    import hmac

    import httpx

    from app.routers.dev_webhook_stub import stub_test_secret

    connection_id = uuid.uuid4()
    body = b'{"event":"publish","slug":"stale-timestamp-test"}'
    secret = stub_test_secret()
    signature = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    stale_timestamp = "1700000000"  # 2023년 — 지금 시각과 300s를 훌쩍 넘게 벌어져 있다.
    headers = {
        "X-Sprintable-Signature": signature, "X-Sprintable-Timestamp": stale_timestamp,
        "X-Sprintable-Nonce": "nonce-for-stale-timestamp-test", "Content-Type": "application/json",
    }

    async with httpx.AsyncClient() as client:
        r = await client.post(f"{live_webhook_stub}/deliver/{connection_id}", content=body, headers=headers)
    assert r.status_code == 401, r.text
    assert r.json()["detail"]["code"] == "timestamp_out_of_window"
