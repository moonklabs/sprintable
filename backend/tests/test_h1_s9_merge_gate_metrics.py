"""H1-S9: merge gate metrics 집계 테스트.

_ratio 단위(null/0 구분) + 실DB 6지표 시나리오(coverage·throughput·review minutes·rubber stamp·regret).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.services.merge_gate_metrics import _ratio, compute_merge_gate_metrics

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all/drop_all로 자체 스키마 직접 관리 — 공유 alembic-migrated DB
# 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── 단위: null/0 구분 ──────────────────────────────────────────────────────────

def test_ratio_null_when_no_denominator():
    assert _ratio(0, 0) is None and _ratio(5, 0) is None and _ratio(0, None) is None


def test_ratio_zero_when_data_but_no_num():
    assert _ratio(0, 4) == 0.0  # 데이터 있고 num 0 → 0(null 아님).


def test_ratio_rounds():
    assert _ratio(2, 3) == 0.6667


# ── 실DB: 6지표 시나리오 ───────────────────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_metrics_real_db():
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models.gate import Gate
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.models.verdict import Verdict

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    org, project = uuid.uuid4(), uuid.uuid4()
    role_id = uuid.uuid4()
    A, B, C, D = (uuid.uuid4() for _ in range(4))
    pA, pB, pC = (uuid.uuid4() for _ in range(3))
    base = datetime(2026, 6, 12, 12, 0, tzinfo=timezone.utc)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                ParticipationRole(id=role_id, org_id=org, key="implementation", label="구현", is_default=True),
                # stories: A/B/C done, D in-progress
                Story(id=A, org_id=org, project_id=project, title="A", status="done", story_points=3),
                Story(id=B, org_id=org, project_id=project, title="B", status="done", story_points=3),
                Story(id=C, org_id=org, project_id=project, title="C", status="done", story_points=3),
                Story(id=D, org_id=org, project_id=project, title="D", status="in-progress", story_points=3),
                # participations(impl) for A/B/C
                Participation(id=pA, org_id=org, story_id=A, member_id=uuid.uuid4(), role_id=role_id),
                Participation(id=pB, org_id=org, story_id=B, member_id=uuid.uuid4(), role_id=role_id),
                Participation(id=pC, org_id=org, story_id=C, member_id=uuid.uuid4(), role_id=role_id),
                # verdicts: A(merge pass), C(qa pass) — B 없음
                Verdict(id=uuid.uuid4(), org_id=org, participation_id=pA, source="merge", result="pass"),
                Verdict(id=uuid.uuid4(), org_id=org, participation_id=pC, source="qa", result="pass"),
                # gates: A auto_passed, C approved(human·rubber stamp·10min), D auto_passed(regret), B 없음
                Gate(id=uuid.uuid4(), org_id=org, work_item_id=A, work_item_type="story",
                     gate_type="merge", status="auto_passed"),
                Gate(id=uuid.uuid4(), org_id=org, work_item_id=C, work_item_type="story",
                     gate_type="merge", status="approved", resolver_id=uuid.uuid4(),
                     created_at=base, resolved_at=base + timedelta(minutes=10),
                     neutral_facts={"rubber_stamp_candidate": True}),
                Gate(id=uuid.uuid4(), org_id=org, work_item_id=D, work_item_type="story",
                     gate_type="merge", status="auto_passed"),
            ])
            await s.commit()

        async with Session() as s:
            m = await compute_merge_gate_metrics(s, org, project_id=project)

        assert m["merge_gate_coverage"] == 0.6667  # done A/B/C 중 gate A/C = 2/3
        assert m["verdict_coverage"] == 0.6667     # impl pA/pB/pC 중 verdict A/C = 2/3
        assert m["trustworthy_merge_throughput"] == 2  # auto_passed A/D
        assert m["human_review_minutes"] == 10.0   # C 사람해소 10분
        assert m["rubber_stamp_rate"] == 1.0       # 사람 approve C 1건 모두 rubber stamp
        assert m["post_merge_regret_rate"] == 0.3333  # 머지 A/C/D 중 status≠done = D = 1/3

        # 빈 org → null/0 구분.
        async with Session() as s:
            empty = await compute_merge_gate_metrics(s, uuid.uuid4())
        assert empty["merge_gate_coverage"] is None  # 데이터 없음 → null.
        assert empty["verdict_coverage"] is None and empty["rubber_stamp_rate"] is None
        assert empty["post_merge_regret_rate"] is None and empty["human_review_minutes"] is None
        assert empty["trustworthy_merge_throughput"] == 0  # count는 0(실제 무).
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


# ── 엔드포인트 라우팅/응답 shape ───────────────────────────────────────────────

@pytest.mark.anyio
async def test_metrics_endpoint_routes_and_shape():
    from unittest.mock import AsyncMock, MagicMock, patch

    from httpx import ASGITransport, AsyncClient

    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app

    org = uuid.uuid4()
    fake = {
        "merge_gate_coverage": 0.9, "verdict_coverage": None, "trustworthy_merge_throughput": 3,
        "human_review_minutes": 12.5, "rubber_stamp_rate": 0.0, "post_merge_regret_rate": None,
        "project_id": None, "window": {"start": None, "end": None},
    }

    async def _db():
        yield AsyncMock()

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: MagicMock()
    app.dependency_overrides[get_verified_org_id] = lambda: org
    try:
        with patch("app.routers.merge_gate.compute_merge_gate_metrics", new=AsyncMock(return_value=fake)):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                resp = await c.get("/api/v2/merge-gate/metrics")
        assert resp.status_code == 200
        data = resp.json()
        assert data["merge_gate_coverage"] == 0.9 and data["verdict_coverage"] is None
        assert data["trustworthy_merge_throughput"] == 3 and data["human_review_minutes"] == 12.5
        assert data["rubber_stamp_rate"] == 0.0 and data["post_merge_regret_rate"] is None
    finally:
        app.dependency_overrides.clear()
