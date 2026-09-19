"""story #4068(E-RECIPE-1, 페드루 PO 確定 2026-09-19) — `material_lineage` write 경로.
#4058(entity:doc:c7991109-4349-485b-8599-d7b886c7a951 §3④)이 처음부터 write 엔드포인트를
스코프 밖으로 明시했고, apply/gate/publish 어느 흐름도 자동 insert하지 않아 sandbox 발행까지
관통해도 성과 화면(hook-performance/material-performance)이 항상 빈 상태였다.

미르코 제안(매핑 규약) — PO 승인(2026-09-19 16:32Z, conv 32b8cff9):
  - 삽입지점: `publish_channel_post_draft`(channel_posts.py) 성공 경로, ChannelPublication
    커밋 직후(발행 안 된 초안까지 잡으면 "성과0 죽은 edge"가 쌓인다).
  - source_evidence_id: 같은 work_item의 `type="url" AND ref="live-run:master-cut"`
    evidence(#4051 계약, 1:1 앵커) 최신 1건. 없으면 row를 만들지 않는다(fail-soft).
  - hook_key: story #3645로 이미 `ChannelPostVersion.hook_key`에 존재(신설 스키마 0) —
    `latest.hook_key`를 그대로 읽는다.
  - relation_kind/variant_axis: **초안 제안 단계**에서는 hook_key 有→"hook_variant"·
    無→"platform_cut"으로 갈랐으나, 구현 직전 doc c7991109 §4③(v4, 디디 [SID:4061]
    확定 — "hook_key는 relation_kind와 무관하게 독립적으로 채워진다")과 어긋남을 발견해
    정정 — relation_kind는 **항상 "platform_cut"**(variant_axis=connection.channel),
    hook_key는 그 위에 독립적으로 함께 싣는다(doc v5 반영, 아래 테스트가 실제 계약)."""
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

    org = Organization(id=uuid.uuid4(), name="Lineage Write Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="댄"):
    from app.models.team import TeamMember
    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_human(session, org_id, project_id, *, name="사람 발행자"):
    """publish_channel_post_draft가 human-only(CHANNEL_POST_PUBLISH_HUMAN_ONLY)라
    필요 — test_4069의 owner 시딩과 동형(OrgMember.user_id가 AuthContext.user_id로
    쓰이는 축, member_resolver.py 0075 "휴먼 members.id = org_members.id" 정정)."""
    from app.models.project import OrgMember
    from app.models.team import TeamMember

    user_id = uuid.uuid4()
    member = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role="member")
    session.add(member)
    await session.commit()
    session.add(TeamMember(
        id=member.id, org_id=org_id, project_id=project_id, type="human", name=name, is_active=True,
    ))
    await session.commit()
    return user_id


async def _seed_story(session, org_id, project_id, *, title="영상 제작 산출물"):
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


async def _seed_sandbox_connection(session, org_id, *, account_id=None):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel="sandbox",
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", status="active",
        credential_kind="none", refresh_mode="manual",
        encrypted_access_token=encrypt_channel_credential("sandbox-dummy-token"),
    )
    session.add(conn)
    await session.commit()
    return conn.id


async def _seed_master_evidence(session, org_id, story_id):
    from app.models.evidence import Evidence
    ev = Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
        type="url", ref="live-run:master-cut", payload={"url": "https://example.com/master-cut.mp4"},
    )
    session.add(ev)
    await session.commit()
    return ev.id


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


async def _submit_and_publish(
    app, Session, *, org_id, story_id, connection_id, text, hook_key=None, agent_id, human_user_id,
):
    """draft 생성(agent)→상신(agent)→직접 승인→발행(human, publish는 human-only)까지 한
    번에. publication_id를 반환."""
    body = {"work_item_id": str(story_id), "connection_id": str(connection_id), "text": text}
    if hook_key is not None:
        body["hook_key"] = hook_key

    _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
    async with _client_for(app) as client:
        r_draft = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts", json=body)
        assert r_draft.status_code == 201, r_draft.text
        draft_id = r_draft.json()["draft_id"]

        r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
        assert r_submit.status_code == 200, r_submit.text
        gate_id = uuid.UUID(r_submit.json()["gate_id"])

    async with Session() as s:
        await _approve_gate_directly(s, gate_id)

    _setup_org_scoped_app(app, Session, org_id, user_id=human_user_id, agent=False)
    async with _client_for(app) as client:
        r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish", json={})
        assert r_publish.status_code == 200, r_publish.text
        return uuid.UUID(r_publish.json()["publication_id"])


@pytest.mark.anyio
async def test_publish_with_hook_key_creates_platform_cut_lineage_row_with_hook_key():
    """hook_key 有 — doc c7991109 §4③(v4) 확定대로 relation_kind는 여전히 "platform_cut"
    (variant_axis=channel), hook_key는 그 위에 독립적으로 함께 실린다(hook_variant
    전용 필드가 아니다)."""
    from app.main import app
    from app.models.material_lineage import MaterialLineage
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id = await _seed_human(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_sandbox_connection(s, org_id)
            master_evidence_id = await _seed_master_evidence(s, org_id, story_id)

        publication_id = await _submit_and_publish(
            app, Session, org_id=org_id, story_id=story_id, connection_id=connection_id,
            text="A안 도입부 3초컷", hook_key="hook-a-intro-3s",
            agent_id=agent_id, human_user_id=human_user_id,
        )

        async with Session() as s:
            rows = (await s.execute(
                select(MaterialLineage).where(MaterialLineage.work_item_id == story_id)
            )).scalars().all()
        assert len(rows) == 1, "발행 1건이 lineage 정확히 1 row를 만들어야 한다"
        row = rows[0]
        assert row.source_evidence_id == master_evidence_id
        assert row.derived_kind == "channel_publication"
        assert row.derived_id == publication_id
        assert row.relation_kind == "platform_cut"
        assert row.variant_axis == "sandbox"
        assert row.hook_key == "hook-a-intro-3s"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_without_hook_key_creates_platform_cut_lineage_row():
    """hook_key 無 — relation_kind="platform_cut", variant_axis=connection.channel."""
    from app.main import app
    from app.models.material_lineage import MaterialLineage
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id = await _seed_human(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_sandbox_connection(s, org_id)
            await _seed_master_evidence(s, org_id, story_id)

        await _submit_and_publish(
            app, Session, org_id=org_id, story_id=story_id, connection_id=connection_id,
            text="훅 태깅 없는 일반 발행", agent_id=agent_id, human_user_id=human_user_id,
        )

        async with Session() as s:
            rows = (await s.execute(
                select(MaterialLineage).where(MaterialLineage.work_item_id == story_id)
            )).scalars().all()
        assert len(rows) == 1
        row = rows[0]
        assert row.relation_kind == "platform_cut"
        assert row.variant_axis == "sandbox"
        assert row.hook_key is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_without_master_evidence_creates_no_lineage_row_fail_soft():
    """앵커(live-run:master-cut evidence) 없음 — 발행 자체는 정상 성공하지만 lineage row는
    0건(지어내지 않는다). 비레시피 수동 발행류가 이 경로다."""
    from app.main import app
    from app.models.material_lineage import MaterialLineage
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id = await _seed_human(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_sandbox_connection(s, org_id)
            # 의도적으로 master evidence를 안 심는다.

        publication_id = await _submit_and_publish(
            app, Session, org_id=org_id, story_id=story_id, connection_id=connection_id,
            text="앵커 없는 발행", agent_id=agent_id, human_user_id=human_user_id,
        )
        assert publication_id is not None, "앵커가 없어도 발행 자체는 성공해야 한다"

        async with Session() as s:
            rows = (await s.execute(
                select(MaterialLineage).where(MaterialLineage.work_item_id == story_id)
            )).scalars().all()
        assert rows == [], "앵커 evidence가 없는데 lineage row를 지어냈다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_hook_performance_endpoint_returns_real_nonzero_data_via_written_lineage():
    """AC1 — 발행이 만든 실 lineage row를 hook-performance GET이 실데이터로 집계하는지
    (organic_snapshots_only 필터 유지 확認 겸용). insight_snapshots 자체(비동기 수집)는
    이 스토리 범위 밖이라 테스트가 직접 스냅샷 1건을 심어 집계 경로만 잰다 — lineage
    row 자체는 실 발행(위 테스트들과 동일 경로)이 만든 것을 그대로 쓴다."""
    from app.main import app
    from app.models.insight_snapshot import InsightSnapshot
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id = await _seed_human(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_sandbox_connection(s, org_id)
            await _seed_master_evidence(s, org_id, story_id)

        publication_id = await _submit_and_publish(
            app, Session, org_id=org_id, story_id=story_id, connection_id=connection_id,
            text="성과 집계 실증", hook_key="hook-perf-check",
            agent_id=agent_id, human_user_id=human_user_id,
        )

        async with Session() as s:
            now = datetime.now(timezone.utc)
            s.add(InsightSnapshot(
                id=uuid.uuid4(), org_id=org_id, publication_id=publication_id,
                publication_kind="channel_publication", work_item_id=story_id, channel="sandbox",
                due_at=now, captured_at=now, status="captured",
                normalized={"impressions": 500, "reach": 300, "engagements": 20},
            ))
            await s.commit()

        async with _client_for(app) as client:
            r = await client.get(
                f"/api/v2/material-lineage/hook-performance",
                params={"hook_key": "hook-perf-check"},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["variant_count"] == 1
        assert body["snapshot_count"] == 1
        assert body["totals"]["impressions"] == 500
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
