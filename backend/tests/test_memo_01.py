"""MEMO-01: list_memos reply_count + latest_reply_at 불일치 수정."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMO_ID_1 = uuid.uuid4()
MEMO_ID_2 = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
REPLY_TS = datetime(2026, 5, 11, 14, 0, tzinfo=timezone.utc)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _mock_memo(memo_id: uuid.UUID, status: str = "open") -> MagicMock:
    m = MagicMock()
    m.id = memo_id
    m.org_id = ORG_ID
    m.project_id = PROJECT_ID
    m.memo_type = "memo"
    m.title = "Test Memo"
    m.content = "내용"
    m.created_by = MEMBER_ID
    m.assigned_to = None
    m.status = status
    m.supersedes_id = None
    m.resolved_by = None
    m.resolved_at = None
    m.archived_at = None
    m.deleted_at = None
    m.memo_metadata = {}
    m.search_vector = None
    m.embed_count = 0
    m.reply_count = 0
    m.latest_reply_at = None
    m.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    m.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return m


async def _client():
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    ctx = MagicMock()
    ctx.user_id = str(MEMBER_ID)
    ctx.email = "test@example.com"
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


# ─── AC1: list_memos reply_count 정확 ─────────────────────────────────────────

@pytest.mark.anyio
async def test_list_memos_reply_count_populated():
    """list_memos 결과에 reply_count가 실제 값으로 채워짐."""
    from unittest.mock import patch
    client, session, app = await _client()
    try:
        memo1 = _mock_memo(MEMO_ID_1)
        memo2 = _mock_memo(MEMO_ID_2)

        with patch("app.repositories.memo.MemoRepository.list", new_callable=AsyncMock) as mock_list, \
             patch("app.repositories.memo.MemoRepository.get_entity_link_counts_batch", new_callable=AsyncMock) as mock_embed, \
             patch("app.repositories.memo.MemoRepository.get_reply_counts_batch", new_callable=AsyncMock) as mock_reply:
            mock_list.return_value = [memo1, memo2]
            mock_embed.return_value = {MEMO_ID_1: 0, MEMO_ID_2: 0}
            mock_reply.return_value = {
                MEMO_ID_1: (3, REPLY_TS),
                MEMO_ID_2: (0, None),
            }

            async with client as c:
                resp = await c.get(f"/api/v2/memos?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2
        m1 = next(d for d in data if d["id"] == str(MEMO_ID_1))
        m2 = next(d for d in data if d["id"] == str(MEMO_ID_2))
        assert m1["reply_count"] == 3
        assert m1["latest_reply_at"] is not None
        assert m2["reply_count"] == 0
        assert m2["latest_reply_at"] is None
    finally:
        app.dependency_overrides.clear()


# ─── AC2: latest_reply_at 정확 ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_memos_latest_reply_at_matches():
    """latest_reply_at이 마지막 reply 시각과 일치함."""
    from unittest.mock import patch
    client, session, app = await _client()
    try:
        memo = _mock_memo(MEMO_ID_1)

        with patch("app.repositories.memo.MemoRepository.list", new_callable=AsyncMock) as mock_list, \
             patch("app.repositories.memo.MemoRepository.get_entity_link_counts_batch", new_callable=AsyncMock) as mock_embed, \
             patch("app.repositories.memo.MemoRepository.get_reply_counts_batch", new_callable=AsyncMock) as mock_reply:
            mock_list.return_value = [memo]
            mock_embed.return_value = {}
            mock_reply.return_value = {MEMO_ID_1: (2, REPLY_TS)}

            async with client as c:
                resp = await c.get("/api/v2/memos")

        assert resp.status_code == 200
        result = resp.json()[0]
        assert result["reply_count"] == 2
        assert "2026-05-11" in result["latest_reply_at"]
    finally:
        app.dependency_overrides.clear()


# ─── AC3: batch aggregate — get_reply_counts_batch 단위 테스트 ─────────────────

@pytest.mark.anyio
async def test_get_reply_counts_batch_empty():
    """빈 리스트 입력 시 빈 dict 반환 (쿼리 없음)."""
    from app.repositories.memo import MemoRepository
    session = AsyncMock()
    repo = MemoRepository(session, ORG_ID)
    result = await repo.get_reply_counts_batch([])
    assert result == {}
    session.execute.assert_not_called()


@pytest.mark.anyio
async def test_get_reply_counts_batch_single_query():
    """단일 쿼리로 여러 memo의 reply count 집계 (N+1 아님)."""
    from app.repositories.memo import MemoRepository
    session = AsyncMock()

    row1 = MagicMock()
    row1.memo_id = MEMO_ID_1
    row1.cnt = 5
    row1.latest = REPLY_TS

    row2 = MagicMock()
    row2.memo_id = MEMO_ID_2
    row2.cnt = 1
    row2.latest = REPLY_TS

    mock_result = MagicMock()
    mock_result.__iter__ = MagicMock(return_value=iter([row1, row2]))
    session.execute = AsyncMock(return_value=mock_result)

    repo = MemoRepository(session, ORG_ID)
    result = await repo.get_reply_counts_batch([MEMO_ID_1, MEMO_ID_2])

    assert result[MEMO_ID_1] == (5, REPLY_TS)
    assert result[MEMO_ID_2] == (1, REPLY_TS)
    session.execute.assert_called_once()
