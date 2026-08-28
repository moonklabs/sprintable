"""story #3176 선행조건①(설계 doc `au-metering-phase2-prereq-3176` §1, 페드루 PO 정정 반영) —
payload-배치 2곳(`PATCH /goals/bulk`·`PATCH /stories/bulk`)이 `X-Affected-Entities` 응답
헤더에 실처리 대상 수(len(updated))를 정확히 싣는지 pin. mock 시나리오: 요청 3건 중 1건은
project 접근권 없음(has_project_access=False) → 스킵되므로 실처리는 2건 — 헤더는 «요청 수
(3)»가 아니라 «실처리 수(2)»여야 한다(요청 개수 그대로 실으면 존재하지 않는/미접근 item까지
과금하는 결함이 됨 — 이 경계값이 이 테스트의 핵심).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.routers import goals as goals_mod
from app.routers import stories as stories_mod
from app.routers.goals import BulkGoalPositionRequest, bulk_update_goals
from app.routers.stories import BulkUpdateRequest, bulk_update_stories


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _story(status="todo", **overrides):
    now = datetime(2026, 6, 10, 12, 0, 0, tzinfo=timezone.utc)
    base = dict(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=uuid.uuid4(), epic_id=None,
        sprint_id=None, assignee_id=None, assignee_ids=[], attachments=[], meeting_id=None,
        title="t", status=status, priority="medium", story_points=None, description=None,
        acceptance_criteria=None, position=None, success_hypothesis=None, metric_definition=None,
        measure_after=None, outcome_status="n_a", outcome_result=None, is_excluded=False,
        created_at=now, updated_at=now,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _goal(**overrides):
    now = datetime(2026, 6, 10, 12, 0, 0, tzinfo=timezone.utc)
    base = dict(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=uuid.uuid4(), assignee_id=None,
        title="g", status="active", priority="medium", description=None, objective=None,
        success_criteria=None, target_sp=None, target_date=None, success_hypothesis=None,
        metric_definition=None, measure_after=None, outcome_status="n_a", outcome_result=None,
        position=None, created_at=now, updated_at=now,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _mock_db_queue(entities: list):
    """select(...).where(Model.id == item.id, ...) 호출을 요청 items 순서 그대로 매칭시키는
    큐 기반 mock — has_project_access는 별도 함수 monkeypatch라 이 db.execute enqueue엔 안 걸림."""
    queue = list(entities)

    async def _execute(stmt, *a, **kw):
        m = MagicMock()
        m.scalar_one_or_none = MagicMock(return_value=queue.pop(0) if queue else None)
        return m

    db = AsyncMock()
    db.execute = AsyncMock(side_effect=_execute)
    db.flush = AsyncMock()
    db.refresh = AsyncMock()
    db.commit = AsyncMock()
    db.add = MagicMock()
    return db


@pytest.mark.anyio
async def test_bulk_update_stories_affected_entities_excludes_inaccessible_items(monkeypatch):
    s1 = _story()
    s2 = _story()  # project 접근권 없음 — 스킵 대상
    s3 = _story()
    db = _mock_db_queue([s1, s2, s3])
    repo = MagicMock()
    repo.org_id = s1.org_id

    monkeypatch.setattr(stories_mod, "_attach_assignee_ids", AsyncMock())
    monkeypatch.setattr(stories_mod, "_attach_has_evidence", AsyncMock())
    monkeypatch.setattr(stories_mod, "_attach_has_hypothesis_or_goal", AsyncMock())
    monkeypatch.setattr(stories_mod, "_attach_org_project_slugs", AsyncMock())
    monkeypatch.setattr(stories_mod, "_attach_trust_stage", AsyncMock())
    monkeypatch.setattr(stories_mod, "_resolve_team_member_id", AsyncMock(return_value=None))
    monkeypatch.setattr(stories_mod, "_resolve_actor_info", AsyncMock(return_value=(None, None, None)))

    access_map = {s1.id: True, s2.id: False, s3.id: True}

    async def _fake_access(session, user_id, project_id, org_id):
        # has_project_access(session, user_id, story.project_id, org_id) — story별 project_id로
        # 역참조가 불가하니(3자 모두 randomUUID) id 매핑 대신 호출 순서로 큐 소비.
        return access_map[_fake_access.queue.pop(0)]

    _fake_access.queue = [s1.id, s2.id, s3.id]
    monkeypatch.setattr("app.services.project_auth.has_project_access", AsyncMock(side_effect=_fake_access))

    payload = BulkUpdateRequest(items=[
        {"id": str(s1.id), "priority": "high"},
        {"id": str(s2.id), "priority": "high"},
        {"id": str(s3.id), "priority": "high"},
    ])
    response = MagicMock()
    response.headers = {}
    result = await bulk_update_stories(
        payload, MagicMock(), db, repo, auth=MagicMock(user_id=str(uuid.uuid4())), response=response,
    )

    assert len(result) == 2, "미접근 item(s2)은 스킵돼 실처리 2건만 결과에 남아야 함"
    assert response.headers["X-Affected-Entities"] == "2", (
        "요청 3건이 아니라 실처리 2건이 헤더에 실려야 함(과다계상 방지)"
    )


@pytest.mark.anyio
async def test_bulk_update_stories_no_response_object_does_not_raise(monkeypatch):
    """response=None(직접호출 기존 테스트 다수의 기본 형태)이어도 헤더 세팅을 스킵할 뿐 예외는 없다."""
    s1 = _story()
    db = _mock_db_queue([s1])
    repo = MagicMock()
    repo.org_id = s1.org_id

    monkeypatch.setattr(stories_mod, "_attach_assignee_ids", AsyncMock())
    monkeypatch.setattr(stories_mod, "_attach_has_evidence", AsyncMock())
    monkeypatch.setattr(stories_mod, "_attach_has_hypothesis_or_goal", AsyncMock())
    monkeypatch.setattr(stories_mod, "_attach_org_project_slugs", AsyncMock())
    monkeypatch.setattr(stories_mod, "_attach_trust_stage", AsyncMock())
    monkeypatch.setattr(stories_mod, "_resolve_team_member_id", AsyncMock(return_value=None))
    monkeypatch.setattr(stories_mod, "_resolve_actor_info", AsyncMock(return_value=(None, None, None)))
    monkeypatch.setattr("app.services.project_auth.has_project_access", AsyncMock(return_value=True))

    payload = BulkUpdateRequest(items=[{"id": str(s1.id), "priority": "high"}])
    result = await bulk_update_stories(payload, MagicMock(), db, repo, auth=MagicMock(user_id=str(uuid.uuid4())))
    assert len(result) == 1


@pytest.mark.anyio
async def test_bulk_update_goals_affected_entities_excludes_inaccessible_items(monkeypatch):
    g1 = _goal()
    g2 = _goal()  # project 접근권 없음 — 스킵 대상
    db = _mock_db_queue([g1, g2])
    org_id = g1.org_id

    monkeypatch.setattr(goals_mod, "_attach_org_project_slugs", AsyncMock())

    access_map = {g1.id: True, g2.id: False}

    async def _fake_access(session, user_id, project_id, org_id_arg):
        return access_map[_fake_access.queue.pop(0)]

    _fake_access.queue = [g1.id, g2.id]
    monkeypatch.setattr(goals_mod, "has_project_access", AsyncMock(side_effect=_fake_access))

    payload = BulkGoalPositionRequest(items=[
        {"id": str(g1.id), "position": 1},
        {"id": str(g2.id), "position": 2},
    ])
    response = MagicMock()
    response.headers = {}
    result = await bulk_update_goals(
        payload, response, session=db, org_id=org_id, auth=MagicMock(user_id=str(uuid.uuid4())),
    )

    assert len(result) == 1, "미접근 item(g2)은 스킵돼 실처리 1건만 결과에 남아야 함"
    assert response.headers["X-Affected-Entities"] == "1"
