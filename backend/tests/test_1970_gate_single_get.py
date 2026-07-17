"""story #1970(P1a-S4): GET /api/v2/gates/{id} 단건 조회 신설.

배경: 알림 payload 의 reference_id(gate.id, gate_service.py:150,774)로 딥링크 콜드 진입(목록 없이
상세로 직행)이 이 단건 조회 없이는 불가능했다. 응답 shape=list 아이템과 동일(GateResponse)에
project_id(신규, resolve_work_item_project_id 재사용)/work_item_summary(story#1968·24f5ae18
doc-only 배치 enrich를 story/task까지 확장) 만 추가 enrich. 미르코(FE)가 그대로 소비하는
스레드 합의 계약(변경 금지).

테스트 구성:
- _resolve_work_item_summary 순수 로직(mocked session) — doc/story/task/미인식 타입 4분기.
- get_gate_endpoint 라우트(mocked session) — 200 전 필드·404 미존재·404 무권한(project_id
  해소됨 케이스)·project_id=None(project-무관 work_item) 은 access 체크 skip.
- realdb 통합(story/task/doc 각 타입 실 gate 콜드 GET 200 전 필드 실측 + 무권한 404).
- realdb soft-delete 회귀(까심 QA PR #2253 REQUEST_CHANGES): story/task 분기도 doc 과 동형으로
  deleted_at.is_(None) 필터가 적용돼 work_item_summary 가 None(유령 title 미노출)으로 떨어지는지.
- list_gates 회귀 없음(기존 doc-only enrich 그대로, project_id 필드 추가로 인한 크래시 없음).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# realdb 섹션이 Base.metadata.create_all을 호출한다 — conftest.py AST 가드(story 8236bbc3) 대응.
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _scalar_result(value):
    r = MagicMock()
    r.scalar_one_or_none.return_value = value
    return r


def _row_result(value):
    r = MagicMock()
    r.one_or_none.return_value = value
    return r


# ── _resolve_work_item_summary 순수 로직(mocked session) ────────────────────────


@pytest.mark.anyio
async def test_summary_doc_type_returns_title_and_slug():
    from app.routers.gates import _resolve_work_item_summary

    org_id, doc_id = uuid.uuid4(), uuid.uuid4()
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_row_result(("설계 문서", "design-doc")))

    result = await _resolve_work_item_summary(session, org_id, "doc", doc_id)

    assert result is not None
    assert result.title == "설계 문서"
    assert result.slug == "design-doc"


@pytest.mark.anyio
async def test_summary_story_type_returns_title_none_slug():
    from app.routers.gates import _resolve_work_item_summary

    org_id, story_id = uuid.uuid4(), uuid.uuid4()
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalar_result("스토리 제목"))

    result = await _resolve_work_item_summary(session, org_id, "story", story_id)

    assert result is not None
    assert result.title == "스토리 제목"
    assert result.slug is None


@pytest.mark.anyio
async def test_summary_task_type_returns_title_none_slug():
    from app.routers.gates import _resolve_work_item_summary

    org_id, task_id = uuid.uuid4(), uuid.uuid4()
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalar_result("태스크 제목"))

    result = await _resolve_work_item_summary(session, org_id, "task", task_id)

    assert result is not None
    assert result.title == "태스크 제목"
    assert result.slug is None


@pytest.mark.anyio
async def test_summary_unknown_type_returns_none_no_query():
    from app.routers.gates import _resolve_work_item_summary

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=AssertionError("미인식 타입은 쿼리하면 안 됨"))

    result = await _resolve_work_item_summary(session, uuid.uuid4(), "wf_line_version", uuid.uuid4())

    assert result is None
    session.execute.assert_not_awaited()


@pytest.mark.anyio
async def test_summary_doc_missing_returns_none():
    from app.routers.gates import _resolve_work_item_summary

    session = AsyncMock()
    session.execute = AsyncMock(return_value=_row_result(None))

    result = await _resolve_work_item_summary(session, uuid.uuid4(), "doc", uuid.uuid4())

    assert result is None


@pytest.mark.anyio
async def test_summary_story_missing_returns_none():
    from app.routers.gates import _resolve_work_item_summary

    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalar_result(None))

    result = await _resolve_work_item_summary(session, uuid.uuid4(), "story", uuid.uuid4())

    assert result is None


# ── get_gate_endpoint 라우트(mocked session) ─────────────────────────────────────


def _gate(org, work_item_id, wtype, gate_id=None):
    return SimpleNamespace(
        id=gate_id or uuid.uuid4(), org_id=org, work_item_id=work_item_id, work_item_type=wtype,
        gate_type="merge", status="pending", resolver_id=None, resolved_at=None,
        resolution_note=None, held_until=None, neutral_facts=None, requires_human=False,
        evidence_status=None, decision_basis=None, auto_decision_reason=None,
        created_at=datetime(2026, 7, 17, tzinfo=timezone.utc),
        updated_at=datetime(2026, 7, 17, tzinfo=timezone.utc),
    )


@pytest.mark.anyio
async def test_get_gate_endpoint_404_not_found():
    from app.routers import gates as gates_mod
    from app.routers.gates import get_gate_endpoint
    from fastapi import HTTPException

    org_id, gate_id = uuid.uuid4(), uuid.uuid4()
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalar_result(None))
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))

    with pytest.raises(HTTPException) as exc_info:
        await get_gate_endpoint(id=gate_id, session=session, org_id=org_id, auth=auth)

    assert exc_info.value.status_code == 404


@pytest.mark.anyio
async def test_get_gate_endpoint_404_no_project_access():
    """project_id 해소됐지만 caller 가 그 project 접근권이 없으면 403 아닌 404(존재 비노출)."""
    from app.routers import gates as gates_mod
    from app.routers.gates import get_gate_endpoint
    from fastapi import HTTPException

    org_id, gate_id, story_id, project_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    gate = _gate(org_id, story_id, "story", gate_id)
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalar_result(gate))
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))

    with patch.object(gates_mod, "resolve_work_item_project_id",
                       AsyncMock(return_value=project_id)) as resolve_spy, \
         patch.object(gates_mod, "has_project_access", AsyncMock(return_value=False)) as access_spy:
        with pytest.raises(HTTPException) as exc_info:
            await get_gate_endpoint(id=gate_id, session=session, org_id=org_id, auth=auth)

    assert exc_info.value.status_code == 404
    resolve_spy.assert_awaited_once_with(session, org_id, "story", story_id)
    access_spy.assert_awaited_once()


@pytest.mark.anyio
async def test_get_gate_endpoint_200_populates_project_id_and_summary():
    from app.routers import gates as gates_mod
    from app.routers.gates import WorkItemSummary, get_gate_endpoint

    org_id, gate_id, doc_id, project_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    gate = _gate(org_id, doc_id, "doc", gate_id)
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalar_result(gate))
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))

    with patch.object(gates_mod, "resolve_work_item_project_id",
                       AsyncMock(return_value=project_id)), \
         patch.object(gates_mod, "has_project_access", AsyncMock(return_value=True)), \
         patch.object(gates_mod, "_resolve_work_item_summary",
                       AsyncMock(return_value=WorkItemSummary(title="설계 문서", slug="design-doc"))):
        result = await get_gate_endpoint(id=gate_id, session=session, org_id=org_id, auth=auth)

    assert result.id == gate_id
    assert result.project_id == project_id
    assert result.work_item_summary is not None
    assert result.work_item_summary.title == "설계 문서"
    assert result.work_item_summary.slug == "design-doc"


@pytest.mark.anyio
async def test_get_gate_endpoint_project_id_none_skips_access_check():
    """project_id 가 None(구조적으로 project-무관 work_item)이면 has_project_access 호출 자체를
    스킵 — org 멤버십(get_verified_org_id 가 이미 강제)으로 충분."""
    from app.routers import gates as gates_mod
    from app.routers.gates import get_gate_endpoint

    org_id, gate_id, wi_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    gate = _gate(org_id, wi_id, "wf_line_version", gate_id)
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalar_result(gate))
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))

    with patch.object(gates_mod, "resolve_work_item_project_id",
                       AsyncMock(return_value=None)), \
         patch.object(gates_mod, "has_project_access",
                       AsyncMock(side_effect=AssertionError("호출되면 안 됨"))) as access_spy, \
         patch.object(gates_mod, "_resolve_work_item_summary", AsyncMock(return_value=None)):
        result = await get_gate_endpoint(id=gate_id, session=session, org_id=org_id, auth=auth)

    assert result.project_id is None
    access_spy.assert_not_called()


# ── realdb 통합(story/task/doc 각 타입 콜드 GET) ─────────────────────────────────

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401 — 전 모델 메타데이터 로드

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


async def _seed_common(session):
    """org + project + caller(project grant, has_project_access True 경로)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    caller = User(id=uuid.uuid4(), email=f"caller-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller.id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id,
        permission="granted", role="member",
    ))
    await session.commit()

    # project 접근권 없는 outsider(무권한 404 케이스용) — 동일 org, 다른 project 소속 없음.
    outsider = User(id=uuid.uuid4(), email=f"outsider-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(outsider)
    await session.commit()
    session.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=outsider.id, role="member"))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "caller_id": caller.id, "outsider_id": outsider.id}


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_cold_get_story_gate_200_all_fields():
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            story = Story(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                          title="실 스토리 제목")
            s.add(story)
            await s.commit()
            gate = Gate(id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id,
                        work_item_type="story", gate_type="merge", status="pending")
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate_id}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["id"] == str(gate_id)
            assert body["org_id"] == str(seeded["org_id"])
            assert body["project_id"] == str(seeded["project_id"])
            assert body["work_item_id"] == str(story.id)
            assert body["work_item_type"] == "story"
            assert body["work_item_summary"]["title"] == "실 스토리 제목"
            assert body["work_item_summary"]["slug"] is None
            assert body["gate_type"] == "merge"
            assert body["status"] == "pending"
            assert "created_at" in body and body["created_at"]
            assert "updated_at" in body and body["updated_at"]

            # 무권한 outsider → 404(존재 비노출)
            await _setup_app(app, Session, seeded["org_id"], seeded["outsider_id"])
            resp2 = await client.get(f"/api/v2/gates/{gate_id}")
            assert resp2.status_code == 404, resp2.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_cold_get_task_gate_200_all_fields():
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story, Task

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            story = Story(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                          title="부모 스토리")
            s.add(story)
            await s.commit()
            task = Task(id=uuid.uuid4(), org_id=seeded["org_id"], story_id=story.id,
                        title="실 태스크 제목")
            s.add(task)
            await s.commit()
            gate = Gate(id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=task.id,
                        work_item_type="task", gate_type="qa", status="approved")
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate_id}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["project_id"] == str(seeded["project_id"])  # Task는 project_id 컬럼 없음(Story JOIN)
            assert body["work_item_type"] == "task"
            assert body["work_item_summary"]["title"] == "실 태스크 제목"
            assert body["work_item_summary"]["slug"] is None
            assert body["status"] == "approved"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_cold_get_doc_gate_200_all_fields():
    from app.main import app
    from app.models.doc import Doc
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            doc = Doc(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                      title="실 문서 제목", slug="real-doc-slug")
            s.add(doc)
            await s.commit()
            gate = Gate(id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=doc.id,
                        work_item_type="doc", gate_type="doc_approval", status="pending")
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate_id}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["project_id"] == str(seeded["project_id"])
            assert body["work_item_type"] == "doc"
            assert body["work_item_summary"]["title"] == "실 문서 제목"
            assert body["work_item_summary"]["slug"] == "real-doc-slug"

            # 존재하지 않는 gate id → 404
            resp3 = await client.get(f"/api/v2/gates/{uuid.uuid4()}")
            assert resp3.status_code == 404, resp3.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_cold_get_story_gate_summary_none_when_soft_deleted():
    """까심 QA(PR #2253 REQUEST_CHANGES): doc 분기는 Doc.deleted_at.is_(None) 필터가 있는데
    story/task 분기는 없어 soft-delete 된 story/task 를 gate 가 참조하면 stale 유령 title 이
    샌다(doc 과 달리 graceful None 이 아님). story 분기는 soft-delete 후 work_item_summary 가
    None 으로 떨어져야 한다 — gate 자체는 200(project_id 는 resolve_work_item_project_id 가
    deleted_at 무관하게 그대로 해소하므로 채워짐), summary 만 fail-soft."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            story = Story(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                          title="삭제될 스토리 제목")
            s.add(story)
            await s.commit()
            gate = Gate(id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id,
                        work_item_type="story", gate_type="merge", status="pending")
            s.add(gate)
            await s.commit()
            gate_id = gate.id

            # soft-delete
            story.deleted_at = datetime.now(timezone.utc)
            s.add(story)
            await s.commit()

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate_id}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["id"] == str(gate_id)
            assert body["project_id"] == str(seeded["project_id"])  # project_id 는 deleted_at 무관 해소
            assert body["work_item_type"] == "story"
            assert body["work_item_summary"] is None  # soft-delete 된 story → 유령 title 대신 None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_cold_get_task_gate_summary_none_when_soft_deleted():
    """story 케이스와 동형 — task 분기도 soft-delete 시 work_item_summary None."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story, Task

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            story = Story(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                          title="부모 스토리")
            s.add(story)
            await s.commit()
            task = Task(id=uuid.uuid4(), org_id=seeded["org_id"], story_id=story.id,
                        title="삭제될 태스크 제목")
            s.add(task)
            await s.commit()
            gate = Gate(id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=task.id,
                        work_item_type="task", gate_type="qa", status="approved")
            s.add(gate)
            await s.commit()
            gate_id = gate.id

            # soft-delete
            task.deleted_at = datetime.now(timezone.utc)
            s.add(task)
            await s.commit()

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate_id}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["id"] == str(gate_id)
            assert body["project_id"] == str(seeded["project_id"])  # Task 는 컬럼 없음(Story JOIN, deleted_at 무관)
            assert body["work_item_type"] == "task"
            assert body["work_item_summary"] is None  # soft-delete 된 task → 유령 title 대신 None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── list_gates 회귀 없음 ──────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_list_gates_regression_doc_enrich_unaffected_by_project_id_field():
    """GateResponse에 project_id 필드(default None) 추가가 list_gates 의 기존 doc-only enrich
    응답을 깨지 않는지(project_id 는 list에서 채우지 않으므로 그대로 None)."""
    from app.routers import gates as gates_mod
    from app.routers.gates import list_gates

    org, doc_id, pid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    gates_res = MagicMock()
    gates_res.scalars.return_value.all.return_value = [_gate(org, doc_id, "doc")]
    docs_res = MagicMock()
    docs_res.all.return_value = [(doc_id, "설계 문서", "design-doc", pid)]
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[gates_res, docs_res])
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))

    with patch.object(gates_mod, "resolve_member", AsyncMock(side_effect=Exception("no doc_approval enrich needed"))), \
         patch.object(gates_mod, "get_org_posture", AsyncMock(return_value=None)):
        out = await list_gates(work_item_id=None, work_item_type="doc", status="pending",
                               assigned_to_me=False, session=session, org_id=org, auth=auth)

    assert out[0].work_item_summary.title == "설계 문서"
    assert out[0].project_id is None  # list는 project_id 를 채우지 않는다(GET /{id} 전용 enrich)
