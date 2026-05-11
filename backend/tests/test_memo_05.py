"""MEMO-05: trigger_type 파라미터 — memo_metadata 저장 + list 필터."""
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


def _mock_memo(memo_metadata: dict | None = None) -> MagicMock:
    m = MagicMock()
    m.id = MEMO_ID
    m.org_id = ORG_ID
    m.project_id = PROJECT_ID
    m.memo_type = "task"
    m.title = "킥오프 메모"
    m.content = "내용"
    m.created_by = MEMBER_ID
    m.assigned_to = None
    m.status = "open"
    m.supersedes_id = None
    m.resolved_by = None
    m.resolved_at = None
    m.archived_at = None
    m.deleted_at = None
    m.memo_metadata = memo_metadata or {"trigger_type": "kickoff"}
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

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


# ─── AC1: trigger_type → memo_metadata에 저장 ────────────────────────────────

@pytest.mark.anyio
async def test_create_memo_with_trigger_type_stored_in_metadata():
    """trigger_type 전달 시 memo_metadata에 포함되어 create 호출됨."""
    client, session, app = await _client()
    try:
        mock_memo = _mock_memo({"trigger_type": "kickoff"})

        with patch("app.repositories.memo.MemoRepository.create", new_callable=AsyncMock) as mock_create, \
             patch("app.repositories.memo.MemoRepository.create_entity_links", new_callable=AsyncMock), \
             patch("app.routers.memos.publish_event"), \
             patch("app.services.workflow_pipeline.process_event", new_callable=AsyncMock):
            mock_create.return_value = mock_memo
            session.execute = AsyncMock(return_value=MagicMock())

            async with client as c:
                resp = await c.post("/api/v2/memos", json={
                    "org_id": str(ORG_ID),
                    "project_id": str(PROJECT_ID),
                    "content": "킥오프 내용",
                    "memo_type": "task",
                    "title": "킥오프",
                    "created_by": str(MEMBER_ID),
                    "memo_metadata": {"trigger_type": "kickoff"},
                })

        assert resp.status_code == 201
        create_kwargs = mock_create.call_args[1]
        assert create_kwargs.get("memo_metadata", {}).get("trigger_type") == "kickoff"
    finally:
        app.dependency_overrides.clear()


# ─── AC2: trigger_type 미전달 시 기존 메모 정상 동작 ─────────────────────────

@pytest.mark.anyio
async def test_create_memo_without_trigger_type_unaffected():
    """trigger_type 미전달 시 memo_metadata 영향 없음."""
    client, session, app = await _client()
    try:
        mock_memo = _mock_memo({})

        with patch("app.repositories.memo.MemoRepository.create", new_callable=AsyncMock) as mock_create, \
             patch("app.repositories.memo.MemoRepository.create_entity_links", new_callable=AsyncMock), \
             patch("app.routers.memos.publish_event"), \
             patch("app.services.workflow_pipeline.process_event", new_callable=AsyncMock):
            mock_create.return_value = mock_memo
            session.execute = AsyncMock(return_value=MagicMock())

            async with client as c:
                resp = await c.post("/api/v2/memos", json={
                    "org_id": str(ORG_ID),
                    "project_id": str(PROJECT_ID),
                    "content": "일반 메모",
                    "memo_type": "memo",
                    "title": "일반",
                    "created_by": str(MEMBER_ID),
                })

        assert resp.status_code == 201
    finally:
        app.dependency_overrides.clear()


# ─── AC3: list_memos trigger_type 필터 — repo.list 호출 파라미터 확인 ─────────

@pytest.mark.anyio
async def test_list_memos_trigger_type_filter_passed_to_repo():
    """?trigger_type=kickoff → repo.list에 trigger_type 필터 전달됨."""
    client, session, app = await _client()
    try:
        mock_memo = _mock_memo({"trigger_type": "kickoff"})

        with patch("app.repositories.memo.MemoRepository.list", new_callable=AsyncMock) as mock_list, \
             patch("app.repositories.memo.MemoRepository.get_entity_link_counts_batch", new_callable=AsyncMock) as mock_embed, \
             patch("app.repositories.memo.MemoRepository.get_reply_counts_batch", new_callable=AsyncMock) as mock_reply:
            mock_list.return_value = [mock_memo]
            mock_embed.return_value = {}
            mock_reply.return_value = {}

            async with client as c:
                resp = await c.get(f"/api/v2/memos?trigger_type=kickoff")

        assert resp.status_code == 200
        call_kwargs = mock_list.call_args[1]
        assert call_kwargs.get("trigger_type") == "kickoff"
    finally:
        app.dependency_overrides.clear()


# ─── AC3: trigger_type 없으면 필터 미전달 ────────────────────────────────────

@pytest.mark.anyio
async def test_list_memos_no_trigger_type_filter():
    """trigger_type 미전달 시 repo.list에 trigger_type 없음."""
    client, session, app = await _client()
    try:
        with patch("app.repositories.memo.MemoRepository.list", new_callable=AsyncMock) as mock_list, \
             patch("app.repositories.memo.MemoRepository.get_entity_link_counts_batch", new_callable=AsyncMock), \
             patch("app.repositories.memo.MemoRepository.get_reply_counts_batch", new_callable=AsyncMock):
            mock_list.return_value = []

            async with client as c:
                resp = await c.get("/api/v2/memos")

        assert resp.status_code == 200
        call_kwargs = mock_list.call_args[1]
        assert "trigger_type" not in call_kwargs
    finally:
        app.dependency_overrides.clear()
