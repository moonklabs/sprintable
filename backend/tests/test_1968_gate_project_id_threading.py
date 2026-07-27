"""story #1968 (P1a-S3 잔여): create_gate() 3개 호출부 project_id threading + override_gate
sr=None 폴백 — gate.pending_approval/gate_overridden 딥링크 매니페스트 project_id_included
31/33 → 33/33 승격 근거.

배경: `Gate` 모델 자체엔 project_id 컬럼이 없다(org_id + work_item_id/work_item_type 폴리모픽
참조뿐). `create_gate()` 7개 호출부 중 4개(visual_artifacts.py·doc.py·
workflow_parallel_approval.py·loop.py)는 이미 project_id를 threading했고, 나머지 3개
(routers/gates.py 제네릭 생성·workflow_line_config.py·merge_verdict_gate.py)가 미threading
이었다 — 이 스토리가 마무리한다. `override_gate()`(gate_overridden 알림)의 sr(활성
step_run)=None 폴백도 `gate_service.resolve_work_item_project_id()`로 project_id 0이었던
갭을 닫는다.

테스트 구성:
- resolve_work_item_project_id 타입별 분기(story/task/doc/미인식) — mocked session, 신규 쿼리
  없이 검증(요청 순수 로직).
- routers/gates.py 제네릭 create_gate_endpoint — mocked session, project_id 조회→threading 확인.
- merge_verdict_gate.evaluate_merge_gate — mocked cage 의존성, project_id threading 확인.
- workflow_line_config.request_publish — 실 Postgres(org-level None·project-level 값 둘 다).
- gate_service.override_gate — 실 Postgres, sr=None 폴백이 실제로 project_id를 조회하는지 확인.
"""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# 이 파일은 workflow_line_config/override_gate 실 DB 테스트에서 Base.metadata.create_all을
# 호출한다 — conftest.py의 AST 가드(story 8236bbc3)가 마커 누락을 즉시 UsageError로 표면화한다.
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _scalar_result(value):
    r = MagicMock()
    r.scalar_one_or_none.return_value = value
    return r


# ── resolve_work_item_project_id: 타입별 분기 (mocked session — 신규 쿼리 최소 원칙 검증) ──


@pytest.mark.anyio
async def test_resolve_project_id_story_type():
    from app.services.gate_service import resolve_work_item_project_id

    org_id, story_id, project_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalar_result(project_id))

    result = await resolve_work_item_project_id(session, org_id, "story", story_id)

    assert result == project_id
    session.execute.assert_awaited_once()


@pytest.mark.anyio
async def test_resolve_project_id_doc_type():
    from app.services.gate_service import resolve_work_item_project_id

    org_id, doc_id, project_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalar_result(project_id))

    result = await resolve_work_item_project_id(session, org_id, "doc", doc_id)

    assert result == project_id
    session.execute.assert_awaited_once()


@pytest.mark.anyio
async def test_resolve_project_id_task_type_joins_story():
    """Task 는 project_id 컬럼이 없어(story_id만 보유) Story JOIN 경유로 조회한다."""
    from app.services.gate_service import resolve_work_item_project_id

    org_id, task_id, project_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalar_result(project_id))

    result = await resolve_work_item_project_id(session, org_id, "task", task_id)

    assert result == project_id
    session.execute.assert_awaited_once()


@pytest.mark.anyio
async def test_resolve_project_id_unknown_type_returns_none_no_query():
    """미인식 work_item_type(예: 조직-레벨 'wf_line_version')은 신규 쿼리 없이 즉시 None —
    silent 실패가 아니라 구조적으로 project-scoped 가 아닐 수 있다는 정직한 신호."""
    from app.services.gate_service import resolve_work_item_project_id

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=AssertionError("미인식 타입은 쿼리하면 안 됨"))

    result = await resolve_work_item_project_id(session, uuid.uuid4(), "wf_line_version", uuid.uuid4())

    assert result is None
    session.execute.assert_not_awaited()


# ── routers/gates.py 제네릭 생성 엔드포인트 ──────────────────────────────────────


@pytest.mark.anyio
async def test_generic_gate_endpoint_threads_resolved_project_id():
    """POST /api/v2/gates(work_item_type='story')가 project_id를 조회해 create_gate로
    넘겨야 한다(story #1968 스코프①)."""
    from app.routers import gates as gates_mod
    from app.routers.gates import GateCreateRequest, create_gate_endpoint

    org_id, work_item_id, project_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    session = AsyncMock()
    session.commit = AsyncMock()
    gate = SimpleNamespace(id=uuid.uuid4(), status="pending")
    body = GateCreateRequest(
        work_item_id=work_item_id, work_item_type="story", gate_type="merge",
        member_id=uuid.uuid4(), role_id=uuid.uuid4(),
    )

    with patch.object(gates_mod, "resolve_work_item_project_id",
                       AsyncMock(return_value=project_id)) as resolve_spy, \
         patch.object(gates_mod, "create_gate", AsyncMock(return_value=gate)) as create_spy, \
         patch.object(gates_mod.GateResponse, "model_validate", lambda g: "OK"):
        await create_gate_endpoint(body=body, session=session, org_id=org_id, _auth=SimpleNamespace())

    resolve_spy.assert_awaited_once_with(session, org_id, "story", work_item_id)
    assert create_spy.await_args.kwargs["project_id"] == project_id


@pytest.mark.anyio
async def test_generic_gate_endpoint_unresolvable_type_passes_none():
    """미인식 work_item_type이면 project_id=None 그대로 넘어간다(크래시 아님 — best-effort)."""
    from app.routers import gates as gates_mod
    from app.routers.gates import GateCreateRequest, create_gate_endpoint

    org_id, work_item_id = uuid.uuid4(), uuid.uuid4()
    session = AsyncMock()
    session.commit = AsyncMock()
    gate = SimpleNamespace(id=uuid.uuid4(), status="pending")
    body = GateCreateRequest(
        work_item_id=work_item_id, work_item_type="mystery_type", gate_type="qa",
        member_id=uuid.uuid4(), role_id=uuid.uuid4(),
    )

    with patch.object(gates_mod, "resolve_work_item_project_id",
                       AsyncMock(return_value=None)), \
         patch.object(gates_mod, "create_gate", AsyncMock(return_value=gate)) as create_spy, \
         patch.object(gates_mod.GateResponse, "model_validate", lambda g: "OK"):
        await create_gate_endpoint(body=body, session=session, org_id=org_id, _auth=SimpleNamespace())

    assert create_spy.await_args.kwargs["project_id"] is None


# ── merge_verdict_gate.py evaluate_merge_gate ────────────────────────────────


@pytest.mark.anyio
async def test_merge_gate_threads_resolved_project_id():
    """evaluate_merge_gate는 story_id(uuid)만 갖고 있어(Story 객체 미로드)
    resolve_work_item_project_id("story", story_id)로 신규 조회 후 create_gate에 넘겨야 한다."""
    from app.services import merge_verdict_gate as mvg

    org_id, story_id, project_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    session = AsyncMock()
    part = SimpleNamespace(member_id=uuid.uuid4(), role_id=uuid.uuid4())
    gate = SimpleNamespace(id=uuid.uuid4(), status="auto_passed")

    with patch.object(mvg, "resolve_implementation_participation", AsyncMock(return_value=part)), \
         patch.object(mvg, "_role_key", AsyncMock(return_value="implementation")), \
         patch.object(mvg, "capture_pr_ci_verdict",
                       AsyncMock(return_value={"recorded": ["pr"], "skipped_reason": None})), \
         patch.object(mvg, "compute_member_trust_scores",
                       AsyncMock(return_value={"scores": [{
                           "role_key": "implementation", "hit": 90, "resolved": 100,
                           "pending": 0, "hit_rate": 0.9}]})), \
         patch.object(mvg, "resolve_work_item_project_id",
                       AsyncMock(return_value=project_id)) as resolve_spy, \
         patch.object(mvg, "create_gate", AsyncMock(return_value=gate)) as create_spy:
        await mvg.evaluate_merge_gate(
            session, org_id, story_id, pr_number=1, repo="o/r", ci_result="pass",
        )

    resolve_spy.assert_awaited_once_with(session, org_id, "story", story_id)
    assert create_spy.await_args.kwargs["project_id"] == project_id


# ── workflow_line_config.py request_publish (실 Postgres) ───────────────────────


def _clean_wf_config() -> dict:
    return {
        "name": "line",
        "steps": [{
            "step_key": "s", "step_type": "merge-gate", "from_status": "a", "to_status": "b",
            "step_order": 1,
            "approval_policy": {"approvers": ["role:po"], "self_approval": "forbid"},
            "assignee_policy": {"role": "po", "deputy": "role:lead"},
            "routing_rules": [{"mode": "all", "conditions": [
                {"field": "trust_score", "op": "gte", "value": 0.8}], "decision": "auto_route"}],
            "sla_policy": {"timeout_minutes": 60, "on_timeout": "escalate"},
        }],
    }


async def _wfc_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401 — 전 모델 메타데이터 로드

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_workflow_line_config_project_level_threads_version_project_id():
    """project-level workflow line config publish gate는 version.project_id(이미 로드된
    엔티티 — 신규 쿼리 0)가 create_gate로 그대로 실린다."""
    from app.models.participation import ParticipationRole
    from app.services import workflow_line_config as wlc_mod
    from app.services.workflow_line_config import create_draft, request_publish

    engine, Session = await _wfc_session()
    org_id, project_id, member = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    async with Session() as session:
        session.add(ParticipationRole(
            id=uuid.uuid4(), org_id=org_id, key="default", label="Default", is_default=True))
        await session.flush()
        version = await create_draft(session, org_id, project_id, "story", _clean_wf_config(), member)

        captured: dict = {}
        real_create_gate = wlc_mod.create_gate

        async def _spy(*a, **k):
            captured.update(k)
            return await real_create_gate(*a, **k)

        with patch.object(wlc_mod, "create_gate", side_effect=_spy):
            await request_publish(session, org_id, version, member)

        assert captured.get("project_id") == project_id
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_workflow_line_config_org_level_version_project_id_is_none():
    """org-level workflow line config(project_id=None)는 None 그대로 threading된다 — 이건
    미해결 갭이 아니라 구조적으로 project 무관(org 전체 config)이라는 정직한 값이다."""
    from app.models.participation import ParticipationRole
    from app.services import workflow_line_config as wlc_mod
    from app.services.workflow_line_config import create_draft, request_publish

    engine, Session = await _wfc_session()
    org_id, member = uuid.uuid4(), uuid.uuid4()
    async with Session() as session:
        session.add(ParticipationRole(
            id=uuid.uuid4(), org_id=org_id, key="default", label="Default", is_default=True))
        await session.flush()
        version = await create_draft(session, org_id, None, "story", _clean_wf_config(), member)

        captured: dict = {}
        real_create_gate = wlc_mod.create_gate

        async def _spy(*a, **k):
            captured.update(k)
            return await real_create_gate(*a, **k)

        with patch.object(wlc_mod, "create_gate", side_effect=_spy):
            await request_publish(session, org_id, version, member)

        assert "project_id" in captured and captured["project_id"] is None
    await engine.dispose()


# ── gate_service.py override_gate — sr(활성 step_run)=None 폴백 (실 Postgres) ───────


async def _override_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.participation  # noqa: F401
    import app.models.workflow_line  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_override_gate_no_active_step_run_falls_back_to_resolved_project_id():
    """story #1968: override_gate의 gate_overridden 알림이 sr(활성 step_run)=None이어도
    gate.work_item_type/work_item_id로 project_id를 조회해 dispatch_notification에 싣는다
    (이전엔 sr=None → source_project_id=None 고정 갭 — story #1953 주석 참고)."""
    from app.models.gate import Gate
    from app.models.pm import Story
    from app.models.project import Project
    from app.models.workflow_line import WorkflowLineStepApproval
    from app.services.gate_service import override_gate

    engine, Session = await _override_session()
    org_id, project_id, story_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    requester, approver, owner = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

    async with Session() as session:
        session.add(Project(id=project_id, org_id=org_id, name="p"))
        await session.flush()
        session.add(Story(id=story_id, org_id=org_id, project_id=project_id, title="s"))
        await session.flush()
        gate = Gate(id=uuid.uuid4(), org_id=org_id, work_item_id=story_id,
                     work_item_type="story", gate_type="merge", status="pending")
        session.add(gate)
        await session.flush()
        # 의도적으로 WorkflowLineStepRun을 만들지 않는다 — find_active_step_run_for_gate가
        # 항상 None을 반환하는 상황(활성 step_run 없음)을 재현한다. step_run_id는 FK 제약이
        # 없는 평문 UUID 컬럼이라 존재하지 않는 값을 넣어도 approver row는 유효하다.
        session.add(WorkflowLineStepApproval(
            org_id=org_id, project_id=project_id, step_run_id=uuid.uuid4(), gate_id=gate.id,
            approval_group_id=uuid.uuid4(), approver_member_id=approver, approver_member_type="human",
            kind="approver", blocking=True, status="pending", requested_by_member_id=requester,
        ))
        await session.commit()

        captured: dict = {}

        async def _capture(*a, **k):
            captured.update(k)

        with patch(
            "app.services.notification_dispatch.dispatch_notification",
            AsyncMock(side_effect=_capture),
        ):
            result = await override_gate(session, org_id, gate.id, owner, "approved", "강제 승인")
            await session.commit()

        assert result.status == "approved"
        assert captured.get("event_type") == "gate_overridden"
        assert captured.get("source_project_id") == project_id
    await engine.dispose()
