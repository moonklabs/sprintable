"""story #3404(Phase1 결함, site_posts.py::submit_site_post_draft의 story f6d14476 처방을
channel_posts로 미러, 페드루 PO 확定 2026-09-04) — external_publish 게이트 슬롯은 work_item
단위(draft 단위가 아니다). 같은 work_item에 채널 포스트 초안이 둘(예: 서로 다른
connection_id) 있으면, 이미 다른 초안이 그 게이트를 쥐고(pending/approved) 있는데 뒤늦게
다른 초안이 상신하면 조용히 그 게이트를 재봉인·pending으로 되돌리던 결함 — site_posts에서
이미 고친 클래스 그대로 재현 가능했다(디디 코드 확認, 2026-09-03).

이 파일의 핵심 pin: 「가드 없으면 빨강」 — draft B 상신이 draft A의 승인을 실제로 되돌리지
않는지, 그리고 같은 draft 재상신은 여전히(회귀 없이) 허용되는지."""
from __future__ import annotations

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


async def _seed_org(session, *, slug=None):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Gate Already Held Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


async def _seed_connection(session, org_id, *, channel="threads", status="active", account_id=None, token="plain-access-token"):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel,
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", status=status,
        credential_kind="oauth", refresh_mode="reissue_from_access_token",
        encrypted_access_token=encrypt_channel_credential(token) if status == "active" else None,
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


async def _get_gate_status(session, gate_id):
    from app.models.gate import Gate
    from sqlalchemy import select

    return (await session.execute(select(Gate.status).where(Gate.id == gate_id))).scalar_one()


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


def _draft_body(*, work_item_id, connection_id, text="채널 포스트 본문입니다."):
    return {"work_item_id": str(work_item_id), "connection_id": str(connection_id), "text": text}


@pytest.mark.anyio
async def test_second_draft_submit_blocked_while_first_holds_approved_gate():
    """⭐핵심 pin — draft A(연결 1) 상신·승인 뒤, 같은 work_item의 draft B(연결 2)를
    상신하면 409 CHANNEL_POST_GATE_ALREADY_HELD로 거부되고, A의 gate.status는 approved
    그대로 남는다(가드 없으면: B의 상신이 같은 게이트를 B의 내용으로 재봉인+pending으로
    되돌려 이 assert가 실패한다 — 그게 이 pin의 존재 이유)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_a = await _seed_connection(s, org_id, account_id="acct-a")
            connection_b = await _seed_connection(s, org_id, account_id="acct-b")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            r_draft_a = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_a, text="A안"),
            )
            assert r_draft_a.status_code == 201, r_draft_a.text
            draft_a_id = r_draft_a.json()["draft_id"]

            r_submit_a = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_a_id}/submit", json={},
            )
            assert r_submit_a.status_code == 200, r_submit_a.text
            gate_a_id = uuid.UUID(r_submit_a.json()["gate_id"])
            await _approve_gate_directly(s, gate_a_id)

            r_draft_b = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_b, text="B안"),
            )
            assert r_draft_b.status_code == 201, r_draft_b.text
            draft_b_id = r_draft_b.json()["draft_id"]

            r_submit_b = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_b_id}/submit", json={},
            )
            assert r_submit_b.status_code == 409, r_submit_b.text
            body = r_submit_b.json()["error"]
            assert body["code"] == "CHANNEL_POST_GATE_ALREADY_HELD"
            assert body["holding_draft_id"] == draft_a_id
            assert body["holding_channel"] == "threads"
            assert body["holding_connection_id"] == str(connection_a)

        async with Session() as s:
            assert await _get_gate_status(s, gate_a_id) == "approved", (
                "draft B의 상신 시도가 draft A의 승인을 pending으로 되돌렸다 — 가드가 안 걸린 것"
            )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_same_draft_resubmit_still_allowed_no_regression():
    """AC3(회귀 없음) — 같은 draft를 다시 상신(예: 재승인 요청)하는 것은 그대로 허용된다
    (자기 자신은 "다른 초안"이 아니다)."""
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
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]

            r_submit_1 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit_1.status_code == 200, r_submit_1.text

            # 재상신(같은 버전, no-op) — 여전히 200이어야 한다.
            r_submit_2 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit_2.status_code == 200, r_submit_2.text
            assert r_submit_2.json()["gate_id"] == r_submit_1.json()["gate_id"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_creating_non_holding_draft_does_not_reopen_or_reseal_other_gate():
    """⭐발견 즉시 수정 회귀가드 — draft A 승인 뒤, draft B(다른 연결)를 그냥 '생성'만
    해도(상신 없이) `_reseal_gate_on_new_version` 훅이 work_item_id만으로 A의 게이트를
    찾아 조용히 reopen/재봉인하던 경로(디디가 실제로 재현한 그 버그, submit() 가드보다
    앞선 시점)를 막는다. B 생성 후 A 게이트는 완전 불변이어야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_a = await _seed_connection(s, org_id, account_id="acct-a")
            connection_b = await _seed_connection(s, org_id, account_id="acct-b")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_a_id, gate_a_id = await _seed_submit_approve(
                client, s, org_id=org_id, connection_id=connection_a, story_id=story_id, text="A안",
            )

            r_draft_b = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_b, text="B안"),
            )
            assert r_draft_b.status_code == 201, r_draft_b.text

        async with Session() as s:
            assert await _get_gate_status(s, gate_a_id) == "approved", (
                "draft B의 생성(상신도 아님)이 draft A의 승인을 pending으로 되돌렸다"
            )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def _seed_submit_approve(client, session, *, org_id, connection_id, story_id, text):
    r_draft = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts",
        json=_draft_body(work_item_id=story_id, connection_id=connection_id, text=text),
    )
    assert r_draft.status_code == 201, r_draft.text
    draft_id = r_draft.json()["draft_id"]
    r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
    assert r_submit.status_code == 200, r_submit.text
    gate_id = uuid.UUID(r_submit.json()["gate_id"])
    await _approve_gate_directly(session, gate_id)
    return draft_id, gate_id


@pytest.mark.anyio
async def test_legacy_gate_without_draft_id_in_neutral_facts_does_not_block():
    """"모른다≠다르다" — neutral_facts에 draft_id가 없는(이 판정이 생기기 前에 만들어진)
    레거시 게이트는 누가 쥐고 있는지 모르므로 차단하지 않는다. 레거시 상태는 정상 경로로
    만든 뒤(draft A 상신 → neutral_facts.draft_id가 채워짐) 그 키만 직접 제거해 재현한다
    (Gate 모델을 손으로 다시 짓지 않는다 — 실제 컬럼 스키마와 어긋날 위험)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_a = await _seed_connection(s, org_id, account_id="acct-a")
            connection_b = await _seed_connection(s, org_id, account_id="acct-b")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_draft_a = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_a),
            )
            assert r_draft_a.status_code == 201, r_draft_a.text

            r_submit_a = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{r_draft_a.json()['draft_id']}/submit",
                json={},
            )
            assert r_submit_a.status_code == 200, r_submit_a.text
            gate_id = uuid.UUID(r_submit_a.json()["gate_id"])

        # 레거시 재현 — draft_id 키만 제거(그 외 필드는 정상 경로가 채운 그대로 유지).
        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select

            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            gate.neutral_facts = {k: v for k, v in gate.neutral_facts.items() if k != "draft_id"}
            await s.commit()

        async with _client_for(app) as client:
            r_draft_b = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_b),
            )
            assert r_draft_b.status_code == 201, r_draft_b.text

            r_submit_b = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{r_draft_b.json()['draft_id']}/submit",
                json={},
            )
            assert r_submit_b.status_code == 200, r_submit_b.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
