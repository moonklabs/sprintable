"""E-CANVAS C4-S8(story a5118cb0): 정본화(canonicalize) — 기존 E-DG Decision Gate 재사용 실증.
AI는 제안만(propose), 승인/반려는 항상 휴먼(범용 POST /api/v2/gates/{id}/transition 경유).
approve→anchor_version set+artifact.canonicalized 전파, reject→anchor_version 불변+재논의 코멘트."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
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
    """org(project) + artifact(1 version, agent 생성) + 승인용 실 휴먼(User+OrgMember).
    propose 호출은 auth.user_id를 그대로 created_by/requested_by로 쓰므로(멤버 조회 없음)
    creator == proposer(agent, 자기 산출물 제안)로 단순화. approve/reject만 resolve_member를
    타므로 그 경로에만 실 휴먼 row가 필요하다."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from app.models.visual_artifact import ArtifactVersion, VisualArtifact

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    creator = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="creator-agent", is_active=True)
    session.add(creator)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=creator.id, permission="granted", role="member",
    ))
    await session.commit()

    approver_user = User(id=uuid.uuid4(), email=f"approver-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(approver_user)
    await session.commit()
    approver_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=approver_user.id, role="member")
    session.add(approver_om)
    await session.commit()

    artifact = VisualArtifact(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Canon Artifact",
        source="created", latest_version_number=1, created_by=creator.id,
    )
    session.add(artifact)
    await session.commit()

    version = ArtifactVersion(id=uuid.uuid4(), artifact_id=artifact.id, version_number=1, created_by=creator.id)
    session.add(version)
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "artifact_id": artifact.id,
        "creator_id": creator.id, "approver_user_id": approver_user.id, "approver_om_id": approver_om.id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_propose_app(app, Session, org_id, project_id, user_id):
    """propose 호출용 — get_db + get_current_user(app_metadata.org_id/project_id)."""
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(user_id), email="proposer@test",
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


async def _setup_transition_app(app, Session, org_id, user_id):
    """gates/{id}/transition 호출용 — get_db + get_current_user + get_verified_org_id
    (resolve_member가 이 조합을 타서 JWT 휴먼 분기로 해소됨, api_key_id 미설정)."""
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(user_id=str(user_id), email="approver@test", claims={"app_metadata": {}})

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_propose_creates_pending_gate():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_propose_app(app, Session, seeded["org_id"], seeded["project_id"], seeded["creator_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/versions/1/canonicalize",
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()["data"]
            assert body["status"] == "pending"  # always-manual — org auto-posture 무관
            assert body["artifact_id"] == str(seeded["artifact_id"])
            assert body["version_number"] == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_propose_idempotent_returns_same_gate():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_propose_app(app, Session, seeded["org_id"], seeded["project_id"], seeded["creator_id"])
        client = _client_for(app)
        try:
            r1 = await client.post(f"/api/v2/visual-artifacts/{seeded['artifact_id']}/versions/1/canonicalize")
            r2 = await client.post(f"/api/v2/visual-artifacts/{seeded['artifact_id']}/versions/1/canonicalize")
            assert r1.json()["data"]["gate_id"] == r2.json()["data"]["gate_id"]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_propose_nonexistent_version_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_propose_app(app, Session, seeded["org_id"], seeded["project_id"], seeded["creator_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/versions/99/canonicalize",
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_approve_sets_anchor_version_and_notifies_creator():
    from sqlalchemy import select

    from app.main import app
    from app.models.event import Event
    from app.models.visual_artifact import VisualArtifact

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_propose_app(app, Session, seeded["org_id"], seeded["project_id"], seeded["creator_id"])
        client = _client_for(app)
        try:
            propose_resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/versions/1/canonicalize",
            )
            gate_id = propose_resp.json()["data"]["gate_id"]
        finally:
            await client.aclose()

        app.dependency_overrides.clear()
        await _setup_transition_app(app, Session, seeded["org_id"], seeded["approver_user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/gates/{gate_id}/transition", json={"status": "approved"})
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            artifact = (await s.execute(
                select(VisualArtifact).where(VisualArtifact.id == seeded["artifact_id"])
            )).scalar_one()
            assert artifact.anchor_version == 1

            rows = (await s.execute(
                select(Event).where(Event.org_id == seeded["org_id"], Event.event_type == "dispatched")
            )).scalars().all()
            payloads = [r.payload for r in rows]
            assert any(
                p.get("event_type") == "artifact.canonicalized" for p in payloads if isinstance(p, dict)
            ), f"artifact.canonicalized 이벤트 미전파: {payloads}"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reject_does_not_set_anchor_and_creates_redisc_comment():
    from sqlalchemy import select

    from app.main import app
    from app.models.visual_artifact import ArtifactComment, VisualArtifact

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_propose_app(app, Session, seeded["org_id"], seeded["project_id"], seeded["creator_id"])
        client = _client_for(app)
        try:
            propose_resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/versions/1/canonicalize",
            )
            gate_id = propose_resp.json()["data"]["gate_id"]
        finally:
            await client.aclose()

        app.dependency_overrides.clear()
        await _setup_transition_app(app, Session, seeded["org_id"], seeded["approver_user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate_id}/transition",
                json={"status": "rejected", "note": "아직 승인 안 됨 — 색상 토큰 재논의 필요"},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            artifact = (await s.execute(
                select(VisualArtifact).where(VisualArtifact.id == seeded["artifact_id"])
            )).scalar_one()
            assert artifact.anchor_version is None, "반려는 anchor_version을 바꾸지 않아야 함(멱등 no-op)"

            comments = (await s.execute(
                select(ArtifactComment).where(ArtifactComment.artifact_id == seeded["artifact_id"])
            )).scalars().all()
            assert len(comments) == 1
            assert comments[0].content == "아직 승인 안 됨 — 색상 토큰 재논의 필요"
            assert comments[0].created_by == seeded["approver_om_id"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mcp_propose_canonical_version_roundtrip():
    """AI 제안 왕복: MCP sprintable_propose_canonical_version → gate pending 확認."""
    import json as _json
    import os as _os

    import httpx

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_propose_app(app, Session, seeded["org_id"], seeded["project_id"], seeded["creator_id"])

        _os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
        _os.environ.setdefault("AGENT_API_KEY", "sk_test")

        from sprintable_mcp.tools.visual_artifacts import ProposeCanonicalInput, propose_canonical_version
        from sprintable_mcp import api_client as api_client_mod

        transport = httpx.ASGITransport(app=app)
        real_client = api_client_mod.client
        test_http_client = httpx.AsyncClient(transport=transport, base_url="http://test")

        async def _post(path, **kwargs):
            r = await test_http_client.post(path, **kwargs)
            r.raise_for_status()
            return r.json()["data"]

        orig_post = real_client.post
        real_client.post = _post
        try:
            result = await propose_canonical_version(ProposeCanonicalInput(
                artifact_id=str(seeded["artifact_id"]), version_number=1,
            ))
            body = _json.loads(result[0].text)
            assert body["status"] == "pending"
        finally:
            real_client.post = orig_post
            await test_http_client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
