"""E-CANVAS C2-S6(story 0edca31e): artifact 코멘트(요소/좌표 앵커·스레드·resolve) + description
pane 실증. 스토리 코멘트와 공통 프리미티브(content/created_by/created_at + C0 이벤트 전파)
계승 확認·MCP list/add 왕복(AC4)."""
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
    """org(project) + artifact(1 node, description 포함) — created_by는 실 agent member(project
    grant 보유)라 dispatch_notification의 team_members 조회가 실제로 매치돼 이벤트 전파를
    실증할 수 있다(랜덤 UUID는 team_members에 없어 조용히 스킵됨)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.visual_artifact import ArtifactNode, ArtifactVersion, VisualArtifact

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    creator = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="artifact-creator", is_active=True)
    session.add(creator)
    await session.commit()
    creator_id = creator.id
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=creator_id, permission="granted", role="member",
    ))
    await session.commit()

    artifact = VisualArtifact(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Artifact",
        source="created", latest_version_number=1, created_by=creator_id,
    )
    session.add(artifact)
    await session.commit()

    version = ArtifactVersion(id=uuid.uuid4(), artifact_id=artifact.id, version_number=1, created_by=creator_id)
    session.add(version)
    await session.commit()

    node = ArtifactNode(
        id=uuid.uuid4(), artifact_id=artifact.id, version_id=version.id,
        type="text", props={"content": "hello"}, sort_order=0,
        description="이 요소는 헤더 카피 슬롯입니다.",
    )
    session.add(node)
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "artifact_id": artifact.id,
        "node_id": node.id, "creator_id": creator_id,
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
async def test_node_description_roundtrip():
    """회귀 0: get_artifact가 node.description을 그대로 반환(description pane 데이터)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/visual-artifacts/{seeded['artifact_id']}")
            assert resp.status_code == 200
            node = resp.json()["data"]["nodes"][0]
            assert node["description"] == "이 요소는 헤더 카피 슬롯입니다."
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_add_comment_element_anchor_and_list():
    """요소 앵커(node_id) 코멘트 생성 → list에서 조회."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/comments",
                json={"content": "이 헤더 좀 더 크게", "node_id": str(seeded["node_id"])},
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()["data"]
            assert body["node_id"] == str(seeded["node_id"])
            assert body["resolved"] is False

            list_resp = await client.get(f"/api/v2/visual-artifacts/{seeded['artifact_id']}/comments")
            assert list_resp.status_code == 200
            items = list_resp.json()["data"]
            assert len(items) == 1
            assert items[0]["content"] == "이 헤더 좀 더 크게"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_add_comment_coordinate_anchor():
    """좌표 앵커(anchor_x/anchor_y) 코멘트 — node_id 없이 자유 핀."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/comments",
                json={"content": "여기 여백 좁아요", "anchor_x": 120.5, "anchor_y": 340.2},
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()["data"]
            assert body["node_id"] is None
            assert body["anchor_x"] == 120.5
            assert body["anchor_y"] == 340.2
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_threaded_reply():
    """스레드: parent_id로 답글 생성."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            root_resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/comments",
                json={"content": "루트 코멘트"},
            )
            root_id = root_resp.json()["data"]["id"]

            reply_resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/comments",
                json={"content": "답글입니다", "parent_id": root_id},
            )
            assert reply_resp.status_code == 201, reply_resp.text
            assert reply_resp.json()["data"]["parent_id"] == root_id
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reply_to_comment_on_other_artifact_blocked():
    """crux: parent_id가 다른 artifact 소속 코멘트를 가리키면 404(cross-artifact 스레드 위조 차단).
    같은 org/project 내 서로 다른 두 artifact로 구성 — org 경계 문제(Q)와는 다른 축."""
    from app.models.visual_artifact import ArtifactVersion, VisualArtifact

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            other_artifact = VisualArtifact(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                title="Other Artifact", source="created", latest_version_number=1,
                created_by=seeded["creator_id"],
            )
            s.add(other_artifact)
            await s.commit()
            s.add(ArtifactVersion(
                id=uuid.uuid4(), artifact_id=other_artifact.id, version_number=1,
                created_by=seeded["creator_id"],
            ))
            await s.commit()
            other_artifact_id = other_artifact.id

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            other_root = await client.post(
                f"/api/v2/visual-artifacts/{other_artifact_id}/comments",
                json={"content": "다른 artifact의 코멘트"},
            )
            other_root_id = other_root.json()["data"]["id"]

            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/comments",
                json={"content": "위조 스레드 시도", "parent_id": other_root_id},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_comment():
    """resolve → resolved=True + resolved_by/resolved_at 기록."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        resolver_id = uuid.uuid4()
        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], user_id=resolver_id)
        client = _client_for(app)
        try:
            create_resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/comments",
                json={"content": "이거 고쳐주세요"},
            )
            comment_id = create_resp.json()["data"]["id"]

            resolve_resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/comments/{comment_id}/resolve",
            )
            assert resolve_resp.status_code == 200, resolve_resp.text
            body = resolve_resp.json()["data"]
            assert body["resolved"] is True
            assert body["resolved_by"] == str(resolver_id)
            assert body["resolved_at"] is not None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_comment_event_propagation_to_creator():
    """C0 §F4: 코멘트 작성 시 artifact 생성자에게 comment.created 이벤트 전파(작성자 자신 제외)."""
    from sqlalchemy import select

    from app.main import app
    from app.models.event import Event

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        commenter_id = uuid.uuid4()
        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], user_id=commenter_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/comments",
                json={"content": "확認 부탁"},
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(
                    Event.org_id == seeded["org_id"],
                    Event.event_type == "dispatched",
                )
            )).scalars().all()
            # dispatch_notification의 에이전트 경로가 Event INSERT(payload.event_type=comment.created)
            payloads = [r.payload for r in rows]
            assert any(p.get("event_type") == "comment.created" for p in payloads if isinstance(p, dict)), (
                f"comment.created 이벤트 미전파: {payloads}"
            )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mcp_add_and_list_comments_roundtrip():
    """AC4 실증: MCP sprintable_add_artifact_comment → sprintable_list_artifact_comments 왕복."""
    import json as _json
    import os as _os

    import httpx

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])

        _os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
        _os.environ.setdefault("AGENT_API_KEY", "sk_test")

        from sprintable_mcp.tools.visual_artifacts import (
            AddArtifactCommentInput, ListArtifactCommentsInput, add_artifact_comment, list_artifact_comments,
        )
        from sprintable_mcp import api_client as api_client_mod

        transport = httpx.ASGITransport(app=app)
        real_client = api_client_mod.client
        test_http_client = httpx.AsyncClient(transport=transport, base_url="http://test")

        async def _post(path, **kwargs):
            r = await test_http_client.post(path, **kwargs)
            r.raise_for_status()
            return r.json()["data"]

        async def _get(path, **kwargs):
            r = await test_http_client.get(path, **kwargs)
            r.raise_for_status()
            return r.json()["data"]

        orig_post, orig_get = real_client.post, real_client.get
        real_client.post = _post
        real_client.get = _get
        try:
            add_result = await add_artifact_comment(AddArtifactCommentInput(
                artifact_id=str(seeded["artifact_id"]),
                content="MCP에서 남긴 코멘트",
                node_id=str(seeded["node_id"]),
            ))
            added = _json.loads(add_result[0].text)
            assert added["content"] == "MCP에서 남긴 코멘트"

            list_result = await list_artifact_comments(ListArtifactCommentsInput(
                artifact_id=str(seeded["artifact_id"]),
            ))
            listed = _json.loads(list_result[0].text)
            assert len(listed) == 1
            assert listed[0]["content"] == "MCP에서 남긴 코멘트"
        finally:
            real_client.post = orig_post
            real_client.get = orig_get
            await test_http_client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
