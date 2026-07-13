"""E-UI-DAEGBYEON [P0-04 후속](story 9ef0f914) — story.trust_stage_changed org publish → FE
event-stream(`_agent_connections[member_id]`) 브릿지. 실 PG.

PO 가드레일(2026-07-13): ①Event row 생성 0(순수 transient push) ②멤버 해소는 단일 배치 쿼리.
crux = 인가 경계 — project 접근 가능 member만 수신, cross-project 미수신은 하드 게이트.
"""
from __future__ import annotations

import asyncio
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


@pytest.fixture(autouse=True)
def _clear_agent_connections():
    """모듈 전역 레지스트리 — 테스트 간 격리(누수 0)."""
    from app.routers import events as ev
    ev._agent_connections.clear()
    yield
    ev._agent_connections.clear()


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
    """org + project_a/project_b + human member_a(project_a grant)·member_b(project_b grant) +
    story(in-review, project_a) + gate(merge, pending) — approve 트리거로 trust_stage 전환."""
    from app.models.gate import Gate
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="B")
    session.add_all([project_a, project_b])
    await session.commit()

    member_a = Member(id=uuid.uuid4(), org_id=org.id, type="human", name="Member A")
    member_b = Member(id=uuid.uuid4(), org_id=org.id, type="human", name="Member B")
    session.add_all([member_a, member_b])
    await session.commit()
    session.add_all([
        ProjectAccess(id=uuid.uuid4(), project_id=project_a.id, member_id=member_a.id, permission="granted"),
        ProjectAccess(id=uuid.uuid4(), project_id=project_b.id, member_id=member_b.id, permission="granted"),
    ])
    await session.commit()

    from app.models.pm import Story
    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="S", status="in-review")
    session.add(story)
    await session.commit()
    gate = Gate(
        id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
        gate_type="merge", status="pending",
    )
    session.add(gate)
    await session.commit()

    return {
        "org_id": org.id, "project_a": project_a.id, "project_b": project_b.id,
        "member_a": member_a.id, "member_b": member_b.id,
        "story_id": story.id, "gate_id": gate.id, "resolver_id": member_a.id,
    }


@pytest.mark.anyio
async def test_project_scoped_member_receives_transient_push_no_event_row():
    """project_a 접근 member_a(연결 中)는 story.trust_stage_changed를 큐로 직접 수신 —
    Event row 생성 0(가드레일①)."""
    from app.models.event import Event
    from app.routers import events as ev
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        queue_a: asyncio.Queue = asyncio.Queue()
        ev._agent_connections[str(seeded["member_a"])].add(queue_a)

        async with Session() as s:
            await transition_gate(s, seeded["org_id"], seeded["gate_id"], "approved", resolver_id=seeded["resolver_id"])
            await s.commit()

        assert not queue_a.empty(), "member_a(project_a 접근)가 push를 못 받음"
        payload = queue_a.get_nowait()
        assert payload["event_type"] == "story.trust_stage_changed"
        assert payload["story_id"] == str(seeded["story_id"])
        assert payload["project_id"] == str(seeded["project_a"])

        # 가드레일①: 이 story에 대한 Event row가 생성되지 않았어야 함(순수 transient push).
        async with Session() as s:
            rows = (await s.execute(
                Event.__table__.select().where(Event.event_type == "story.trust_stage_changed")
            )).all()
            assert rows == [], f"Event row가 생성됨(가드레일①위반): {rows}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cross_project_member_does_not_receive_push_hard_gate():
    """하드 게이트(PO 지시) — project_b 접근 member_b는 project_a 이벤트를 절대 못 받는다."""
    from app.routers import events as ev
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        queue_a: asyncio.Queue = asyncio.Queue()
        queue_b: asyncio.Queue = asyncio.Queue()
        ev._agent_connections[str(seeded["member_a"])].add(queue_a)
        ev._agent_connections[str(seeded["member_b"])].add(queue_b)

        async with Session() as s:
            await transition_gate(s, seeded["org_id"], seeded["gate_id"], "approved", resolver_id=seeded["resolver_id"])
            await s.commit()

        assert not queue_a.empty()
        assert queue_b.empty(), "cross-project 누설 — member_b(project_b)가 project_a 이벤트를 받음"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_disconnected_member_silently_skipped_no_crash():
    """project_a 접근이지만 연결 안 된 member(큐 미등록) — 조용히 스킵(예외 없음)."""
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        # _agent_connections에 아무도 등록 안 함 — 전원 미연결.
        async with Session() as s:
            gate = await transition_gate(s, seeded["org_id"], seeded["gate_id"], "approved", resolver_id=seeded["resolver_id"])
            await s.commit()
        assert gate.status == "approved"  # 크래시 없이 정상 완료.
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_batch_member_resolution_single_query():
    """가드레일② — project_accessible_member_ids가 단일 쿼리(N+1 아님)로 배치 해소."""
    from unittest.mock import patch

    from app.services.project_auth import project_accessible_member_ids

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        async with Session() as s:
            call_count = {"n": 0}
            _orig_execute = s.execute

            async def _counting_execute(*args, **kwargs):
                call_count["n"] += 1
                return await _orig_execute(*args, **kwargs)

            with patch.object(s, "execute", side_effect=_counting_execute):
                result = await project_accessible_member_ids(s, seeded["org_id"], seeded["project_a"])
            assert call_count["n"] == 1, f"단일 쿼리여야 함(실측 {call_count['n']}회)"
            assert result == {seeded["member_a"]}
    finally:
        await engine.dispose()
