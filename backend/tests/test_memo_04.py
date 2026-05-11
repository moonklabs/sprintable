"""MEMO-04: 스토리 done 시 관련 메모 자동 resolve 테스트."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
MEMO_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


# ─── AC1: resolve_memos side effect — story_id 기준 open 메모 전량 resolved ───

@pytest.mark.anyio
async def test_resolve_memos_side_effect():
    """resolve_memos side effect: story 연결된 open 메모 전량 resolved 처리."""
    from app.services.workflow_pipeline import _execute_side_effects
    from app.services.rule_evaluator import EventContext

    session = AsyncMock()

    link_row = MagicMock()
    link_row.memo_id = MEMO_ID

    link_result = MagicMock()
    link_result.__iter__ = MagicMock(return_value=iter([link_row]))

    update_result = MagicMock()

    call_count = 0

    async def mock_execute(stmt, *a, **kw):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return link_result
        return update_result

    session.execute = mock_execute

    ctx = EventContext(
        event_type="story.status_changed",
        metadata={"story_id": str(STORY_ID), "new_status": "done"},
    )

    await _execute_side_effects(session, ORG_ID, [{"type": "resolve_memos"}], ctx)

    assert call_count == 2


# ─── AC1: story_id 없으면 resolve_memos 스킵 ──────────────────────────────────

@pytest.mark.anyio
async def test_resolve_memos_skipped_without_story_id():
    """story_id 없는 컨텍스트에서 resolve_memos → 쿼리 없음."""
    from app.services.workflow_pipeline import _execute_side_effects
    from app.services.rule_evaluator import EventContext

    session = AsyncMock()
    session.execute = AsyncMock()

    ctx = EventContext(
        event_type="story.status_changed",
        metadata={},
    )

    await _execute_side_effects(session, ORG_ID, [{"type": "resolve_memos"}], ctx)

    session.execute.assert_not_called()


# ─── AC1: 빈 memo_ids — update 쿼리 미발생 ────────────────────────────────────

@pytest.mark.anyio
async def test_resolve_memos_no_links_skips_update():
    """entity link 없는 story → update 쿼리 미발생."""
    from app.services.workflow_pipeline import _execute_side_effects
    from app.services.rule_evaluator import EventContext

    session = AsyncMock()
    empty_result = MagicMock()
    empty_result.__iter__ = MagicMock(return_value=iter([]))

    call_count = 0

    async def mock_execute(stmt, *a, **kw):
        nonlocal call_count
        call_count += 1
        return empty_result

    session.execute = mock_execute

    ctx = EventContext(
        event_type="story.status_changed",
        metadata={"story_id": str(STORY_ID)},
    )

    await _execute_side_effects(session, ORG_ID, [{"type": "resolve_memos"}], ctx)

    assert call_count == 1


# ─── AC2: stories.py event_data에 new_status 포함 — 코드 레벨 검증 ───────────

def test_event_data_includes_new_status():
    """update_story_status 이벤트 payload 구성 방식 — new_status 포함 여부 코드 확인."""
    import ast, pathlib
    src = pathlib.Path(
        __file__
    ).parent.parent / "app" / "routers" / "stories.py"
    code = src.read_text()
    assert '"new_status"' in code or "'new_status'" in code, \
        "stories.py event_data에 new_status 필드가 없음"
