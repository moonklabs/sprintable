"""story #4405 — 회고 종합 작업(retro_synthesis): 두 LLM 동안 retro_sessions 행 잠금 · 열린 트랜잭션 0 · 쓰기는 두 LLM 뒤 한 번.

실 PG여야 하는 이유: 행 잠금 대기 · idle in transaction은 mock으로 재현되지 않는다. 워커 본체(`process_due_background_jobs`)를
그대로 돌리되 이 테스트가 넣은 작업만 집게 due 조건을 좁힌다(tests/background_job_helpers.py와 같은 방식 · 비파괴).

- 추천 LLM 도중 다른 세션이 같은 회고 세션을 UPDATE해도 막히지 않고, 그 순간 idle in transaction 연결이 없다
  (예전: 종합을 flush한 채 추천 LLM을 기다려 lock_timeout → RED).
- 같은 배치에 작업 둘 · 첫째에서 추천이 예외 → 첫째만 재시도로 돌아가고 둘째는 정상 완료(배치가 죽지 않음 · 공유 세션 만료 사고 0).
"""
from __future__ import annotations

import asyncio
import os
import threading
import time
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

_SYNTH_RAW = '{"items": [{"text": "온보딩 가설이 반증됐다", "source": "아이템 1"}]}'
_NEXT_RAW = '{"items": [{"statement": "온보딩을 단순화하면 이탈이 준다.", "rationale": "반증", "confidence": 0.5}]}'


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed_retro(Session) -> tuple[uuid.UUID, uuid.UUID]:
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.retro import RetroItem, RetroSession

    async with Session() as s:
        org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
        s.add(org)
        await s.flush()
        project = Project(id=uuid.uuid4(), org_id=org.id, name="p")
        s.add(project)
        await s.flush()
        retro = RetroSession(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="r")
        s.add(retro)
        await s.flush()
        s.add(RetroItem(session_id=retro.id, category="good", text="온보딩 42%", vote_count=3))
        await s.commit()
        return org.id, retro.id


async def _enqueue(Session, org_id, retro_id, mode="synthesis") -> uuid.UUID:
    from app.services.background_jobs import enqueue_background_job

    async with Session() as s:
        job = await enqueue_background_job(
            s, org_id=org_id, kind="retro_synthesis", requested_by_member_id=uuid.uuid4(),
            payload={"session_id": str(retro_id), "mode": mode},
        )
        await s.commit()
        return job.id


async def _run_jobs(Session, job_ids) -> dict:
    """워커 본체를 이 작업들만 집게 좁혀 한 배치로 돌린다."""
    from sqlalchemy import and_

    from app.models.background_job import BackgroundJob
    from app.services import background_jobs as bg

    due = bg._due_filter
    with patch.object(bg, "_due_filter", lambda now: and_(due(now), BackgroundJob.id.in_(list(job_ids)))):
        async with Session() as s:
            return await bg.process_due_background_jobs(s, deadline_monotonic=time.monotonic() + 600)


async def _row(Session, sql, params):
    async with Session() as s:
        return (await s.execute(text(sql), params)).one()


@pytest.mark.anyio
async def test_retro_row_not_locked_and_no_open_transaction_during_recommend_llm():
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        org_id, retro_id = await _seed_retro(Session)
        job_id = await _enqueue(Session, org_id, retro_id)

        started, release = threading.Event(), threading.Event()

        def _llm(prompt, response_schema=None):
            if not started.is_set() and "statement" not in str(response_schema):
                return _SYNTH_RAW  # 종합 LLM
            started.set()  # 추천 LLM — 여기서 멈춰 선다
            assert release.wait(20), "테스트가 LLM을 풀어 주지 않음"
            return _NEXT_RAW

        with patch("app.services.llm_client.generate_text", side_effect=_llm):
            task = asyncio.create_task(_run_jobs(Session, [job_id]))
            try:
                assert await asyncio.to_thread(started.wait, 20), "추천 LLM이 시작되지 않음"
                async with Session() as other:
                    await other.execute(text("SET LOCAL lock_timeout = '2s'"))
                    idle_in_tx = (await other.execute(text(
                        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()"
                        " AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'"
                    ))).scalar_one()
                    await other.execute(text("UPDATE retro_sessions SET title = 'edited' WHERE id = :id"), {"id": retro_id})
                    await other.commit()
            finally:
                release.set()
                counts = await task

        assert idle_in_tx == 0
        assert counts["completed"] == 1
        title, synthesis, next_hypotheses = await _row(
            Session, "SELECT title, synthesis, next_hypotheses FROM retro_sessions WHERE id = :id", {"id": retro_id},
        )
        assert title == "edited"
        assert synthesis["learned"][0]["text"] == "온보딩 가설이 반증됐다"
        assert next_hypotheses and next_hypotheses[0]["statement"].startswith("온보딩을 단순화")
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_recommend_exception_in_first_job_does_not_kill_the_second_in_same_batch():
    """첫째 작업의 추천이 예외 → 첫째는 롤백 · 재시도 대기(종합도 저장 안 됨 · 예전과 같음). 둘째는 같은 배치에서 정상 완료."""
    from app.services import retro_synthesis as svc

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        org_a, retro_a = await _seed_retro(Session)
        org_b, retro_b = await _seed_retro(Session)
        job_a = await _enqueue(Session, org_a, retro_a)
        await asyncio.sleep(0.01)  # created_at 순서 — 워커는 오래된 것부터
        job_b = await _enqueue(Session, org_b, retro_b)

        recommend = AsyncMock(side_effect=[RuntimeError("recommend outage"), [{"statement": "다음", "rationale": "r", "confidence": 0.5}]])
        with patch("app.services.llm_client.generate_text", return_value=_SYNTH_RAW), \
             patch.object(svc, "recommend_next", new=recommend):
            counts = await _run_jobs(Session, [job_a, job_b])

        assert (counts["retry"], counts["completed"]) == (1, 1)
        status_a, attempt_a = await _row(Session, "SELECT status, attempt_count FROM background_jobs WHERE id = :id", {"id": job_a})
        status_b, = await _row(Session, "SELECT status FROM background_jobs WHERE id = :id", {"id": job_b})
        assert (status_a, attempt_a, status_b) == ("pending", 1, "completed")
        synth_a, = await _row(Session, "SELECT synthesis FROM retro_sessions WHERE id = :id", {"id": retro_a})
        synth_b, next_b = await _row(Session, "SELECT synthesis, next_hypotheses FROM retro_sessions WHERE id = :id", {"id": retro_b})
        assert synth_a is None
        assert synth_b["learned"] and next_b[0]["statement"] == "다음"
    finally:
        await engine.dispose()
