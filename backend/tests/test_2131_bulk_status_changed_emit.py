"""#2131: bulk_update_stories가 status 변경 시 emit_story_status_changed()를 실제로 호출하는지.

근본: 칸반 드래그/컬럼메뉴가 전부 PATCH /stories/bulk를 타는데, 그 라우트는 status를
setattr+commit만 하고 emit_story_status_changed()를 호출하지 않아 SSE 프레임이 서버에서
출발조차 안 했다(pushed=False가 아니라 애초에 push 호출 자체가 없음). PATCH /{id}/status가
이미 쓰는 동일 helper를 재사용해 발행 지점을 하나로 유지한다(AC3).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.routers import stories as stories_mod
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


def _mock_db(story_by_id: dict):
    """org_id/id로 조회하면 해당 story를 돌려주는 db.execute mock."""
    async def _execute(stmt, *a, **kw):
        # bulk_update_stories의 조회는 항상 select(Story).where(Story.id==item.id, ...) 패턴 —
        # 여기선 조회 순서를 story_by_id 삽입 순서에 맞춰 순차 반환(has_project_access 등
        # 다른 execute 호출도 섞이므로, id 매칭 대신 단순 큐로 처리하지 않고 항상 요청된 story를
        # 못 찾을 걱정 없게 첫 story를 fallback으로 둔다 — 테스트는 단일/소수 story라 충분).
        m = MagicMock()
        m.scalar_one_or_none = MagicMock(return_value=next(iter(story_by_id.values())))
        return m
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=_execute)
    db.flush = AsyncMock()
    db.refresh = AsyncMock()
    db.commit = AsyncMock()
    db.add = MagicMock()
    return db


@pytest.mark.anyio
async def test_bulk_status_change_calls_emit_story_status_changed(monkeypatch):
    story = _story(status="todo")
    db = _mock_db({story.id: story})
    repo = MagicMock()
    repo.org_id = story.org_id

    monkeypatch.setattr(stories_mod, "_attach_assignee_ids", AsyncMock())
    monkeypatch.setattr(stories_mod, "_resolve_team_member_id", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "app.services.project_auth.has_project_access", AsyncMock(return_value=True)
    )
    spy = AsyncMock()
    monkeypatch.setattr(stories_mod, "emit_story_status_changed", spy)

    payload = BulkUpdateRequest(items=[{"id": str(story.id), "status": "in-progress"}])
    await bulk_update_stories(payload, db, repo, auth=MagicMock(user_id=str(uuid.uuid4())))

    spy.assert_awaited_once()
    args, kwargs = spy.call_args
    assert args[1] == repo.org_id
    assert args[2] is story
    assert args[3] == "todo"  # old_status


@pytest.mark.anyio
async def test_bulk_no_status_change_does_not_call_emit(monkeypatch):
    """priority만 바뀌는 item — status 불변이면 emit_story_status_changed 호출 자체가 없어야."""
    story = _story(status="todo", priority="low")
    db = _mock_db({story.id: story})
    repo = MagicMock()
    repo.org_id = story.org_id

    monkeypatch.setattr(stories_mod, "_attach_assignee_ids", AsyncMock())
    monkeypatch.setattr(stories_mod, "_resolve_team_member_id", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "app.services.project_auth.has_project_access", AsyncMock(return_value=True)
    )
    spy = AsyncMock()
    monkeypatch.setattr(stories_mod, "emit_story_status_changed", spy)

    payload = BulkUpdateRequest(items=[{"id": str(story.id), "priority": "high"}])
    await bulk_update_stories(payload, db, repo, auth=MagicMock(user_id=str(uuid.uuid4())))

    spy.assert_not_awaited()


@pytest.mark.anyio
async def test_bulk_status_unchanged_value_does_not_call_emit(monkeypatch):
    """같은 값으로 PATCH(status=todo→todo) — old_status_by_id에 안 잡히므로 emit도 안 함."""
    story = _story(status="todo")
    db = _mock_db({story.id: story})
    repo = MagicMock()
    repo.org_id = story.org_id

    monkeypatch.setattr(stories_mod, "_attach_assignee_ids", AsyncMock())
    monkeypatch.setattr(stories_mod, "_resolve_team_member_id", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "app.services.project_auth.has_project_access", AsyncMock(return_value=True)
    )
    spy = AsyncMock()
    monkeypatch.setattr(stories_mod, "emit_story_status_changed", spy)

    payload = BulkUpdateRequest(items=[{"id": str(story.id), "status": "todo"}])
    await bulk_update_stories(payload, db, repo, auth=MagicMock(user_id=str(uuid.uuid4())))

    spy.assert_not_awaited()


@pytest.mark.anyio
async def test_bulk_emit_failure_isolated_per_item(monkeypatch):
    """emit_story_status_changed가 실패해도 bulk 응답 자체는 깨지지 않는다(best-effort)."""
    story = _story(status="todo")
    db = _mock_db({story.id: story})
    repo = MagicMock()
    repo.org_id = story.org_id

    monkeypatch.setattr(stories_mod, "_attach_assignee_ids", AsyncMock())
    monkeypatch.setattr(stories_mod, "_resolve_team_member_id", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "app.services.project_auth.has_project_access", AsyncMock(return_value=True)
    )
    monkeypatch.setattr(
        stories_mod, "emit_story_status_changed", AsyncMock(side_effect=RuntimeError("boom"))
    )

    payload = BulkUpdateRequest(items=[{"id": str(story.id), "status": "in-progress"}])
    result = await bulk_update_stories(payload, db, repo, auth=MagicMock(user_id=str(uuid.uuid4())))

    assert len(result) == 1 and result[0].status == "in-progress"


def test_bulk_source_reuses_shared_emit_helper():
    """소스 검사 — bulk가 emit_story_status_changed를 PATCH /{id}/status와 동일하게 호출.
    새 파생 함수를 만들지 않았는지(AC3: 발행 지점 분리 금지) 회귀 고정."""
    import inspect

    source = inspect.getsource(stories_mod.bulk_update_stories)
    assert "await emit_story_status_changed(" in source
    assert source.count("await emit_story_status_changed(") == 1
