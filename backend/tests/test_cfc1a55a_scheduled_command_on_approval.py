"""story cfc1a55a/#3443(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — 예약 상신
(gate.sealed_scheduled_at)이 approved로 전이되는 순간 publication_command를 자동
생성한다(블루프린트 v3 §3 "승인 완료 시 명령 생성" 원문 정합 — 지금까지는 휴먼의
별도 발행 요청만 명령을 만들어, 승인 뒤 클릭이 없으면 예약 시각에 아무것도 안 나갔다,
2026-09-04 12:46Z 샌드박스 라이브 실측).

이 파일의 테스트는 **`gate_service.py::transition_gate()`를 직접 호출**한다 —
test_3414_publication_command.py의 `_approve_gate_directly`(gate.status를 직접
대입)와 달리, 이 스토리의 훅이 `transition_gate()` 안에 살아 그 우회로는 훅을
전혀 안 태운다(사고 자체가 실 승인 엔드포인트에서만 나고 기존 단위테스트가 전부
그 경로를 bypass해 놓쳤던 사실의 재발 방지 — story 본문 발견 섹션 그대로)."""
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
    """transition_gate()는 notification/activity-log 등에서 전역 엔진
    (app.core.database.engine)을 태울 수 있다 — test_3330의 표준 방어 그대로."""
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

    org = Organization(id=uuid.uuid4(), name="Scheduled Command Test Org", slug=f"org-{uuid.uuid4().hex[:8]}")
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
    """(user_id, member_id) 둘 다 반환 — `user_id`(users.id)는 AuthContext/HTTP 인증축
    (`_setup_org_scoped_app`), `member_id`(org_member.id)는 `resolve_member().id`와
    동형인 member-bound 축(routers/gates.py::transition_gate_endpoint가 `_resolver_id
    = resolved.id`로 넘기는 바로 그 값) — `transition_gate()`를 직접 부를 때의
    `resolver_id`는 반드시 이쪽이어야 한다(섞으면 "Organization member not found")."""
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return user.id, om.id


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


async def _submit_draft(
    client, *, org_id, connection_id, story_id, text="채널 포스트 본문입니다.",
    scheduled_at: datetime | None = None,
) -> tuple[uuid.UUID, uuid.UUID]:
    """draft 생성+상신까지만(승인은 호출부가 `transition_gate()`로 직접) —
    _approve_gate_directly를 쓰지 않는 것이 이 파일의 핵심(모듈 docstring 참고)."""
    r_draft = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts",
        json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": text},
    )
    assert r_draft.status_code == 201, r_draft.text
    draft_id = uuid.UUID(r_draft.json()["draft_id"])
    submit_body = {}
    if scheduled_at is not None:
        submit_body["scheduled_at"] = scheduled_at.isoformat()
    r_submit = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json=submit_body,
    )
    assert r_submit.status_code == 200, r_submit.text
    gate_id = uuid.UUID(r_submit.json()["gate_id"])
    return draft_id, gate_id


@pytest.mark.anyio
async def test_approval_of_scheduled_draft_auto_creates_publication_command():
    """AC1 — 실 승인 엔드포인트(transition_gate)로 approved 전이하면 command가 즉시
    1건 생기고, scheduled_at·requested_by_member_id가 정확히 실린다. 뮤테이션 대상
    (AC6) — 훅 호출(`_maybe_create_scheduled_publication_command`)을 제거하면 이
    assert가 RED."""
    from app.services.gate_service import transition_gate
    from app.main import app

    scheduled_at = datetime.now(timezone.utc) + timedelta(days=1)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _submit_draft(
                client, org_id=org_id, connection_id=connection_id, story_id=story_id,
                scheduled_at=scheduled_at,
            )

        async with Session() as s:
            gate = await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()
            assert gate.status == "approved"

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from app.models.channel_post_version import ChannelPostVersion
            from sqlalchemy import select

            rows = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalars().all()
            assert len(rows) == 1, "승인 즉시 publication_command가 자동 생성되지 않았다"
            cmd = rows[0]
            assert cmd.status == "pending"
            assert cmd.scheduled_at == scheduled_at
            assert cmd.destination == connection_id
            assert cmd.requested_by_member_id == human_id
            assert cmd.operation == "publish"

            latest_version_id = (await s.execute(
                select(ChannelPostVersion.id)
                .where(ChannelPostVersion.draft_id == draft_id)
                .order_by(ChannelPostVersion.version.desc()).limit(1)
            )).scalar_one()
            assert cmd.approved_version == latest_version_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_approval_without_scheduled_at_creates_no_command():
    """AC3 — 즉시 경로(scheduled_at 없음) 승인은 명령을 만들지 않는다(현행 유지 —
    휴먼 발행 클릭이 명령을 만드는 기존 계약 무변경)."""
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
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _submit_draft(
                client, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        async with Session() as s:
            gate = await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()
            assert gate.sealed_scheduled_at is None

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select

            rows = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalars().all()
            assert len(rows) == 0, "즉시 경로 승인인데 command가 생겼다(현행 계약 위반)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_manual_publish_after_auto_created_command_is_idempotent():
    """AC4 — 자동 생성 뒤 휴먼이 `POST …/publish`를 또 불러도 같은 command_id를
    돌려주고 새 행이 안 생긴다(create_or_get_publication_command의 기존 멱등키 재사용,
    신규 로직 0)."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.services.gate_service import transition_gate
    from app.main import app

    scheduled_at = datetime.now(timezone.utc) + timedelta(days=1)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _submit_draft(
                client, org_id=org_id, connection_id=connection_id, story_id=story_id,
                scheduled_at=scheduled_at,
            )

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            auto_created_id = (await s.execute(
                select(PublicationCommand.id).where(PublicationCommand.gate_id == gate_id)
            )).scalar_one()

        with (
            patch.object(tp, "create_container", AsyncMock()),
            patch.object(tp, "publish_container", AsyncMock()),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_user_id, agent=False)
            async with _client_for(app) as client:
                r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
            assert r.status_code == 200, r.text
            body = r.json()["data"] if "data" in r.json() else r.json()
            assert body["scheduled"] is True
            assert uuid.UUID(body["command_id"]) == auto_created_id

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            rows = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalars().all()
            assert len(rows) == 1, "자동 생성된 command가 있는데 수동 발행 요청이 새 행을 또 만들었다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_content_change_after_approval_voids_old_command_new_approval_creates_new_one():
    """AC5 — 승인 뒤 본문 편집(재상신 없이 _reseal_gate_on_new_version 훅)이 게이트를
    pending으로 되돌리고 기존 명령을 voided(CONTENT_CHANGED)로 무효화한다(기존 경로,
    무변경) — 그 뒤 새 재상신+재승인은 새 approved_version으로 새 command 1건을
    만든다(내 훅이 재승인에도 정확히 다시 동작하는지)."""
    from app.services.gate_service import transition_gate
    from app.main import app

    scheduled_at = datetime.now(timezone.utc) + timedelta(days=1)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _submit_draft(
                client, org_id=org_id, connection_id=connection_id, story_id=story_id,
                scheduled_at=scheduled_at,
            )

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            first_cmd_id = (await s.execute(
                select(PublicationCommand.id).where(PublicationCommand.gate_id == gate_id)
            )).scalar_one()

        # 본문 편집(새 버전) — 재상신 없이 _reseal_gate_on_new_version 훅만 탄다.
        async with _client_for(app) as client:
            r_edit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id),
                    "text": "수정된 본문입니다.",
                },
            )
            assert r_edit.status_code == 201, r_edit.text

        async with Session() as s:
            from app.models.gate import Gate
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.status == "pending"
            old = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.id == first_cmd_id)
            )).scalar_one()
            assert old.status == "voided"
            assert old.reason_code == "CONTENT_CHANGED"

        # 재상신(scheduled_at 그대로) + 재승인.
        async with _client_for(app) as client:
            r_resubmit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit",
                json={"scheduled_at": scheduled_at.isoformat()},
            )
            assert r_resubmit.status_code == 200, r_resubmit.text

        async with Session() as s:
            await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            rows = (await s.execute(
                select(PublicationCommand)
                .where(PublicationCommand.gate_id == gate_id, PublicationCommand.status == "pending")
            )).scalars().all()
            assert len(rows) == 1, "재승인이 새 pending command를 정확히 1건 만들지 않았다"
            assert rows[0].id != first_cmd_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_draft_resolution_failure_does_not_block_approval_and_leaves_visible_note():
    """PO 確定(2026-09-04 13:08Z) — draft_id를 못 읽으면 승인 자체는 절대 안 막고
    (사람의 결정을 서버 부수 효과가 되돌리지 않는다), command도 안 만들고, gate.
    resolution_note에 사람이 보는 한 줄을 남긴다(warning 로그는 assert 대상 밖 —
    resolution_note가 사람에게 보이는 유일한 표면)."""
    from app.services.gate_service import (
        _SCHEDULED_COMMAND_DRAFT_UNRESOLVED_NOTE,
        transition_gate,
    )
    from app.main import app

    scheduled_at = datetime.now(timezone.utc) + timedelta(days=1)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_id, gate_id = await _submit_draft(
                client, org_id=org_id, connection_id=connection_id, story_id=story_id,
                scheduled_at=scheduled_at,
            )

        # neutral_facts.draft_id를 손상시켜 해석 실패를 강제 재현(레거시 게이트 시뮬레이션).
        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            gate.neutral_facts = {**(gate.neutral_facts or {}), "draft_id": "not-a-uuid"}
            await s.commit()

        async with Session() as s:
            gate = await transition_gate(s, org_id, gate_id, "approved", resolver_id=human_id)
            await s.commit()
            assert gate.status == "approved", "draft 해석 실패가 승인 자체를 막았다(사람 결정을 되돌리면 안 된다)"
            assert _SCHEDULED_COMMAND_DRAFT_UNRESOLVED_NOTE in (gate.resolution_note or "")

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            rows = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalars().all()
            assert len(rows) == 0, "draft 해석 실패인데 command가 생겼다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
