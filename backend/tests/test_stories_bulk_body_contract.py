"""stories /bulk body 계약 가드 — FE 실 shape `{items:[...]}` 수용.

P0 2차(선생님 dnd): #1386 라우트 fix 후 /bulk 핸들러 도달했으나, FE(kanban-board.tsx)는
`{items:[...]}` 래퍼를 보내는데 BE 는 맨 배열 `[...]` 기대 → "Input should be a valid list" 422.
(전 probe가 맨 배열로 false-green 받은 게 갭 — 이 테스트는 FE 실 shape 로 잠근다.)
"""
from __future__ import annotations

import uuid
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
async def test_bulk_handler_iterates_payload_items(monkeypatch):
    """래퍼 payload → 핸들러가 payload.items 순회·setattr 적용·결과 반환(FE shape→200 등가)."""
    story = SimpleNamespace(id=uuid.uuid4(), assignee_id=None, status=None)
    exec_result = MagicMock()
    exec_result.scalar_one_or_none = MagicMock(return_value=story)
    db = AsyncMock()
    db.execute = AsyncMock(return_value=exec_result)
    db.commit = AsyncMock()
    repo = MagicMock()
    repo.org_id = uuid.uuid4()

    monkeypatch.setattr(stories_mod, "_attach_assignee_ids", AsyncMock())
    monkeypatch.setattr(stories_mod.StoryResponse, "model_validate", staticmethod(lambda s: {"id": str(s.id)}))

    payload = BulkUpdateRequest(items=[{"id": str(story.id), "status": "done"}])
    result = await bulk_update_stories(payload, db, repo)

    assert result == [{"id": str(story.id)}]
    assert story.status == "done"  # payload.items 순회·setattr 적용 입증
    db.commit.assert_awaited_once()
