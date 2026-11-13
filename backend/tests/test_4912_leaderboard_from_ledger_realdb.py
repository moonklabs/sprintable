"""4912 (PO 11-13) — the all-time reward board is the ledger's own sum (no `reward_balances` view).

`GET /api/v2/rewards/leaderboard?period=all` read a materialized view `reward_balances` that was defined only in a Supabase migration (packages/db/supabase) and never in alembic: every database built by alembic
(dev · CI · a fresh install) answered 500 («relation "reward_balances" does not exist»). The unit tests mock the repository, so nothing saw it; the web's statistics screen swallowed the error and drew «0 TJSB».
These tests run against a REAL database built by alembic: the answer is 200, each member's balance is `SUM(amount)` of the ledger (what the old view held), highest first; an empty ledger is an empty list (200);
the cursor pages by balance; another organization's ledger rows never count.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


async def _add_ledger(session, org_id, project_id, member_id, amount, reason="시험"):
    from app.models.reward import RewardLedger

    session.add(RewardLedger(id=uuid.uuid4(), org_id=org_id, project_id=project_id, member_id=member_id, amount=amount, reason=reason))
    await session.commit()


async def _board(app, Session, user, org_id, project_id, extra=""):
    await _setup_app_human(app, Session, user, org_id)
    try:
        async with _client_for(app) as client:
            return await client.get(f"/api/v2/rewards/leaderboard?project_id={project_id}&period=all{extra}")
    finally:
        app.dependency_overrides.clear()


async def _room(Session):
    """an org with a project and three members (A asks; B, C earn)"""
    async with Session() as session:
        org = await _make_org(session)
        project = await _make_project(session, org.id)
        a_id, a_user = await _make_human_member(session, org.id, project.id)
        b_id, _ = await _make_human_member(session, org.id, project.id)
        c_id, _ = await _make_human_member(session, org.id, project.id)
    return org.id, project.id, a_user, b_id, c_id


async def test_the_all_time_board_is_the_ledger_sum_highest_first_and_answers_200():
    engine, Session = await _session_factory()
    try:
        org_id, project_id, a_user, b_id, c_id = await _room(Session)
        async with Session() as session:
            await _add_ledger(session, org_id, project_id, b_id, 50)
            await _add_ledger(session, org_id, project_id, b_id, 30)
            await _add_ledger(session, org_id, project_id, b_id, -10)  # a deduction counts (the old view summed every row)
            await _add_ledger(session, org_id, project_id, c_id, 100)
        from app.main import app

        r = await _board(app, Session, a_user, org_id, project_id)
        assert r.status_code == 200, f"the board must not need a database view: {r.status_code} {r.text}"
        rows = r.json()["data"] if isinstance(r.json(), dict) and "data" in r.json() else r.json()
        assert [(str(x["member_id"]), x["balance"]) for x in rows] == [(str(c_id), 100.0), (str(b_id), 70.0)], rows
    finally:
        await engine.dispose()


async def test_an_empty_ledger_is_an_empty_list_not_an_error():
    engine, Session = await _session_factory()
    try:
        org_id, project_id, a_user, b_id, c_id = await _room(Session)
        from app.main import app

        r = await _board(app, Session, a_user, org_id, project_id)
        assert r.status_code == 200, r.text
        rows = r.json()["data"] if isinstance(r.json(), dict) and "data" in r.json() else r.json()
        assert rows == []
    finally:
        await engine.dispose()


async def test_the_cursor_pages_by_balance():
    engine, Session = await _session_factory()
    try:
        org_id, project_id, a_user, b_id, c_id = await _room(Session)
        async with Session() as session:
            await _add_ledger(session, org_id, project_id, b_id, 70)
            await _add_ledger(session, org_id, project_id, c_id, 100)
        from app.main import app

        r = await _board(app, Session, a_user, org_id, project_id, "&cursor=100")
        assert r.status_code == 200, r.text
        rows = r.json()["data"] if isinstance(r.json(), dict) and "data" in r.json() else r.json()
        assert [(str(x["member_id"]), x["balance"]) for x in rows] == [(str(b_id), 70.0)], rows  # only the balances BELOW the cursor
    finally:
        await engine.dispose()


async def test_another_organizations_ledger_rows_never_count():
    engine, Session = await _session_factory()
    try:
        org_id, project_id, a_user, b_id, c_id = await _room(Session)
        async with Session() as session:
            other = await _make_org(session)
            await _add_ledger(session, org_id, project_id, b_id, 40)
            await _add_ledger(session, other.id, project_id, b_id, 999)  # same project_id, another org's row (a stray / hostile row)
        from app.main import app

        r = await _board(app, Session, a_user, org_id, project_id)
        assert r.status_code == 200, r.text
        rows = r.json()["data"] if isinstance(r.json(), dict) and "data" in r.json() else r.json()
        assert [(str(x["member_id"]), x["balance"]) for x in rows] == [(str(b_id), 40.0)], rows
    finally:
        await engine.dispose()


async def test_the_analytics_repositorys_board_gives_the_same_answer():
    """no route reaches `AnalyticsRepository.get_leaderboard` today — kept correct (it read the same missing view, and its cursor clause came after ORDER BY)."""
    engine, Session = await _session_factory()
    try:
        org_id, project_id, a_user, b_id, c_id = await _room(Session)
        async with Session() as session:
            await _add_ledger(session, org_id, project_id, b_id, 70)
            await _add_ledger(session, org_id, project_id, c_id, 100)
        from app.repositories.analytics import AnalyticsRepository

        async with Session() as session:
            repo = AnalyticsRepository(session, org_id)
            all_rows = await repo.get_leaderboard(project_id, period="all")
            below = await repo.get_leaderboard(project_id, period="all", cursor="100")
        assert [(str(x["member_id"]), x["balance"]) for x in all_rows] == [(str(c_id), 100.0), (str(b_id), 70.0)]
        assert [(str(x["member_id"]), x["balance"]) for x in below] == [(str(b_id), 70.0)]
    finally:
        await engine.dispose()
