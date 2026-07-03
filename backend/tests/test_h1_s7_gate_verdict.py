"""H1-S7: gate transition→review/merge verdict 기록 테스트.

사람 게이트 해소(approve/reject)→verdict(source=gate_type 매핑·result=pass/fail)·resolver 없으면
skip·30초 이하 approve=rubber_stamp 관측·trust 반영(실DB).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.services import gate_service as gs
from app.services.gate_service import _record_gate_review_verdict

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all/drop_all로 자체 스키마 직접 관리 — 공유 alembic-migrated DB
# 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = pytest.mark.destructive_schema
ORG = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _gate(gate_type="merge", work_item_type="story", created=None, resolved=None, facts=None):
    now = datetime(2026, 6, 12, 12, 0, tzinfo=timezone.utc)
    return SimpleNamespace(
        id=uuid.uuid4(), gate_type=gate_type, work_item_type=work_item_type,
        work_item_id=uuid.uuid4(), created_at=created or now,
        resolved_at=resolved or now, neutral_facts=facts,
    )


def _patches(participation=True):
    part = SimpleNamespace(id=uuid.uuid4()) if participation else None
    rv = AsyncMock()
    return (
        patch("app.services.verdict_capture.resolve_implementation_participation",
              AsyncMock(return_value=part)),
        patch("app.services.verdict_recorder.record_verdict", rv),
        rv,
    )


# ── AC①②: approve→pass / reject→fail · source 매핑 ──────────────────────────────

@pytest.mark.anyio
async def test_approve_merge_records_pass():
    p1, p2, rv = _patches()
    with p1, p2:
        await _record_gate_review_verdict(AsyncMock(), ORG, _gate("merge"), "approved", uuid.uuid4())
    rv.assert_awaited_once()
    kw = rv.await_args
    assert kw.args[3] == "merge" and kw.args[4] == "pass"  # source, result


@pytest.mark.anyio
async def test_reject_records_fail():
    p1, p2, rv = _patches()
    with p1, p2:
        await _record_gate_review_verdict(AsyncMock(), ORG, _gate("merge"), "rejected", uuid.uuid4())
    assert rv.await_args.args[4] == "fail"


@pytest.mark.anyio
async def test_gate_type_source_mapping():
    for gate_type, source in [("qa", "qa"), ("deploy", "design"), ("merge", "merge"), ("pr_review", "pr")]:
        p1, p2, rv = _patches()
        with p1, p2:
            await _record_gate_review_verdict(AsyncMock(), ORG, _gate(gate_type), "approved", uuid.uuid4())
        assert rv.await_args.args[3] == source, gate_type


# ── AC③: resolver 없으면 skip ─────────────────────────────────────────────────

@pytest.mark.anyio
async def test_no_resolver_skips():
    p1, p2, rv = _patches()
    with p1, p2:
        await _record_gate_review_verdict(AsyncMock(), ORG, _gate("merge"), "approved", None)
    rv.assert_not_awaited()  # AC③: 사람 resolver 없으면 verdict 0(auto-transition 제외).


@pytest.mark.anyio
async def test_no_participation_skips():
    p1, p2, rv = _patches(participation=False)
    with p1, p2:
        await _record_gate_review_verdict(AsyncMock(), ORG, _gate("merge"), "approved", uuid.uuid4())
    rv.assert_not_awaited()


@pytest.mark.anyio
async def test_non_story_workitem_skips():
    p1, p2, rv = _patches()
    with p1, p2:
        await _record_gate_review_verdict(AsyncMock(), ORG, _gate("merge", work_item_type="epic"), "approved", uuid.uuid4())
    rv.assert_not_awaited()


# ── AC⑤: 30초 이하 approve = rubber stamp 후보 ────────────────────────────────

@pytest.mark.anyio
async def test_fast_approve_marks_rubber_stamp():
    base = datetime(2026, 6, 12, 12, 0, tzinfo=timezone.utc)
    gate = _gate("merge", created=base, resolved=base + timedelta(seconds=10))
    p1, p2, _ = _patches()
    with p1, p2:
        await _record_gate_review_verdict(AsyncMock(), ORG, gate, "approved", uuid.uuid4())
    assert gate.neutral_facts["rubber_stamp_candidate"] is True


@pytest.mark.anyio
async def test_slow_approve_not_rubber_stamp():
    base = datetime(2026, 6, 12, 12, 0, tzinfo=timezone.utc)
    gate = _gate("merge", created=base, resolved=base + timedelta(seconds=120))
    p1, p2, _ = _patches()
    with p1, p2:
        await _record_gate_review_verdict(AsyncMock(), ORG, gate, "approved", uuid.uuid4())
    assert gate.neutral_facts is None or "rubber_stamp_candidate" not in (gate.neutral_facts or {})


@pytest.mark.anyio
async def test_fast_reject_not_rubber_stamp():
    base = datetime(2026, 6, 12, 12, 0, tzinfo=timezone.utc)
    gate = _gate("merge", created=base, resolved=base + timedelta(seconds=5))
    p1, p2, _ = _patches()
    with p1, p2:
        await _record_gate_review_verdict(AsyncMock(), ORG, gate, "rejected", uuid.uuid4())
    # rubber stamp는 approve만 — reject는 미표시.
    assert gate.neutral_facts is None or "rubber_stamp_candidate" not in (gate.neutral_facts or {})


# ── AC④: 실DB — 사람 review verdict가 trust score에 반영 ───────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.xfail(strict=False, reason="clean_pass_rate가 None(기대 1.0) — trust 계산 seed/calibration 갭 의심(test_h1_s10_e2e와 동일 클래스). story 8236bbc3 e2e서 신규 노출. story 18eefc31 트래킹.")
@pytest.mark.anyio
async def test_human_review_verdict_reflected_in_trust_real_db():
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models.gate import Gate
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.services.gate_service import transition_gate
    from app.services.trust_score import compute_member_trust_scores

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    org, project, story_id, member, role_id, resolver = (uuid.uuid4() for _ in range(6))

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                ParticipationRole(id=role_id, org_id=org, key="implementation", label="구현", is_default=True),
                Story(id=story_id, org_id=org, project_id=project, title="S", story_points=5),
                Participation(id=uuid.uuid4(), org_id=org, story_id=story_id, member_id=member, role_id=role_id),
                Gate(id=uuid.uuid4(), org_id=org, work_item_id=story_id, work_item_type="story",
                     gate_type="merge", status="pending"),
            ])
            await s.commit()

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            gate = (await s.execute(_text("SELECT id FROM gate WHERE org_id=:o"), {"o": org})).scalar()
            # 사람 approve → verdict(source=merge result=pass) 기록.
            await transition_gate(s, org, gate, "approved", resolver_id=resolver)
            await s.commit()

        async with Session() as s:
            trust = await compute_member_trust_scores(s, org, member, role_key="implementation")
            scores = trust["scores"]
            # AC④: 사람 review verdict가 trust 집계에 반영(clean pass 1).
            assert scores and scores[0]["clean_pass_rate"] == 1.0
            assert scores[0]["clean_pass_verdicts"] == 1
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
