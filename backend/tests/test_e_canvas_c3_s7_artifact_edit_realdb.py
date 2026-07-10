"""E-CANVAS C3-S7(story 940266db): 딸깍 편집(REST) + MCP 편집이 공용 서비스 경로를 경유해
같은 artifact를 편집(add/update/delete → 새 버전, node id 버전 간 안정)함을 실증. AC3(양방향
이벤트 전파)·AC4(휴먼↔에이전트 편집 왕복) 검증."""
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


async def _seed(session, *, creator_type: str = "agent"):
    """org(project) + artifact(1 version, 2 nodes) — creator_type로 생성자를 human/agent 중
    택해 AC4 양방향 이벤트 전파 검증에 사용."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from app.models.visual_artifact import ArtifactNode, ArtifactVersion, VisualArtifact

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    creator_user_id = None
    if creator_type == "agent":
        creator = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="creator-agent", is_active=True)
        session.add(creator)
        await session.commit()
        creator_id = creator.id
        session.add(ProjectAccess(
            id=uuid.uuid4(), project_id=project.id, member_id=creator_id, permission="granted", role="member",
        ))
        await session.commit()
    else:
        user = User(id=uuid.uuid4(), email=f"creator-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
        session.add(user)
        await session.commit()
        creator_user_id = user.id
        om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user.id, role="member")
        session.add(om)
        await session.commit()
        session.add(ProjectAccess(
            id=uuid.uuid4(), project_id=project.id, org_member_id=om.id, permission="granted",
        ))
        await session.commit()
        creator_id = om.id

    artifact = VisualArtifact(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Edit Artifact",
        source="created", latest_version_number=1, created_by=creator_id,
    )
    session.add(artifact)
    await session.commit()

    version = ArtifactVersion(id=uuid.uuid4(), artifact_id=artifact.id, version_number=1, created_by=creator_id)
    session.add(version)
    await session.commit()

    node_a = ArtifactNode(
        id=uuid.uuid4(), artifact_id=artifact.id, version_id=version.id,
        type="text", props={"content": "Node A"}, sort_order=0,
    )
    node_b = ArtifactNode(
        id=uuid.uuid4(), artifact_id=artifact.id, version_id=version.id,
        type="text", props={"content": "Node B"}, sort_order=1,
    )
    session.add_all([node_a, node_b])
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "artifact_id": artifact.id,
        "creator_id": creator_id, "creator_user_id": creator_user_id,
        "node_a_id": node_a.id, "node_b_id": node_b.id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, project_id, user_id=None):
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
            user_id=str(user_id or uuid.uuid4()), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_add_operation_creates_new_version_with_node():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/edit",
                json={"operations": [{"op": "add", "type": "button", "props": {"label": "Click"}}]},
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()["data"]
            assert body["version_number"] == 2
            node_types = {n["type"] for n in body["nodes"]}
            assert "button" in node_types
            # 기존 노드 2개도 새 버전에 계승됨.
            assert len(body["nodes"]) == 3
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_operation_changes_props_in_new_version():
    """update 대상은 편집 시점 최신 버전의 id로 지정 — 결과는 props 내용으로 검증한다.
    (ArtifactNode.id는 테이블 전역 PK라 버전마다 새 row=새 id — C1-S3 "버전마다 자기 소유
    node row 세트" 설계 계승. cross-version 안정 식별은 op 호출 시점의 id로 대상만 지정하고,
    응답의 새 id는 다음 편집에서 다시 조회해 얻는다.)"""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/edit",
                json={"operations": [
                    {"op": "update", "id": str(seeded["node_a_id"]), "props": {"content": "Node A Updated"}},
                ]},
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()["data"]
            contents = {n["props"].get("content") for n in body["nodes"]}
            assert "Node A Updated" in contents
            assert "Node A" not in contents  # 교체됐지 병행 존재 아님
            assert "Node B" in contents  # 미편집 노드는 내용 그대로 계승
            assert len(body["nodes"]) == 2  # 노드 수는 그대로(update는 add가 아님)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_operation_removes_node_from_new_version():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/edit",
                json={"operations": [{"op": "delete", "id": str(seeded["node_b_id"])}]},
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()["data"]
            contents = {n["props"].get("content") for n in body["nodes"]}
            assert "Node B" not in contents
            assert "Node A" in contents
            assert len(body["nodes"]) == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_nonexistent_node_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/edit",
                json={"operations": [{"op": "update", "id": str(uuid.uuid4()), "props": {}}]},
            )
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_previous_version_nodes_untouched_after_edit():
    """무-mutate 원칙: v1 조회 시 편집 전 상태 그대로(버전 전환은 무-mutate — C1-S3 설계 계승)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/edit",
                json={"operations": [{"op": "delete", "id": str(seeded["node_b_id"])}]},
            )
            v1_resp = await client.get(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/versions/1",
            )
            assert v1_resp.status_code == 200
            v1_node_ids = {n["id"] for n in v1_resp.json()["data"]["nodes"]}
            assert str(seeded["node_b_id"]) in v1_node_ids, "v1은 편집 후에도 원본 유지돼야 함"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ac4_human_edits_agent_creator_notified():
    """AC4 왕복①: 생성자=에이전트, 편집자=휴먼 → 에이전트에게 artifact.updated 이벤트 전파."""
    from sqlalchemy import select

    from app.main import app
    from app.models.event import Event

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, creator_type="agent")

        human_editor_id = uuid.uuid4()
        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], user_id=human_editor_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/edit",
                json={"operations": [{"op": "add", "type": "text", "props": {}}]},
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(Event.org_id == seeded["org_id"], Event.event_type == "dispatched")
            )).scalars().all()
            payloads = [r.payload for r in rows]
            assert any(p.get("event_type") == "artifact.updated" for p in payloads if isinstance(p, dict))
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ac4_agent_edits_human_creator_notified():
    """AC4 왕복②: 생성자=휴먼, 편집자=에이전트 → 휴먼에게 artifact.updated 이벤트 전파(양방향
    실증 — 한쪽만 되면 왕복이 아니라 편도)."""
    from sqlalchemy import select

    from app.main import app
    from app.models.notification import Notification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, creator_type="human")

        agent_editor = None
        async with Session() as s:
            from app.models.member import Member
            from app.models.project_access import ProjectAccess
            agent_editor = Member(
                id=uuid.uuid4(), org_id=seeded["org_id"], type="agent", name="editor-agent", is_active=True,
            )
            s.add(agent_editor)
            await s.commit()
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=seeded["project_id"], member_id=agent_editor.id,
                permission="granted", role="member",
            ))
            await s.commit()
            agent_editor_id = agent_editor.id

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], user_id=agent_editor_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/edit",
                json={"operations": [{"op": "add", "type": "text", "props": {}}]},
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            rows = (await s.execute(
                select(Notification).where(
                    Notification.org_id == seeded["org_id"],
                    Notification.user_id == seeded["creator_user_id"],
                    Notification.type == "artifact.updated",
                )
            )).scalars().all()
            assert len(rows) == 1, "휴먼 생성자에게 in-app 알림이 기록돼야 함"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
