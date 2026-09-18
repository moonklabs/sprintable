"""story 0e960006/#3448(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — 채널 포스트
목록/단건 응답에 `command_id` 노출. 화면의 dead_letter 수동 재시도 버튼(POST
.../publication-commands/{command_id}/retry)이 어느 명령을 재시도할지 알 길이
없었다(command_status/next_retry_at/dead_letter_at만 있고 id가 없음, 샌드박스
라이브 절차 7 발견). additive — `_to_draft_list_item`의 기존 `latest_command`
배치에서 id만 더 꺼낸다(신규 조회 0)."""
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

    org = Organization(id=uuid.uuid4(), name="Command Id Exposure Test Org", slug=f"org-{uuid.uuid4().hex[:8]}")
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
    return user.id


async def _seed_story(session, org_id, project_id, *, title="채널 포스트"):
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


async def _seed_connection(session, org_id, *, channel="threads", account_id=None, token="plain-access-token"):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel,
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", status="active",
        credential_kind="oauth", refresh_mode="reissue_from_access_token",
        encrypted_access_token=encrypt_channel_credential(token),
    )
    session.add(conn)
    await session.commit()
    return conn.id


async def _approve_gate_directly(session, gate_id):
    from app.models.gate import Gate
    from sqlalchemy import select

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    gate.status = "approved"
    gate.resolver_id = uuid.uuid4()
    gate.resolved_at = datetime.now(timezone.utc)
    await session.commit()


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


async def _create_draft_submit_approve(
    client, session, *, org_id, connection_id, story_id, text="채널 포스트 본문입니다.",
    scheduled_at: datetime | None = None,
):
    r_draft = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts",
        json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": text},
    )
    assert r_draft.status_code == 201, r_draft.text
    draft_id = r_draft.json()["draft_id"]
    submit_body = {}
    if scheduled_at is not None:
        submit_body["scheduled_at"] = scheduled_at.isoformat()
    r_submit = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json=submit_body,
    )
    assert r_submit.status_code == 200, r_submit.text
    gate_id = uuid.UUID(r_submit.json()["gate_id"])
    await _approve_gate_directly(session, gate_id)
    return draft_id, gate_id


@pytest.mark.anyio
async def test_command_id_null_when_no_command_yet():
    """AC1 — 명령이 아직 없는(초안·상신만 한) draft는 목록·단건 둘 다 command_id=null."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_id, _gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
            assert r_detail.status_code == 200, r_detail.text
            assert r_detail.json()["command_id"] is None

            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            assert r_list.status_code == 200, r_list.text
            item = next(i for i in r_list.json() if i["draft_id"] == draft_id)
            assert item["command_id"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_command_id_matches_latest_command_after_publish_request():
    """AC1 — 발행 요청(즉시 경로) 뒤 목록·단건 command_id가 실제 생성된 command 행의
    id와 정확히 일치하고, 기존 command_status와 같은 행을 가리킨다."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        with (
            patch.object(tp, "create_container", AsyncMock(return_value="creation-1")),
            patch.object(tp, "publish_container", AsyncMock(return_value="media-1")),
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "get_permalink", AsyncMock(return_value="https://www.threads.net/@demo/post/media-1")),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_pub = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
                assert r_pub.status_code == 200, r_pub.text
                expected_command_id = (r_pub.json().get("data") or r_pub.json())["command_id"]

                r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
                assert r_detail.status_code == 200, r_detail.text
                detail = r_detail.json()
                assert detail["command_id"] == expected_command_id
                assert detail["command_status"] == "completed"

                r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
                assert r_list.status_code == 200, r_list.text
                item = next(i for i in r_list.json() if i["draft_id"] == draft_id)
                assert item["command_id"] == expected_command_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_command_id_reflects_latest_command_after_reapproval_voids_prior_one():
    """AC1 — voided 뒤 재승인으로 새 command가 생기면 command_id는 **최신** 명령(새
    pending 행)을 가리킨다(옛 voided 행이 아니다) — latest_command_by_gate 배치가
    created_at desc로 이미 이 순서를 보장한다(story #3415 관례 재확인)."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.main import app

    scheduled_at = datetime.now(timezone.utc) + timedelta(days=1)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
                scheduled_at=scheduled_at,
            )

        with (patch.object(tp, "create_container", AsyncMock()), patch.object(tp, "publish_container", AsyncMock())):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_pub = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
                assert r_pub.status_code == 200, r_pub.text
                voided_command_id = (r_pub.json().get("data") or r_pub.json())["command_id"]

        # 본문 편집(재승인 트리거) → 기존 pending command voided.
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            r_edit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "수정된 본문."},
            )
            assert r_edit.status_code == 201, r_edit.text
            await _approve_gate_directly(s, gate_id)

        with (patch.object(tp, "create_container", AsyncMock()), patch.object(tp, "publish_container", AsyncMock())):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_pub2 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
                assert r_pub2.status_code == 200, r_pub2.text
                new_command_id = (r_pub2.json().get("data") or r_pub2.json())["command_id"]
                assert new_command_id != voided_command_id

                r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
                assert r_detail.status_code == 200, r_detail.text
                assert r_detail.json()["command_id"] == new_command_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
