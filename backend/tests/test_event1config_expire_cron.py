"""E-EVENT-1CONFIG Part B: expire-stale cron 배선 가드.

expire_stale_events_core(org_id=None) 전 org 일괄 cleanup + cron 라우트 등록 + ACK retire 가
delivered 마킹한 이벤트를 cleanup 이 회수함을 가드한다. cron 미연결이 원 landmine 이라 라우트
존재 자체가 회귀 가드.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import text

from app.routers.events import expire_stale_events_core


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _rowcount_result(rc: int) -> MagicMock:
    r = MagicMock()
    r.rowcount = rc
    return r


@pytest.mark.anyio
async def test_core_global_issues_update_delete_and_commits():
    db = SimpleNamespace(
        execute=AsyncMock(side_effect=[_rowcount_result(3), _rowcount_result(2)]),
        commit=AsyncMock(),
    )
    out = await expire_stale_events_core(db, org_id=None)
    assert out == {"expired": 3, "cleaned": 2}
    assert db.execute.await_count == 2  # update(expire) + delete(cleanup)
    db.commit.assert_awaited_once()


@pytest.mark.anyio
async def test_core_org_scoped_also_runs():
    db = SimpleNamespace(
        execute=AsyncMock(side_effect=[_rowcount_result(0), _rowcount_result(0)]),
        commit=AsyncMock(),
    )
    out = await expire_stale_events_core(db, org_id=uuid.uuid4())
    assert out == {"expired": 0, "cleaned": 0}


def test_cron_route_registered():
    """cron 미연결이 원 landmine — 라우트 등록 자체가 회귀 가드."""
    from app.main import app

    paths = {getattr(r, "path", None) for r in app.routes}
    assert "/api/v2/internal/cron/expire-stale-events" in paths


# ─── 실DB 의미 가드 (org 스코프·delivered 회수) ───────────────────────────────

_ASYNCPG_URL = (
    os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    or None
)
_requires_db = pytest.mark.skipif(
    not _ASYNCPG_URL, reason="DATABASE_URL not set — real DB test skipped"
)


@_requires_db
@pytest.mark.xfail(strict=False, reason="asyncpg 'attached to a different loop' RuntimeError — story 8236bbc3 e2e 시뮬레이션서 신규 노출(격리 재현 확인). story 18eefc31 트래킹.")
@pytest.mark.anyio
async def test_global_cleanup_recovers_delivered_across_orgs_realdb():
    """전 org cleanup: 7일 초과 delivered 삭제(ACK retire 회수)·org 무관."""
    from app.core.database import async_session_factory

    org_a, org_b = uuid.uuid4(), uuid.uuid4()
    proj_a, proj_b = uuid.uuid4(), uuid.uuid4()
    agent = uuid.uuid4()
    old = datetime.now(timezone.utc) - timedelta(days=10)

    async with async_session_factory() as db:
        for org, proj in ((org_a, proj_a), (org_b, proj_b)):
            await db.execute(
                text("INSERT INTO organizations (id, name, slug) VALUES (:i, :n, :s)"),
                {"i": org, "n": f"exp-org-{org}", "s": f"exp-{org}"},
            )
            await db.execute(
                text("INSERT INTO projects (id, org_id, name) VALUES (:i, :o, :n)"),
                {"i": proj, "o": org, "n": f"exp-proj-{proj}"},
            )
            # 오래된 delivered(ACK retire 산출물) — cleanup 대상
            await db.execute(
                text(
                    "INSERT INTO events (id, org_id, project_id, event_type, recipient_id, "
                    " recipient_type, payload, status, recipient_seq, delivered_at) VALUES "
                    "(gen_random_uuid(), :o, :p, 'conversation.message_created', :r, 'agent', "
                    " '{}', 'delivered', 1, :d)"
                ),
                {"o": org, "p": proj, "r": agent, "d": old},
            )
        await db.commit()
        try:
            out = await expire_stale_events_core(db, org_id=None)
            assert out["cleaned"] >= 2, "양 org 의 오래된 delivered 모두 회수"

            remaining = (await db.execute(
                text("SELECT count(*) FROM events WHERE recipient_id = :r AND status = 'delivered'"),
                {"r": agent},
            )).scalar()
            assert remaining == 0
        finally:
            await db.execute(text("DELETE FROM events WHERE recipient_id = :r"), {"r": agent})
            for proj in (proj_a, proj_b):
                await db.execute(text("DELETE FROM projects WHERE id = :i"), {"i": proj})
            for org in (org_a, org_b):
                await db.execute(text("DELETE FROM organizations WHERE id = :i"), {"i": org})
            await db.commit()
