"""story #3370(카디르 QA 지적, 페드루 재검토 2026-09-10 — #4156 리뷰) — 전수 grep이
「이름으로」(is_agent_caller 호출 여부) 걸렀던 탓에 놓친 같은 클래스 2파일:

- `workflow_line_config.py`: `create_draft()`의 `created_by_member_id`(영속) ·
  `request_publish()`가 짓는 `Gate.neutral_facts.requested_by_member_id`(영속) ·
  `transition_gate(resolver_id=)`→`Gate.resolver_id`(영속, self-approval 판정의
  비교 축이라 틀리면 **자기승인 탐지 자체가 무력화**되는 보안 결함까지 겹침).
- `visual_artifacts.py`: `VisualArtifact.created_by`·`ArtifactComment.created_by`/
  `resolved_by`·`ArtifactVersion.created_by`(전부 영속) · `create_gate`의
  neutral_facts.requested_by_member_id. `VisualArtifact.created_by` 정정에 딸려
  delete_artifact의 소유권 비교(`artifact.created_by != auth.user_id`)도 같은 축으로
  안 맞추면 원작성자 본인이 자기 것도 못 지우는 회귀가 남(같은 커밋에서 동시 정정).

둘 다 `resolve_member_db_verified()`(member_resolver.py, #3370에서 신설)로 정정 —
access축(raw)·저장축(resolve) 분리는 기존 사이트들과 동형."""
from __future__ import annotations

import os
import uuid

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


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session, *, slug=None):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="3370 Follow-up Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


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


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_org_scoped_app(app, Session, org_id, *, user_id, project_id=None):
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
        claims: dict = {"app_metadata": {"org_id": str(org_id)}}
        if project_id is not None:
            claims["app_metadata"]["project_id"] = str(project_id)
        return AuthContext(user_id=str(user_id), email="caller@test", claims=claims)

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


_PASSING_CONFIG = {"steps": [{"step_key": "s1", "step_type": "advisory"}]}


# ─── workflow_line_config.py ────────────────────────────────────────────────


@pytest.mark.anyio
async def test_create_draft_human_created_by_member_id_resolves_to_org_member_id():
    """뮤테이션 대상 — create_draft_version_endpoint의 resolve_member_db_verified() 호출을
    되돌리면 RED(WorkflowLineDefinitionVersion.created_by_member_id가 users.id로 떨어짐)."""
    from app.main import app
    from app.models.workflow_line import WorkflowLineDefinitionVersion
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, org_member_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        async with _client_for(app) as client:
            r = await client.post(
                "/api/v2/workflow-line-config/versions",
                json={"entity_type": "story", "config": {}, "project_id": None},
            )
        assert r.status_code == 201, r.text
        version_id = r.json()["id"]

        async with Session() as s:
            version = (
                await s.execute(
                    select(WorkflowLineDefinitionVersion).where(WorkflowLineDefinitionVersion.id == uuid.UUID(version_id))
                )
            ).scalar_one()
        assert version.created_by_member_id == org_member_id
        assert version.created_by_member_id != user_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_request_publish_human_requested_by_member_id_resolves_to_org_member_id():
    """뮤테이션 대상 — request_publish_endpoint의 resolve_member_db_verified() 호출을
    되돌리면 RED(Gate.neutral_facts.requested_by_member_id가 users.id로 떨어짐)."""
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, org_member_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                "/api/v2/workflow-line-config/versions",
                json={"entity_type": "story", "config": _PASSING_CONFIG, "project_id": None},
            )
            assert r_draft.status_code == 201, r_draft.text
            version_id = r_draft.json()["id"]

            r_pub = await client.post(f"/api/v2/workflow-line-config/versions/{version_id}/request-publish")
        assert r_pub.status_code == 200, r_pub.text
        gate_id = r_pub.json()["gate_id"]

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == uuid.UUID(gate_id)))).scalar_one()
        assert gate.neutral_facts["requested_by_member_id"] == str(org_member_id)
        assert gate.neutral_facts["requested_by_member_id"] != str(user_id)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_approve_publish_self_approval_detection_works_for_human_requester():
    """story #3370(보안 결함) — 정정 前에는 self-approval 판정(assert_not_self_approval)이
    gate.neutral_facts.requested_by_member_id(영속 멤버 id)와 raw auth.user_id(users.id)를
    비교해 휴먼끼리는 절대 같을 수 없었다 — 같은 사람이 자기 request를 자기가 approve해도
    항상 통과(무력화)했을 결함. 이 테스트는 그 탐지가 실제로 동작함을 확認한다.

    뮤테이션 대상 — approve_publish_endpoint의 resolve_member_db_verified() 호출(assert_
    not_self_approval에 넘기는 쪽)을 raw auth.user_id로 되돌리면 이 테스트가 RED여야
    한다(자기승인이 403 대신 200으로 통과)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, org_member_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                "/api/v2/workflow-line-config/versions",
                json={"entity_type": "story", "config": _PASSING_CONFIG, "project_id": None},
            )
            assert r_draft.status_code == 201, r_draft.text
            version_id = r_draft.json()["id"]

            r_pub = await client.post(f"/api/v2/workflow-line-config/versions/{version_id}/request-publish")
            assert r_pub.status_code == 200, r_pub.text
            # disposition 기본값이 auto라 이미 published면 이 테스트는 무의미 — pending
            # 기대(승인 축을 직접 재는 게 목적이므로 auto 승인이면 스킵 사유를 명확히).
            if r_pub.json()["gate_status"] != "pending":
                pytest.skip(f"gate_status={r_pub.json()['gate_status']}(auto disposition) — self-approval 축 대상 아님")

            r_approve = await client.post(f"/api/v2/workflow-line-config/versions/{version_id}/approve")
        assert r_approve.status_code == 403, r_approve.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── visual_artifacts.py ─────────────────────────────────────────────────────


async def _seed_artifact(session, org_id, project_id, *, created_by):
    from app.models.visual_artifact import VisualArtifact

    artifact = VisualArtifact(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="A",
        source="created", latest_version_number=1, created_by=created_by,
    )
    session.add(artifact)
    await session.commit()
    return artifact.id


@pytest.mark.anyio
async def test_create_artifact_human_created_by_resolves_to_org_member_id():
    """뮤테이션 대상 — create_artifact의 resolve_member_db_verified() 호출을 되돌리면
    RED(VisualArtifact.created_by가 users.id로 떨어짐)."""
    from app.main import app
    from app.models.visual_artifact import VisualArtifact
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, org_member_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=user_id, project_id=project_id)
        async with _client_for(app) as client:
            r = await client.post(
                "/api/v2/visual-artifacts", json={"title": "T", "source": "created", "nodes": [{"type": "text", "props": {}}]},
            )
        assert r.status_code == 201, r.text
        artifact_id = r.json()["data"]["id"]

        async with Session() as s:
            artifact = (
                await s.execute(select(VisualArtifact).where(VisualArtifact.id == uuid.UUID(artifact_id)))
            ).scalar_one()
        assert artifact.created_by == org_member_id
        assert artifact.created_by != user_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_own_artifact_succeeds_human_ownership_axis_matches():
    """story #3370 — create_artifact 정정(created_by=영속 멤버 id)에 딸린 회귀: delete_
    artifact의 소유권 비교(artifact.created_by != auth.user_id)도 같은 축으로 안 맞추면
    원작성자 본인이 자기 것도 못 지운다. 이 테스트는 그 회귀가 없음을 직접 확認한다.

    뮤테이션 대상 — delete_artifact의 resolve_member_db_verified() 호출을 raw auth.
    user_id로 되돌리면 이 테스트가 RED여야 한다(본인 삭제가 403)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, org_member_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=user_id, project_id=project_id)
        async with _client_for(app) as client:
            r_create = await client.post(
                "/api/v2/visual-artifacts", json={"title": "T", "source": "created", "nodes": [{"type": "text", "props": {}}]},
            )
            assert r_create.status_code == 201, r_create.text
            artifact_id = r_create.json()["data"]["id"]

            r_delete = await client.delete(f"/api/v2/visual-artifacts/{artifact_id}")
        assert r_delete.status_code == 200, r_delete.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_add_comment_and_resolve_human_ids_resolve_to_org_member_id():
    """뮤테이션 대상 — add_artifact_comment/resolve_artifact_comment의 resolve_member_
    db_verified() 호출을 되돌리면 RED(ArtifactComment.created_by/resolved_by가 users.id
    로 떨어짐)."""
    from app.main import app
    from app.models.visual_artifact import ArtifactComment
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, org_member_id = await _seed_human(s, org_id, role="owner")
            artifact_id = await _seed_artifact(s, org_id, project_id, created_by=org_member_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=user_id, project_id=project_id)
        async with _client_for(app) as client:
            r_comment = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/comments",
                json={"content": "c1", "anchor_x": 0, "anchor_y": 0},
            )
            assert r_comment.status_code == 201, r_comment.text
            comment_id = r_comment.json()["data"]["id"]

            r_resolve = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/comments/{comment_id}/resolve",
            )
        assert r_resolve.status_code == 200, r_resolve.text

        async with Session() as s:
            comment = (
                await s.execute(select(ArtifactComment).where(ArtifactComment.id == uuid.UUID(comment_id)))
            ).scalar_one()
        assert comment.created_by == org_member_id
        assert comment.created_by != user_id
        assert comment.resolved_by == org_member_id
        assert comment.resolved_by != user_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_propose_canonical_version_human_requested_by_member_id_resolves_to_org_member_id():
    """뮤테이션 대상 — propose_canonical_version의 resolve_member_db_verified() 호출을
    되돌리면 RED(Gate.neutral_facts.requested_by_member_id가 users.id로 떨어짐)."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.visual_artifact import ArtifactVersion
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, org_member_id = await _seed_human(s, org_id, role="owner")
            artifact_id = await _seed_artifact(s, org_id, project_id, created_by=org_member_id)
            version = ArtifactVersion(
                id=uuid.uuid4(), artifact_id=artifact_id, version_number=1,
                created_by=org_member_id, canvas_bounds=None,
            )
            s.add(version)
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=user_id, project_id=project_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/visual-artifacts/{artifact_id}/versions/1/canonicalize")
        assert r.status_code == 201, r.text
        gate_id = r.json()["data"]["gate_id"]

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == uuid.UUID(gate_id)))).scalar_one()
        assert gate.neutral_facts["requested_by_member_id"] == str(org_member_id)
        assert gate.neutral_facts["requested_by_member_id"] != str(user_id)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
