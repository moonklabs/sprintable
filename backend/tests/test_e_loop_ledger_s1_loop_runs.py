"""E-LOOP-LEDGER S1(story e333e8b1): loop_runs 척추 테이블 검증.

DB env(ALEMBIC_DATABASE_URL) 없으면 realdb 파트 skip — status FSM 단위 테스트는 DB 불요."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.loop import LOOP_RUN_STATUSES, is_valid_transition

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── status FSM: legal + illegal 양방향(비-tautological — 까심 QA 사전 요구) ──────


def test_transition_table_legal_sequential():
    assert is_valid_transition("draft", "briefing")
    assert is_valid_transition("briefing", "generating")
    assert is_valid_transition("generating", "deciding")
    assert is_valid_transition("deciding", "executing")
    assert is_valid_transition("executing", "measuring")
    assert is_valid_transition("measuring", "closed")


def test_transition_table_legal_abandon_from_any_non_terminal():
    for s in ("draft", "briefing", "generating", "deciding", "executing", "measuring"):
        assert is_valid_transition(s, "abandoned"), f"{s}->abandoned should be legal"


def test_transition_table_illegal_skips():
    # 순차 스킵 — briefing 건너뛰고 generating으로 바로는 금지.
    assert not is_valid_transition("draft", "generating")
    assert not is_valid_transition("draft", "deciding")
    assert not is_valid_transition("briefing", "executing")


def test_transition_table_illegal_backward():
    assert not is_valid_transition("briefing", "draft")
    assert not is_valid_transition("measuring", "executing")
    assert not is_valid_transition("closed", "measuring")


def test_transition_table_illegal_from_terminal():
    # closed/abandoned=terminal — 어디로도 전이 불가(자기 자신 포함).
    for terminal in ("closed", "abandoned"):
        for target in LOOP_RUN_STATUSES:
            assert not is_valid_transition(terminal, target), f"{terminal}->{target} should be illegal"


def test_transition_table_illegal_into_terminal_twice():
    # closed/abandoned로의 재진입(이미 terminal인 상태에서)은 위 테스트로 커버됨 — 여기선
    # terminal이 아닌 상태에서 abandoned/closed 외의 다른 terminal로 직행 금지 확인.
    assert not is_valid_transition("draft", "closed")  # closed는 measuring에서만 도달
    assert not is_valid_transition("briefing", "closed")


def test_loop_run_statuses_matches_check_constraint_values():
    assert LOOP_RUN_STATUSES == {
        "draft", "briefing", "generating", "deciding", "executing", "measuring", "closed", "abandoned",
    }


# ── realdb: 모델 제약 실증 ────────────────────────────────────────────────────


@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
@pytest.mark.anyio
async def test_status_check_constraint_rejects_invalid_value():
    from app.models.loop import LoopRun

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = uuid.uuid4()
            project_id = await _seed_project(session, org_id)
            run = LoopRun(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id,
                title="test loop", status="not_a_real_status",
                created_by_member_id=uuid.uuid4(),
            )
            session.add(run)
            with pytest.raises(IntegrityError):
                await session.flush()
            await session.rollback()
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
@pytest.mark.anyio
async def test_parent_loop_id_cannot_reference_self():
    from app.models.loop import LoopRun

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = uuid.uuid4()
            project_id = await _seed_project(session, org_id)
            loop_id = uuid.uuid4()
            run = LoopRun(
                id=loop_id, org_id=org_id, project_id=project_id,
                parent_loop_id=loop_id,  # 자기 자신 참조 — CHECK 위반이어야
                title="self-parent loop", created_by_member_id=uuid.uuid4(),
            )
            session.add(run)
            with pytest.raises(IntegrityError):
                await session.flush()
            await session.rollback()
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
@pytest.mark.anyio
async def test_create_and_read_loop_run_defaults():
    from app.models.loop import LoopRun
    from sqlalchemy import select

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = uuid.uuid4()
            project_id = await _seed_project(session, org_id)
            run_id = uuid.uuid4()
            member_id = uuid.uuid4()
            run = LoopRun(
                id=run_id, org_id=org_id, project_id=project_id,
                title="my first loop", created_by_member_id=member_id,
            )
            session.add(run)
            await session.commit()

            fetched = (
                await session.execute(select(LoopRun).where(LoopRun.id == run_id))
            ).scalar_one()
            assert fetched.status == "draft"  # server_default
            assert fetched.goal_tags == []  # server_default '{}'
            assert fetched.outcome_snapshot is None
            assert fetched.outcome_attributed_at is None
            assert fetched.parent_loop_id is None
            assert fetched.chosen_artifact_id is None
            assert fetched.deleted_at is None
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")
@pytest.mark.anyio
async def test_parent_loop_lineage_and_set_null_on_parent_delete():
    from app.models.loop import LoopRun
    from sqlalchemy import select

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = uuid.uuid4()
            project_id = await _seed_project(session, org_id)
            member_id = uuid.uuid4()
            parent_id = uuid.uuid4()
            child_id = uuid.uuid4()
            session.add(LoopRun(
                id=parent_id, org_id=org_id, project_id=project_id,
                title="parent loop", created_by_member_id=member_id,
            ))
            await session.flush()
            session.add(LoopRun(
                id=child_id, org_id=org_id, project_id=project_id,
                parent_loop_id=parent_id, title="child loop",
                created_by_member_id=member_id,
            ))
            await session.commit()

            # 하드 delete(정상 경로는 soft-delete지만, ON DELETE SET NULL 실증엔 실 DELETE 필요).
            await session.execute(text("DELETE FROM loop_runs WHERE id = :id"), {"id": parent_id})
            await session.commit()

            child = (
                await session.execute(select(LoopRun).where(LoopRun.id == child_id))
            ).scalar_one()
            assert child.parent_loop_id is None  # CASCADE 아닌 SET NULL — 자식 생존
    finally:
        await engine.dispose()


async def _seed_project(session, org_id: uuid.UUID) -> uuid.UUID:
    project_id = uuid.uuid4()
    now = datetime.now(timezone.utc)
    await session.execute(
        text(
            "INSERT INTO organizations (id, name, slug, created_at) "
            "VALUES (:org_id, 'Loop Test Org', :slug, :now) ON CONFLICT (id) DO NOTHING"
        ),
        {"org_id": org_id, "slug": f"loop-test-{org_id}", "now": now},
    )
    await session.execute(
        text(
            "INSERT INTO projects (id, org_id, name) VALUES (:pid, :org_id, 'Loop Test Project')"
        ),
        {"pid": project_id, "org_id": org_id},
    )
    await session.commit()
    return project_id
