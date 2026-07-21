"""story #2082(선생님 실사용 발견 — 결재함에서 artifact_canonicalize 게이트가 안 보임/못 닿음).

근본: `resolve_work_item_project_id`(gate_service.py, story #1968 SSOT)와 `list_gates`의
assigned_to_me 배치 project_id 해소(gates.py) 둘 다 `work_item_type == "visual_artifact"`를
처음부터 커버하지 않았다 — `VisualArtifact.project_id`가 NOT NULL임에도 story/task/doc만
커버해 canonicalize 게이트의 project_id가 항상 None으로 떨어졌다. 그 결과
`_non_doc_gate_approvable`이 "구조적으로 project-무관"으로 오판해 org owner/admin에게만
노출하고, project-level owner/admin(정본 담당자)에겐 assigned_to_me=true 인박스에서
canonicalize 게이트가 사라졌다(딥링크할 항목 자체가 없어 "결재함에 버튼도 없다"로 보임).

AC(오르테가군 명시): "서버가 그 결재를 목록에 실제로 뱉고·승인/거절이 서버 처리되는지"
라이브(화면상태 아님) — 아래 realdb 테스트가 정확히 이걸 실 HTTP 왕복으로 캡처한다.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# realdb 섹션이 Base.metadata.create_all을 호출한다 — conftest.py AST 가드(story 8236bbc3) 대응.
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ═══════════════ resolve_work_item_project_id: visual_artifact 분기(mocked) ═══════════════


@pytest.mark.anyio
async def test_resolve_work_item_project_id_visual_artifact_returns_project_id():
    from app.services.gate_service import resolve_work_item_project_id

    session = AsyncMock()
    result_mock = AsyncMock()
    result_mock.scalar_one_or_none = lambda: uuid.UUID(int=1)
    session.execute = AsyncMock(return_value=result_mock)

    out = await resolve_work_item_project_id(
        session, uuid.uuid4(), "visual_artifact", uuid.uuid4()
    )
    assert out == uuid.UUID(int=1)


@pytest.mark.anyio
async def test_resolve_work_item_project_id_unrecognized_type_still_returns_none():
    """회귀 없음 — visual_artifact 분기 추가가 다른 미지원 타입의 None 폴백을 안 건드림."""
    from app.services.gate_service import resolve_work_item_project_id

    out = await resolve_work_item_project_id(
        AsyncMock(), uuid.uuid4(), "wf_line_version", uuid.uuid4()
    )
    assert out is None


# ═══════════════════════ realdb: HTTP 왕복 — 인박스 노출 + 승인 처리 ═══════════════════════

_REAL_DB_SKIP = pytest.mark.skipif(
    not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"
)


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.models  # noqa: F401 — 전 모델 메타데이터 로드
    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, user_id):
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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {}})

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _seed_org_project_artifact_and_owner(session):
    """org + project + project-owner(A, org-level은 plain member) + visual_artifact 1건.

    A는 project owner grant만 있고 org owner/admin은 **아니다** — 회귀 재현의 핵심 조건
    (org-level fallback으로 우연히 통과하면 실측 의미가 없다)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from app.models.visual_artifact import VisualArtifact

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    user_a = User(id=uuid.uuid4(), email=f"a-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(user_a)
    await session.commit()

    om_a = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_a.id, role="member")  # org-level=member
    session.add(om_a)
    await session.commit()

    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=om_a.id,
        permission="granted", role="owner",  # project-level=owner
    ))
    await session.commit()

    artifact = VisualArtifact(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="mock-1")
    session.add(artifact)
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "artifact_id": artifact.id,
        "user_a_id": user_a.id,
    }


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_artifact_canonicalize_gate_visible_to_project_owner_not_org_admin():
    """근본 회귀 실측 — project-level owner(org-level은 plain member)가
    `/api/v2/gates/inbox?status=pending&assigned_to_me=true`로 canonicalize 게이트를 본다."""
    from app.main import app
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_artifact_and_owner(s)
            org_id, artifact_id, a_id = seeded["org_id"], seeded["artifact_id"], seeded["user_a_id"]

            gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=artifact_id,
                work_item_type="visual_artifact", gate_type="artifact_canonicalize",
                status="pending",
            )
            s.add(gate)
            await s.commit()

        await _setup_app(app, Session, org_id, a_id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/gates/inbox", params={"status": "pending", "assigned_to_me": "true"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            print("\n=== realdb #2082 artifact_canonicalize inbox capture (A=project-owner, org=member) ===")
            for row in body:
                print(f"  id={row.get('id')} gate_type={row.get('gate_type')} work_item_type={row.get('work_item_type')}")
            ids = {row["id"] for row in body if "id" in row}
            assert str(gate.id) in ids, (
                "artifact_canonicalize 게이트가 project-owner의 assigned_to_me=true 인박스에서 "
                "빠짐 — visual_artifact project_id 배치 해소 회귀 재발(story #2082)"
            )
        finally:
            await client.aclose()
        app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_artifact_canonicalize_gate_approve_processes_server_side():
    """AC: 목록 노출뿐 아니라 승인 액션 자체가 서버에서 실제로 처리되는지(화면상태 아님)."""
    from app.main import app
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_artifact_and_owner(s)
            org_id, artifact_id, a_id = seeded["org_id"], seeded["artifact_id"], seeded["user_a_id"]

            gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=artifact_id,
                work_item_type="visual_artifact", gate_type="artifact_canonicalize",
                status="pending",
            )
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, org_id, a_id)
        client = _client_for(app)
        try:
            with patch(
                "app.routers.gates.wake_agent", AsyncMock(return_value=None)
            ):
                resp = await client.post(
                    f"/api/v2/gates/{gate_id}/transition",
                    # note는 risk_grade=high 게이트 타입의 approve 서버측 강제 사유(story #2027)를
                    # 무해하게 만족시키기 위함 — 이 테스트의 검증 대상(project_id 배치 해소 회귀)과
                    # 무관한 별개 정책이라 우회하지 않고 그냥 채운다.
                    json={"status": "approved", "note": "test approve"},
                )
            assert resp.status_code == 200, resp.text
            assert resp.json()["status"] == "approved"

            async with Session() as s2:
                refreshed = await s2.get(Gate, gate_id)
                assert refreshed.status == "approved", "서버 DB에 approved가 실제로 반영 안 됨"
        finally:
            await client.aclose()
        app.dependency_overrides.clear()
    finally:
        await engine.dispose()
