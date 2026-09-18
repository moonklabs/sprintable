"""story #3403(Phase1·마케팅운영, S2c BE 선행 2, 페드루 PO 확定 2026-09-04) — 채널 포스트
초안 단건 조회 `GET /organizations/{org_id}/channel-posts/drafts/{draft_id}`.

핵심 계약: 목록 엔드포인트(`GET .../channel-posts/drafts`, story #3394)의 항목과
**완전히 같은 shape·같은 조인 축**이어야 한다 — `list_channel_post_drafts()`를 draft_id
필터로 재사용하므로 구조적으로 같다(두 번째 쿼리 경로 없음). 이 파일의 각 상태 테스트는
목록 응답의 동등 항목과 단건 응답을 **필드 단위로 대조**한다(값이 우연히 같은 게 아니라
같은 코드 경로임을 pin)."""
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

    org = Organization(id=uuid.uuid4(), name="S2c Draft Detail Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


async def _seed_human(session, org_id, *, role="member"):
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


def _draft_body(*, work_item_id, connection_id, text="채널 포스트 본문입니다.", link_url=None):
    body = {"work_item_id": str(work_item_id), "connection_id": str(connection_id), "text": text}
    if link_url is not None:
        body["link_url"] = link_url
    return body


async def _seed_submit_approve(client, session, *, org_id, connection_id, story_id, text="채널 포스트 본문입니다."):
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
async def test_detail_draft_only_matches_list_item_exactly():
    """AC3(a) — 게이트조차 없는 순수 초안: 단건 응답이 목록의 동등 항목과 필드까지 정확히
    같다(같은 코드 경로 pin)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
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

            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")

        assert r_detail.status_code == 200, r_detail.text
        list_row = [it for it in r_list.json() if it["draft_id"] == draft_id]
        assert len(list_row) == 1
        # story #3514(PO 確定 2026-09-05) — violations는 유일하게 의도적으로 갈리는
        # 필드다(단건=lint-on-read로 방금 계산·목록=항상 None, 비용 N배 방지). "완전히
        # 같은 shape"라는 이 파일의 핵심 주장은 그 필드 하나를 빼고 여전히 성립한다.
        detail_body = {k: v for k, v in r_detail.json().items() if k != "violations"}
        list_body = {k: v for k, v in list_row[0].items() if k != "violations"}
        assert detail_body == list_body
        assert list_row[0]["violations"] is None
        assert r_detail.json()["violations"] == []
        assert r_detail.json()["gate_status"] is None
        assert r_detail.json()["publication_status"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_detail_published_matches_list_item_exactly():
    """AC3(b) — 승인+발행됨: publication_status=published, permalink/external_id/
    published_at 채워짐. 단건과 목록이 필드까지 정확히 같다."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_id, gate_id = await _seed_submit_approve(
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
                r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
                assert r_publish.status_code == 200, r_publish.text

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")

        assert r_detail.status_code == 200, r_detail.text
        list_row = [it for it in r_list.json() if it["draft_id"] == draft_id]
        assert len(list_row) == 1
        # story #3514(PO 確定 2026-09-05) — violations는 유일하게 의도적으로 갈리는
        # 필드다(단건=lint-on-read로 방금 계산·목록=항상 None, 비용 N배 방지). "완전히
        # 같은 shape"라는 이 파일의 핵심 주장은 그 필드 하나를 빼고 여전히 성립한다.
        detail_body = {k: v for k, v in r_detail.json().items() if k != "violations"}
        list_body = {k: v for k, v in list_row[0].items() if k != "violations"}
        assert detail_body == list_body
        assert list_row[0]["violations"] is None
        assert r_detail.json()["violations"] == []
        body = r_detail.json()
        assert body["publication_status"] == "published"
        assert body["permalink"] == "https://www.threads.net/@demo/post/media-1"
        assert body["external_id"] == "media-1"
        assert body["published_at"] is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_detail_partial_success_matches_list_item_exactly():
    """AC3(c) — 부분 성공(publication_status=container_created): 단건과 목록이 필드까지
    정확히 같다."""
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
            draft_id, gate_id = await _seed_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        async with Session() as s:
            from app.models.channel_publication import ChannelPublication
            from app.models.channel_post_version import ChannelPostVersion
            from sqlalchemy import select

            version_id = (await s.execute(
                select(ChannelPostVersion.id).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
            )).scalar_one()
            s.add(ChannelPublication(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, version_id=version_id,
                connection_id=connection_id, channel="threads",
                external_container_id="creation-mid-flight", status="container_created",
            ))
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")

        assert r_detail.status_code == 200, r_detail.text
        list_row = [it for it in r_list.json() if it["draft_id"] == draft_id]
        assert len(list_row) == 1
        # story #3514(PO 確定 2026-09-05) — violations는 유일하게 의도적으로 갈리는
        # 필드다(단건=lint-on-read로 방금 계산·목록=항상 None, 비용 N배 방지). "완전히
        # 같은 shape"라는 이 파일의 핵심 주장은 그 필드 하나를 빼고 여전히 성립한다.
        detail_body = {k: v for k, v in r_detail.json().items() if k != "violations"}
        list_body = {k: v for k, v in list_row[0].items() if k != "violations"}
        assert detail_body == list_body
        assert list_row[0]["violations"] is None
        assert r_detail.json()["violations"] == []
        assert r_detail.json()["publication_status"] == "container_created"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_detail_unknown_draft_id_404():
    """AC3(d) — 존재하지 않는 draft_id → 404(존재 비노출 관례)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{uuid.uuid4()}")
        assert r.status_code == 404, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_detail_org_scope_mismatch_404():
    """다른 org의 draft_id → 404(org_id로 스코프 안 벗어남 — 존재는 알지만 다른 조직 소유라는
    구별조차 노출하지 않는다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id_a, project_id_a = await _seed_org(s)
            org_id_b, project_id_b = await _seed_org(s)
            agent_id_a = await _seed_agent(s, org_id_a, project_id_a)
            story_id = await _seed_story(s, org_id_a, project_id_a)
            connection_id = await _seed_connection(s, org_id_a)

        _setup_org_scoped_app(app, Session, org_id_a, user_id=agent_id_a, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id_a}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]

        async with Session() as s:
            agent_id_b = await _seed_agent(s, org_id_b, project_id_b)
        _setup_org_scoped_app(app, Session, org_id_b, user_id=agent_id_b, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id_b}/channel-posts/drafts/{draft_id}")
        assert r.status_code == 404, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_human_can_also_read_detail():
    """목록과 동일 권한 — 휴먼도 단건 조회 가능(human-only 아님, publish와 대조)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="member")
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

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
        assert r.status_code == 200, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_detail_query_count_does_not_scale_with_other_drafts_in_org():
    """AC4(N+1 비회귀) — org에 다른 draft가 여럿 있어도 단건 조회의 SELECT 수는 그
    draft 하나뿐일 때와 같다(구조적으로 list_channel_post_drafts()의 draft_id 필터를
    타므로 자동 보장 — 실측으로 pin)."""
    from sqlalchemy import event
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]

            def _capture(stmts):
                def _listener(conn, cursor, statement, parameters, context, executemany):
                    stmts.append(statement)
                return _listener

            statements_solo: list[str] = []
            listener_solo = _capture(statements_solo)
            event.listen(engine.sync_engine, "before_cursor_execute", listener_solo)
            try:
                r_solo = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
                assert r_solo.status_code == 200, r_solo.text
            finally:
                event.remove(engine.sync_engine, "before_cursor_execute", listener_solo)
            select_count_solo = len([st for st in statements_solo if st.strip().upper().startswith("SELECT")])

            # 서로 다른 work_item(=서로 다른 게이트)을 가리키는 draft 3건 추가(같은 org).
            async with Session() as s:
                extra_story_ids = [await _seed_story(s, org_id, project_id) for _ in range(3)]
            for story_n in extra_story_ids:
                await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json=_draft_body(work_item_id=story_n, connection_id=connection_id),
                )

            statements_crowded: list[str] = []
            listener_crowded = _capture(statements_crowded)
            event.listen(engine.sync_engine, "before_cursor_execute", listener_crowded)
            try:
                r_crowded = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
                assert r_crowded.status_code == 200, r_crowded.text
                assert r_crowded.json()["draft_id"] == draft_id
            finally:
                event.remove(engine.sync_engine, "before_cursor_execute", listener_crowded)
            select_count_crowded = len([st for st in statements_crowded if st.strip().upper().startswith("SELECT")])

        assert select_count_crowded == select_count_solo, (
            f"org에 다른 draft가 늘어도 단건 조회 SELECT 수가 늘면 안 된다 — "
            f"solo={select_count_solo}, crowded={select_count_crowded}"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
