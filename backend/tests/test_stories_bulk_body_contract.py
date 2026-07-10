"""stories /bulk body 계약 가드 — FE 실 shape `{items:[...]}` 수용.

P0 2차(선생님 dnd): #1386 라우트 fix 후 /bulk 핸들러 도달했으나, FE(kanban-board.tsx)는
`{items:[...]}` 래퍼를 보내는데 BE 는 맨 배열 `[...]` 기대 → "Input should be a valid list" 422.
(전 probe가 맨 배열로 false-green 받은 게 갭 — 이 테스트는 FE 실 shape 로 잠근다.)
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


def test_bulk_request_accepts_fe_wrapper_shape():
    """FE 실 shape `{items:[{id,status}]}` 래퍼 파싱(맨 배열 아님)."""
    sid = str(uuid.uuid4())
    req = BulkUpdateRequest(**{"items": [{"id": sid, "status": "done"}]})
    assert len(req.items) == 1
    assert str(req.items[0].id) == sid
    assert req.items[0].status == "done"


@pytest.mark.anyio
def _full_story():
    """StoryResponse(from_attributes) 직렬화에 필요한 전 필드 — 실 model_validate 통과용."""
    now = datetime(2026, 6, 10, 12, 0, 0, tzinfo=timezone.utc)
    return SimpleNamespace(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=uuid.uuid4(), epic_id=None,
        sprint_id=None, assignee_id=None, assignee_ids=[], attachments=[], meeting_id=None,
        title="t", status="todo", priority="medium", story_points=None, description=None,
        acceptance_criteria=None, position=None, success_hypothesis=None, metric_definition=None,
        measure_after=None, outcome_status="n_a", outcome_result=None, is_excluded=False,
        created_at=now, updated_at=now,
    )


@pytest.mark.anyio
async def test_bulk_handler_refreshes_and_serializes(monkeypatch):
    """래퍼 payload → payload.items 순회·setattr·**db.refresh(MissingGreenlet fix)**·**실 StoryResponse 직렬화 통과**.

    P0 3차 교훈: model_validate 를 모킹하면 직렬화를 안 태워 MissingGreenlet 류를 못 잡는다. 여기선
    실 StoryResponse.model_validate 를 태우고 refresh 호출을 가드한다(refresh 누락 시 회귀 검출).
    """
    story = _full_story()
    exec_result = MagicMock()
    exec_result.scalar_one_or_none = MagicMock(return_value=story)
    db = AsyncMock()
    db.execute = AsyncMock(return_value=exec_result)
    db.flush = AsyncMock()
    db.refresh = AsyncMock()
    db.commit = AsyncMock()
    repo = MagicMock()
    repo.org_id = uuid.uuid4()

    monkeypatch.setattr(stories_mod, "_attach_assignee_ids", AsyncMock())
    monkeypatch.setattr(stories_mod, "_resolve_team_member_id", AsyncMock(return_value=None))
    # ⚠️ model_validate 는 모킹하지 않는다 — 실 직렬화를 태워야 P0 3차류를 잡는다.

    payload = BulkUpdateRequest(items=[{"id": str(story.id), "status": "done"}])
    result = await bulk_update_stories(payload, db, repo, auth=MagicMock(user_id=str(uuid.uuid4())))

    assert story.status == "done"  # setattr 적용
    db.refresh.assert_awaited_once_with(story)  # MissingGreenlet fix 가드(refresh 누락 시 실패)
    assert len(result) == 1 and result[0].status == "done"  # 실 StoryResponse 직렬화 통과
    assert result[0].id == story.id
    db.commit.assert_awaited_once()
    # status="todo"(미지 rank)→done = 위반 판정 불가 → violation None(allow·무플래그).
    assert result[0].violation is None


@pytest.mark.anyio
async def test_bulk_nonsequential_jump_flags_violation_but_allows(monkeypatch):
    """정공법 A: /bulk 2단계+ 전진 점프 → 차단 없이 violation flag 반환 + 이벤트 발행(가시화)."""
    story = _full_story()
    story.status = "backlog"  # backlog → in-progress = ready-for-dev 1단계 건너뜀
    exec_result = MagicMock()
    exec_result.scalar_one_or_none = MagicMock(return_value=story)
    db = AsyncMock()
    db.execute = AsyncMock(return_value=exec_result)
    db.flush = AsyncMock(); db.refresh = AsyncMock(); db.commit = AsyncMock()
    repo = MagicMock(); repo.org_id = uuid.uuid4()

    monkeypatch.setattr(stories_mod, "_attach_assignee_ids", AsyncMock())
    monkeypatch.setattr(stories_mod, "_resolve_team_member_id", AsyncMock(return_value=None))
    _pub = MagicMock(); _fire = AsyncMock()
    monkeypatch.setattr(stories_mod, "publish_event", _pub)
    monkeypatch.setattr(stories_mod, "fire_webhooks", _fire)

    payload = BulkUpdateRequest(items=[{"id": str(story.id), "status": "in-progress"}])
    result = await bulk_update_stories(payload, db, repo, auth=MagicMock(user_id=str(uuid.uuid4())))

    assert story.status == "in-progress"  # allow(차단 X)
    assert result[0].violation == {
        "level": "warn", "from": "backlog", "to": "in-progress", "skipped": 1,
    }
    db.commit.assert_awaited_once()
    # workflow_violation 가시화 — 기존 이벤트 타입(additive)·commit 後 발화.
    _pub.assert_called_once()
    assert _pub.call_args[0][1] == "workflow_violation"
    _fire.assert_awaited_once()


@pytest.mark.anyio
async def test_bulk_adjacent_and_reopen_no_violation(monkeypatch):
    """정공법 A: 인접 전진·역방향 reopen 은 정상 → violation None·이벤트 미발행."""
    for old, new in [("ready-for-dev", "in-progress"), ("done", "in-progress")]:
        story = _full_story(); story.status = old
        exec_result = MagicMock()
        exec_result.scalar_one_or_none = MagicMock(return_value=story)
        db = AsyncMock()
        db.execute = AsyncMock(return_value=exec_result)
        db.flush = AsyncMock(); db.refresh = AsyncMock(); db.commit = AsyncMock()
        repo = MagicMock(); repo.org_id = uuid.uuid4()
        monkeypatch.setattr(stories_mod, "_attach_assignee_ids", AsyncMock())
        monkeypatch.setattr(stories_mod, "_resolve_team_member_id", AsyncMock(return_value=None))
        _fire = AsyncMock(); monkeypatch.setattr(stories_mod, "fire_webhooks", _fire)
        monkeypatch.setattr(stories_mod, "publish_event", MagicMock())

        payload = BulkUpdateRequest(items=[{"id": str(story.id), "status": new}])
        result = await bulk_update_stories(payload, db, repo, auth=MagicMock(user_id=str(uuid.uuid4())))

        assert story.status == new  # allow
        assert result[0].violation is None, f"{old}->{new} should be no-violation"
        _fire.assert_not_awaited()  # 정상 전이=이벤트 미발행
