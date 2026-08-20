"""story #2829(loop-closure P0) — detect_unclosed_loops 실PG 검증.

`preset.loop.measure_due`가 migration 0264 시드 데이터(EventDefinition)라 create_all
스키마가 아니라 **alembic-migrated DB**가 필요하다(publish_preset_event가 이 정의 행을
읽어야 발행이 성립 — create_all은 모델 테이블만 짓고 데이터 시드는 안 한다).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import select

from app.services.loop_measure_due import detect_unclosed_loops
from tests.test_1994_backlink_api_realdb import _make_org, _make_project, _session_factory
from tests.test_2288_command_center_gate_type_waiting_realdb import _make_member
from tests.test_2301_story_body_mentions_realdb import _REAL_DB_URL

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

_METRIC = {"metric": "signups", "source": "db", "target": 100, "direction": "increase"}
_PAST = datetime(2020, 1, 1, tzinfo=timezone.utc)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _make_hypothesis(session, org_id, project_id, owner_id, *, status="measuring", measure_after=_PAST):
    from app.models.hypothesis import Hypothesis
    hyp = Hypothesis(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, owner_member_id=owner_id,
        statement="stmt", metric_definition=_METRIC, measure_after=measure_after, status=status,
    )
    session.add(hyp)
    await session.commit()
    return hyp


async def _make_goal(
    session, org_id, project_id, assignee_id, *,
    status="active", measure_after=_PAST, outcome_status="n_a",
):
    from app.models.pm import Goal
    goal = Goal(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, assignee_id=assignee_id,
        title="G", status=status, measure_after=measure_after, outcome_status=outcome_status,
    )
    session.add(goal)
    await session.commit()
    return goal


async def _detect(session, Session):
    """detect_unclosed_loops를 직접(HTTP 무경유) 호출하는 테스트 전용 wrapper — publish_
    preset_event의 배경 배달 경로가 async_session_factory()(모듈 전역)로 **별도 세션**을
    여는 지점이 있어(test_2813_gate_github_check_realdb.py와 동일 관례), 그걸 이 테스트의
    Session으로 패치하지 않으면 app.core.database의 기본 설정(포트 54322 기본값 — story
    #2818에서 이미 파악한 그 축과 동형)으로 새 연결을 시도해 실패한다."""
    with patch("app.core.database.async_session_factory", Session):
        return await detect_unclosed_loops(session)


async def _published_events(session, org_id):
    from app.models.event import Event  # story #2632/#2791 발행 이력 테이블(org 격리 — 이 org엔 이것뿐).

    return (await session.execute(select(Event).where(Event.org_id == org_id))).scalars().all()


@pytest.mark.anyio
async def test_ac1_detects_overdue_hypothesis_and_goal_and_missing_outcome():
    """AC①: 세 축(가설 도과·goal 도과·outcome 없는 done goal) 전부 실물로 잡힌다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, _ = await _make_member(s, org.id, project.id)
            hyp = await _make_hypothesis(s, org.id, project.id, owner_id)
            overdue_goal = await _make_goal(s, org.id, project.id, owner_id, status="active")
            done_goal = await _make_goal(
                s, org.id, project.id, owner_id, status="done", measure_after=None, outcome_status="n_a",
            )

            summary = await _detect(s, Session)
            await s.commit()

            # total_scanned은 전-org 글로벌 카운트라(cron 잡 설계 그대로 — command_center.py
            # 실서비스 요구에 맞춘 것) CI의 공유 Backend pytest 세션(다른 6000+ 테스트가
            # 같은 DB에 Goal/Hypothesis를 남길 수 있음)에서 정확한 값으로 단정할 수 없다 —
            # 이 AC가 증명해야 하는 건 "이 3개가 실물로 잡혔다"이지 "전체가 정확히 3개"가
            # 아니다(실측 확認: 로컬 격리 실행=3, CI 공유 세션=5도 관측·둘 다 정상).
            published_ids = {p["id"] for p in summary["published"]}
            assert str(hyp.id) in published_ids
            assert str(overdue_goal.id) in published_ids
            assert str(done_goal.id) in published_ids
            my_ids = {str(hyp.id), str(overdue_goal.id), str(done_goal.id)}
            assert not (my_ids & {f["id"] for f in summary["failed"]})
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac2_no_infinite_republish_set_once():
    """AC③: 같은 대상에 두 번째 스캔에서 재발행되지 않는다(loop_measure_due_notified_at set-once)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, _ = await _make_member(s, org.id, project.id)
            hyp = await _make_hypothesis(s, org.id, project.id, owner_id)

            first = await _detect(s, Session)
            await s.commit()
            first_ids = {p["id"] for p in first["published"]}
            assert str(hyp.id) in first_ids

            second = await _detect(s, Session)
            await s.commit()
            # first/second 둘 다 CI 공유 Backend pytest 세션(다른 테스트가 남긴 미통지
            # 항목과 같은 DB를 쓸 수 있음)에서 published/total_scanned 절대 수는 이 테스트
            # 스코프 밖 — id로 직접 증명한다: 이 hyp이 두 번째 스캔에선 대상에서 빠졌다.
            second_ids = {p["id"] for p in second["published"]}
            assert str(hyp.id) not in second_ids

        async with Session() as s:
            events = await _published_events(s, org.id)
            # 정확한 행 수는 send_message()의 배달 팬아웃 정책(공유 이벤트 발행 계통, 이
            # 스토리 스코프 밖) 몫이라 단정하지 않는다 — 이 AC가 실제로 증명해야 하는 것은
            # 위 first/second id 대조로 이미 확定됐다: **동일 대상에 두 번째 publish_
            # preset_event 호출 자체가 없었다.**
            assert len(events) >= 1, "최초 1회 발행 자체는 실물로 남아야 한다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac4_no_owner_is_skipped_not_failed():
    """못 잡는 것 선언 대상 — assignee 없는 goal은 발행 스킵(라우팅 불가), failed로 세지 않는다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            goal = await _make_goal(s, org.id, project.id, assignee_id=None, status="active")

            summary = await _detect(s, Session)
            await s.commit()

            # published/failed/skipped_no_owner 전부 글로벌 카운트(CI 공유 세션 - AC1/AC2와
            # 동일 근거) — 이 goal의 id로만 직접 증명한다.
            assert str(goal.id) not in {p["id"] for p in summary["published"]}
            assert str(goal.id) not in {f["id"] for f in summary["failed"]}
            assert summary["skipped_no_owner"] >= 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resolved_outcome_naturally_exits_scan():
    """상태 전이 후 자연 소멸 — hypothesis가 verified로 넘어가면 다음 스캔에서 대상에서 빠진다
    (별도 '해제' 로직 없이 조회 조건만으로 충분함을 실측)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, _ = await _make_member(s, org.id, project.id)
            hyp = await _make_hypothesis(s, org.id, project.id, owner_id, status="measuring")

            hyp.status = "verified"
            await s.commit()

            summary = await _detect(s, Session)
            await s.commit()
            # total_scanned은 이 잡의 설계상 전-org 글로벌 카운트라(다른 테스트가 남긴
            # owner-없는 goal 등도 매 스캔 재등장 — #2829 못 잡는 것 선언 대상, 아래 참조)
            # 공유 DB에서 단정하기 부적합하다. 이 AC가 증명해야 하는 것은 "이 hypothesis가
            # 대상에서 빠졌다"는 것 하나뿐 — id로 직접 확認한다.
            published_ids = {p["id"] for p in summary["published"]}
            assert str(hyp.id) not in published_ids
    finally:
        await engine.dispose()
