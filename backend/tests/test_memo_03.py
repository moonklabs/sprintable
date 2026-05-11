"""MEMO-03: workflow echo 루프 가드 — origin=workflow 메모는 process_event 스킵."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMO_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _base_memo_payload(**kwargs) -> dict:
    return {
        "org_id": str(ORG_ID),
        "project_id": str(PROJECT_ID),
        "content": "테스트 내용",
        "memo_type": "task",
        "title": "테스트 메모",
        "created_by": str(MEMBER_ID),
        **kwargs,
    }


def _mock_memo(memo_metadata: dict | None = None) -> MagicMock:
    m = MagicMock()
    m.id = MEMO_ID
    m.org_id = ORG_ID
    m.project_id = PROJECT_ID
    m.memo_type = "task"
    m.title = "테스트 메모"
    m.content = "테스트 내용"
    m.created_by = MEMBER_ID
    m.assigned_to = None
    m.status = "open"
    m.supersedes_id = None
    m.resolved_by = None
    m.resolved_at = None
    m.archived_at = None
    m.deleted_at = None
    m.memo_metadata = memo_metadata or {}
    m.embed_count = 0
    m.reply_count = 0
    m.latest_reply_at = None
    m.created_at = datetime(2026, 5, 11, tzinfo=timezone.utc)
    m.updated_at = datetime(2026, 5, 11, tzinfo=timezone.utc)
    return m


async def _client():
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    ctx = MagicMock()
    ctx.user_id = str(MEMBER_ID)
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}
    mock_session = AsyncMock()
    mock_session.add = MagicMock()
    mock_session.flush = AsyncMock()
    mock_session.commit = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


# ─── AC1: workflow origin 메모 → process_event 호출 안 됨 ─────────────────────

@pytest.mark.anyio
async def test_workflow_origin_memo_skips_process_event():
    """memo_metadata.origin=workflow인 메모 생성 시 process_event 미호출."""
    client, session, app = await _client()
    try:
        mock_memo = _mock_memo(memo_metadata={"origin": "workflow"})

        with patch("app.repositories.memo.MemoRepository.create", new_callable=AsyncMock) as mock_create, \
             patch("app.repositories.memo.MemoRepository.create_entity_links", new_callable=AsyncMock), \
             patch("app.routers.memos.publish_event"), \
             patch("app.services.workflow_pipeline.process_event", new_callable=AsyncMock) as mock_process:
            mock_create.return_value = mock_memo
            session.execute = AsyncMock(return_value=MagicMock())

            async with client as c:
                resp = await c.post("/api/v2/memos", json=_base_memo_payload(
                    memo_metadata={"origin": "workflow"}
                ))

        assert resp.status_code == 201
        mock_process.assert_not_called()
    finally:
        app.dependency_overrides.clear()


# ─── AC2: 일반 메모 → process_event 정상 호출 ────────────────────────────────

@pytest.mark.anyio
async def test_normal_memo_calls_process_event():
    """origin 없는 일반 메모는 process_event 정상 호출됨."""
    client, session, app = await _client()
    try:
        mock_memo = _mock_memo()

        with patch("app.repositories.memo.MemoRepository.create", new_callable=AsyncMock) as mock_create, \
             patch("app.repositories.memo.MemoRepository.create_entity_links", new_callable=AsyncMock), \
             patch("app.routers.memos.publish_event"), \
             patch("app.services.workflow_pipeline.process_event", new_callable=AsyncMock) as mock_process:
            mock_create.return_value = mock_memo
            session.execute = AsyncMock(return_value=MagicMock())

            async with client as c:
                resp = await c.post("/api/v2/memos", json=_base_memo_payload())

        assert resp.status_code == 201
        mock_process.assert_called_once()
    finally:
        app.dependency_overrides.clear()


# ─── AC1: _send_memo가 origin=workflow 태깅하는지 확인 ────────────────────────

@pytest.mark.anyio
async def test_send_memo_tags_workflow_origin():
    """workflow_pipeline._send_memo()가 memo_metadata={"origin":"workflow"}로 생성."""
    from app.services.workflow_pipeline import _send_memo
    from app.services.rule_evaluator import EventContext

    session = AsyncMock()
    ctx = EventContext(
        event_type="memo_created",
        actor_id=str(MEMBER_ID),
        metadata={},
    )

    with patch("app.repositories.memo.MemoRepository.create", new_callable=AsyncMock) as mock_create:
        mock_create.return_value = MagicMock()
        await _send_memo(session, ORG_ID, PROJECT_ID, MEMBER_ID, ctx)

    call_kwargs = mock_create.call_args[1]
    assert call_kwargs.get("memo_metadata") == {"origin": "workflow"}
