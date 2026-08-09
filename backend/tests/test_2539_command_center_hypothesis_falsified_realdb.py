"""story #2539(2026-08-09, PO (가) 결·선생님 승인) — command_center의 hypothesis_falsified
결과 통보 신호를 실PG로 검증한다. 기존 test_command_center.py는 mock 세션이라 SELECT 절이
실제로 유효한지·superseded_by_hypothesis_id 조인이 동작하는지는 증명 못한다.

⛔이 신호는 in-flight 이상감지가 아니다(그라운딩 확認: outcome_result는 status가 verified/
falsified로 종결되는 순간에만 채워짐 — "measuring이면서 outcome_result 있음"은 데이터
구조상 존재 안 함). "방금 falsified로 종결된 가설" 결과 통보일 뿐이라 severity=info다."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_org,
    _make_project,
    _session_factory,
)
from tests.test_2288_command_center_gate_type_waiting_realdb import (
    _make_member,
    _setup_app_human,
)
from tests.test_2301_story_body_mentions_realdb import _REAL_DB_URL

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


_METRIC = {"metric": "signups", "source": "db", "target": 100, "direction": "increase"}


async def _make_hypothesis(session, org_id, project_id, owner_id, *, statement="Hyp", status="proposed"):
    from app.models.hypothesis import Hypothesis
    hyp = Hypothesis(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, owner_member_id=owner_id,
        statement=statement, metric_definition=_METRIC,
        measure_after=datetime(2026, 1, 1, tzinfo=UTC), status=status,
    )
    session.add(hyp)
    await session.commit()
    return hyp


async def _falsify_hypothesis(session, hyp_id, *, outcome_result=None, superseded_by=None, updated_at):
    """updated_at은 onupdate=func.now()라 Core update()로 명시값을 강제한다(story #2538과 동형)."""
    from app.models.hypothesis import Hypothesis
    await session.execute(
        update(Hypothesis).where(Hypothesis.id == hyp_id).values(
            status="falsified", outcome_result=outcome_result,
            superseded_by_hypothesis_id=superseded_by, updated_at=updated_at,
        )
    )
    await session.commit()


async def test_hypothesis_falsified_signal_carries_real_outcome_realdb():
    """⭐핵심 — hypothesis_falsified 항목이 실제 statement/outcome_result와 일치하고
    severity=info(결과 통보, 경고 아님)인지 실PG로 확認."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            hyp = await _make_hypothesis(s, org.id, project.id, caller_id, statement="2단계 체크아웃 가설")
            outcome = {"metric": "signups", "target": 100.0, "actual": 42.0, "direction": "increase"}
            await _falsify_hypothesis(
                s, hyp.id, outcome_result=outcome, updated_at=datetime.now(UTC) - timedelta(days=2),
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/command-center/my-actions")
            assert resp.status_code == 200, resp.text
            items = resp.json()["attention"]["items"]
            hf = next(i for i in items if i["type"] == "hypothesis_falsified" and i["hypothesis_id"] == str(hyp.id))
            assert hf["statement"] == "2단계 체크아웃 가설"
            assert hf["outcome_result"] == outcome
            assert hf["severity"] == "info", "결과 통보라 warn 아닌 info여야 하는 — story_stalled와 의도적으로 다른 톤"
            assert isinstance(hf["falsified_days"], int) and hf["falsified_days"] >= 1
            assert hf["superseded_by_hypothesis_id"] is None
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_hypothesis_falsified_exposes_superseded_by_when_confirmed_realdb():
    """AC — 확認된 대체 가설(superseded_by_hypothesis_id)이 있으면 그대로 노출(정반합 톤 재료),
    지어내지 않는다 원칙상 확認 안 되면 이전 테스트처럼 None."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            falsified_hyp = await _make_hypothesis(s, org.id, project.id, caller_id, statement="원래 가설")
            successor = await _make_hypothesis(s, org.id, project.id, caller_id, statement="대체 가설")
            await _falsify_hypothesis(
                s, falsified_hyp.id, superseded_by=successor.id,
                updated_at=datetime.now(UTC) - timedelta(days=1),
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/command-center/my-actions")
            assert resp.status_code == 200, resp.text
            items = resp.json()["attention"]["items"]
            hf = next(
                i for i in items
                if i["type"] == "hypothesis_falsified" and i["hypothesis_id"] == str(falsified_hyp.id)
            )
            assert hf["superseded_by_hypothesis_id"] == str(successor.id)
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_hypothesis_falsified_excludes_old_and_other_status_realdb():
    """AC — _HYPOTHESIS_FALSIFIED_DAYS 밖으로 오래된 falsified·status가 falsified 아닌
    가설은 신호에 안 뜬다(false positive 0)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            old_falsified = await _make_hypothesis(s, org.id, project.id, caller_id, statement="오래된 반증")
            await _falsify_hypothesis(s, old_falsified.id, updated_at=datetime.now(UTC) - timedelta(days=30))
            still_active = await _make_hypothesis(
                s, org.id, project.id, caller_id, statement="진행중", status="active",
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/command-center/my-actions")
            assert resp.status_code == 200, resp.text
            ids = {
                i["hypothesis_id"] for i in resp.json()["attention"]["items"]
                if i["type"] == "hypothesis_falsified"
            }
            assert str(old_falsified.id) not in ids
            assert str(still_active.id) not in ids
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
