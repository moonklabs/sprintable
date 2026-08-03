"""story #2346 AC3(범위: 기록만, AC7 차단 없음 — agent_runs.py 모듈 상단 코멘트 참조) —
update_agent_run이 result_summary/last_error_code 길이 변화를 agent_run_updated activity log에
얹는지. stories.py/docs.py와 달리 이 라우터는 상태전이(완료 시 요약 축약이 legitimate)와
얽혀 있어 급감 차단(AC7)을 의도적으로 넣지 않았다 — 그 판단 자체를 여기서도 실측으로
고정한다(양성 대조: 완료 요약 축약이 막히지 «않는다»).
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("ab930000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("ab930000-0000-0000-0000-000000000002")
RUN = uuid.UUID("ab930000-0000-0000-0000-000000000003")
AGENT_IN = uuid.UUID("ab930000-0000-0000-0000-0000000000a1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _auth() -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(AGENT_IN), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(ORG),
    )


async def _seed(s, initial_result_summary: str | None) -> None:
    for sql in [
        f"DELETE FROM activity_logs WHERE org_id='{ORG}'",
        f"DELETE FROM agent_runs WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','2346RUN','s2346-run-org','free')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ}','{ORG}','P','none')",
        f"INSERT INTO members (id,org_id,type,name) VALUES ('{AGENT_IN}','{ORG}','agent','AgentIn')",
        f"INSERT INTO project_access (project_id,member_id,permission) VALUES ('{PROJ}','{AGENT_IN}','granted')",
    ]:
        await s.execute(text(sql))
    await s.execute(
        text(
            "INSERT INTO agent_runs (id,org_id,project_id,agent_id,trigger,status,result_summary) "
            "VALUES (:id,:org,:proj,:agent,'manual','running',:summary)"
        ),
        {"id": RUN, "org": ORG, "proj": PROJ, "agent": AGENT_IN, "summary": initial_result_summary},
    )
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _fetch_latest_agent_run_updated_context(Session):
    async with Session() as s:
        row = (
            await s.execute(
                text(
                    "SELECT context FROM activity_logs WHERE org_id=:org AND action='agent_run_updated' "
                    "ORDER BY created_at DESC LIMIT 1"
                ),
                {"org": ORG},
            )
        ).scalar_one_or_none()
        return row


@pytest.mark.anyio
async def test_shrinking_result_summary_records_before_after_length():
    """AC3 핵심 — result_summary 급감이 agent_run_updated activity의 length_changes에 남는다."""
    from app.repositories.agent_run import AgentRunRepository
    from app.routers.agent_runs import update_agent_run
    from app.schemas.agent_run import UpdateAgentRun

    eng, Session = await _engine()
    try:
        long_summary = "working on step 1... step 2... step 3... " * 20  # ~880자
        async with Session() as s:
            await _seed(s, long_summary)

        async with Session() as s:
            repo = AgentRunRepository(s)
            bg = BackgroundTasks()
            short_summary = "done"
            await update_agent_run(
                RUN, UpdateAgentRun(status="running", result_summary=short_summary), bg,
                org_id=ORG, auth=_auth(), repo=repo,
            )
            await bg()

        context = await _fetch_latest_agent_run_updated_context(Session)
        assert context is not None, "agent_run_updated activity가 안 남음"
        assert context["length_changes"]["result_summary"] == {
            "before": len(long_summary), "after": len(short_summary),
        }
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_ac7_is_intentionally_absent_completion_summary_shrink_not_blocked():
    """양성 대조 — 이 판정 자체를 실측으로 고정한다: 진행요약이 완료시 짧은 확정 요약으로
    -90%대까지 줄어도 차단되지 않는다(stories.py/docs.py였다면 AC7에 걸렸을 규모).
    agent_runs.py에 AC7을 안 넣기로 한 판단이 실제로 지켜지는지 재는 것 — 나중에 실수로
    누가 AC7을 이식하면 이 테스트가 RED로 그 변경을 잡아낸다."""
    from app.repositories.agent_run import AgentRunRepository
    from app.routers.agent_runs import update_agent_run
    from app.schemas.agent_run import UpdateAgentRun

    eng, Session = await _engine()
    try:
        long_progress_summary = "x" * 900
        async with Session() as s:
            await _seed(s, long_progress_summary)

        async with Session() as s:
            repo = AgentRunRepository(s)
            bg = BackgroundTasks()
            final_summary = "Completed successfully"  # -97%대, allow_shrink 없이 호출
            resp = await update_agent_run(
                RUN, UpdateAgentRun(status="completed", result_summary=final_summary), bg,
                org_id=ORG, auth=_auth(), repo=repo,
            )
            assert resp.result_summary == final_summary
            assert resp.status == "completed"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_unchanged_length_does_not_pollute_the_log():
    """양성 대조 — result_summary를 같은 길이의 다른 텍스트로 바꾸면 activity 자체가 안 남는다
    (agent_runs.py도 사전 존재하던 로그가 없어 docs.py와 동형 — 엔트리 자체가 없어야 정상)."""
    from app.repositories.agent_run import AgentRunRepository
    from app.routers.agent_runs import update_agent_run
    from app.schemas.agent_run import UpdateAgentRun

    eng, Session = await _engine()
    try:
        original = "a" * 50
        async with Session() as s:
            await _seed(s, original)

        async with Session() as s:
            repo = AgentRunRepository(s)
            bg = BackgroundTasks()
            same_length_different_text = "b" * 50
            await update_agent_run(
                RUN, UpdateAgentRun(status="running", result_summary=same_length_different_text), bg,
                org_id=ORG, auth=_auth(), repo=repo,
            )
            await bg()

        context = await _fetch_latest_agent_run_updated_context(Session)
        assert context is None, f"길이가 안 변했는데 activity가 남음(잡음): {context}"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_status_only_update_without_result_summary_not_logged():
    """양성 대조 — result_summary/last_error_code를 아예 안 건드리고 status만 바꾸면 activity
    자체가 안 남는다(AC1의 exclude_unset 회귀 감시도 겸함 — 생략됐으면 old_lengths가 비어야 함)."""
    from app.repositories.agent_run import AgentRunRepository
    from app.routers.agent_runs import update_agent_run
    from app.schemas.agent_run import UpdateAgentRun

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, "unchanged summary")

        async with Session() as s:
            repo = AgentRunRepository(s)
            bg = BackgroundTasks()
            await update_agent_run(
                RUN, UpdateAgentRun(status="running"), bg, org_id=ORG, auth=_auth(), repo=repo,
            )
            await bg()

        context = await _fetch_latest_agent_run_updated_context(Session)
        assert context is None, f"result_summary 안 건드렸는데 activity가 남음: {context}"

        # AC1 회귀 감시 겸용 — result_summary가 그대로 살아 있어야 한다(생략=불변).
        async with Session() as s:
            row = (await s.execute(
                text("SELECT result_summary FROM agent_runs WHERE id=:i"), {"i": RUN}
            )).scalar_one()
            assert row == "unchanged summary", "생략했는데 result_summary가 지워짐(AC1 회귀)"
    finally:
        await eng.dispose()
