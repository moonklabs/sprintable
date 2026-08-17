"""story #2722(아티팩트·evidence 버전 pin) — evidence가 아티팩트를 근거로 삼을 때 그 시각의
버전을 서버가 resolve해 고정하는지 실 Postgres로 검증.

test_e_verify_v0_s1_evidence_realdb.py와 동형 셋업(팀레벨 뷰 의존이라 create_all 부적합)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요 — alembic upgrade heads 적용된 DB"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(session):
    """org + project + agent(grant된) + story + artifact(2버전)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.pm import Story
    from app.models.visual_artifact import ArtifactVersion, VisualArtifact

    org = Organization(id=uuid.uuid4(), name="2722 Org", slug=f"s2722-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="2722 Project")
    other_project = Project(id=uuid.uuid4(), org_id=org.id, name="2722 Other Project")
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Evidence Agent", is_active=True)
    session.add_all([project, other_project, agent])
    await session.commit()

    grant = ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member",
    )
    other_grant = ProjectAccess(
        id=uuid.uuid4(), project_id=other_project.id, member_id=agent.id, permission="granted", role="member",
    )
    session.add_all([grant, other_grant])

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="2722 Story", status="in-progress")
    session.add(story)
    await session.commit()

    artifact = VisualArtifact(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="2722 Artifact",
        latest_version_number=2,
    )
    other_project_artifact = VisualArtifact(
        id=uuid.uuid4(), org_id=org.id, project_id=other_project.id, title="2722 Other-Project Artifact",
    )
    session.add_all([artifact, other_project_artifact])
    await session.commit()

    v1 = ArtifactVersion(id=uuid.uuid4(), artifact_id=artifact.id, version_number=1)
    v2 = ArtifactVersion(id=uuid.uuid4(), artifact_id=artifact.id, version_number=2)
    other_v1 = ArtifactVersion(id=uuid.uuid4(), artifact_id=other_project_artifact.id, version_number=1)
    session.add_all([v1, v2, other_v1])
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "agent_id": agent.id,
        "story_id": story.id, "artifact_id": artifact.id,
        "v1_id": v1.id, "v2_id": v2.id,
        "other_project_artifact_id": other_project_artifact.id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _auth_override(member_id, org_id):
    async def _auth():
        from app.dependencies.auth import AuthContext
        return AuthContext(
            user_id=str(member_id), email="agent@test",
            claims={"app_metadata": {"org_id": str(org_id), "api_key_id": "test-key"}},
        )
    return _auth


async def _setup_app(app, Session, member_id, org_id):
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            yield s

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth_override(member_id, org_id)
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_evidence_with_artifact_id_pins_latest_version():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seed = await _seed(s)

        await _setup_app(app, Session, seed["agent_id"], seed["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/evidence", json={
                "work_item_id": str(seed["story_id"]), "work_item_type": "story",
                "type": "report", "ref": "entity:artifact:" + str(seed["artifact_id"]),
                "artifact_id": str(seed["artifact_id"]),
            })
            assert resp.status_code == 201, resp.text
            body = resp.json()
            # 시딩 시점 latest는 v2(version_number=2) — v1이 아니라 v2가 고정돼야 한다.
            assert body["artifact_version_id"] == str(seed["v2_id"])
            # FE가 ArtifactExpandDialog 왕복(artifactId+versionNumber)에 쓰는 denorm 필드.
            assert body["artifact_id"] == str(seed["artifact_id"])
            assert body["artifact_version_number"] == 2
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_evidence_without_artifact_id_leaves_version_unpinned():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seed = await _seed(s)

        await _setup_app(app, Session, seed["agent_id"], seed["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/evidence", json={
                "work_item_id": str(seed["story_id"]), "work_item_type": "story",
                "type": "url", "ref": "https://example.com/unrelated",
            })
            assert resp.status_code == 201, resp.text
            assert resp.json()["artifact_version_id"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_new_version_after_evidence_created_does_not_retroactively_change_pin():
    """③pin 시점 규칙의 핵심 — evidence 생성 後 아티팩트가 v3로 바뀌어도 이미 생성된
    evidence의 artifact_version_id는 v2(생성 당시 latest)에 그대로 고정돼야 한다."""
    from app.main import app
    from app.models.visual_artifact import ArtifactVersion

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seed = await _seed(s)

        await _setup_app(app, Session, seed["agent_id"], seed["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/evidence", json={
                "work_item_id": str(seed["story_id"]), "work_item_type": "story",
                "type": "report", "ref": "entity:artifact:" + str(seed["artifact_id"]),
                "artifact_id": str(seed["artifact_id"]),
            })
            evidence_id = resp.json()["id"]
            assert resp.json()["artifact_version_id"] == str(seed["v2_id"])

            async with Session() as s:
                v3 = ArtifactVersion(id=uuid.uuid4(), artifact_id=seed["artifact_id"], version_number=3)
                s.add(v3)
                await s.commit()

            get_resp = await client.get(f"/api/v2/evidence/{evidence_id}")
            assert get_resp.status_code == 200
            assert get_resp.json()["artifact_version_id"] == str(seed["v2_id"]), (
                "pin은 생성 시각 고정 — 이후 신규 버전이 조용히 근거를 바꿔선 안 된다"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cross_project_artifact_id_rejected():
    """agent가 접근권을 가진 다른 project 소속이라도 work_item과 다른 project의 artifact를
    근거로 못 삼는다(cross-project artifact 근거 금지, visual_artifacts.py:_get_artifact_or_404
    와 동일 근거) — 404(존재 비노출)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seed = await _seed(s)

        await _setup_app(app, Session, seed["agent_id"], seed["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/evidence", json={
                "work_item_id": str(seed["story_id"]), "work_item_type": "story",
                "type": "report", "ref": "cross-project-attempt",
                "artifact_id": str(seed["other_project_artifact_id"]),
            })
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_nonexistent_artifact_id_rejected():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seed = await _seed(s)

        await _setup_app(app, Session, seed["agent_id"], seed["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/evidence", json={
                "work_item_id": str(seed["story_id"]), "work_item_type": "story",
                "type": "report", "ref": "fake",
                "artifact_id": str(uuid.uuid4()),
            })
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
